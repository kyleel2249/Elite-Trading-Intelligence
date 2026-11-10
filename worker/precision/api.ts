// HTTP surface of the ETI PRECISION SIGNAL ENGINE.
//   GET  /api/precision/signal?symbol=BTCUSDT&strategy=intraday[&provider=binance]   read-only signal
//   GET  /api/precision/markets                                                      supported markets and strategies
//   GET  /api/precision/config                                                       effective scoring configuration and fingerprint
//   GET  /api/precision/calibration?strategy=intraday                                calibration status and why a model is (not) usable
//   PUT  /api/precision/admin/{fundamentals|news|expectancy|calibration}/...         token-protected data entry
//   POST /api/precision/admin/calibration/fit?strategy=intraday                      fit + validate a calibration model from outcomes
// Analytical only. Nothing here can place an order.
import { getMarketData, providerOrder, type Depth, type Kline } from "../market.ts";
import { DEFAULT_WEIGHTS, EXECUTION_TF, TIMEFRAMES, type Strategy, type Timeframe } from "../algo/timeframes.ts";
import { assessCalibration, fitCalibration, parseCalibrationModel, type CalibrationSample } from "./calibration.ts";
import { DEFAULT_CONFIG, ENGINE_NAME, ENGINE_VERSION, resolveConfig, scoreConfigHash } from "./config.ts";
import { mergeNews, parseFundamentalContext, parseNewsContext } from "./context.ts";
import { SUPPORTED_MARKETS, parseInstrument, runPrecisionEngine } from "./engine.ts";
import { SYMBOL_RE, keys, loadContext, parseExpectancy, tokenMatches, type PrecisionEnv } from "./stores.ts";
import { isFiniteNumber, isRecord } from "./util.ts";

export const STRATEGIES: Strategy[] = ["scalp", "intraday", "swing", "position"];
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const MAX_BODY = 512 * 1024;

const isStrategy = (s: string | null): s is Strategy => !!s && (STRATEGIES as string[]).includes(s);

async function readBody(req: Request): Promise<unknown | { __error: string }> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return { __error: "body_too_large" };
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return { __error: "body_too_large" };
    return JSON.parse(text);
  } catch { return { __error: "invalid_json" }; }
}
const bodyError = (b: unknown): string | null => (isRecord(b) && typeof b.__error === "string" ? b.__error : null);

export async function handlePrecision(req: Request, env: PrecisionEnv): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type" } });

  if (path.startsWith("/api/precision/admin/")) return handleAdmin(req, env, path, url);
  if (req.method !== "GET") return reply({ error: "method_not_allowed", note: "This endpoint is analytical and read-only; it cannot place orders." }, 405, { allow: "GET, OPTIONS" });

  const resolved = resolveConfig(env.ETI_PRECISION_CONFIG);
  const cfg = resolved.config;

  if (path === "/api/precision/markets") return reply({ engine: ENGINE_NAME, version: ENGINE_VERSION, markets: SUPPORTED_MARKETS, strategies: STRATEGIES, setupTimeframes: EXECUTION_TF, notUsedAsMarkets: "This engine evaluates crypto spot only. Optional US-equity and forex price sources exist for the Readiness engine (worker/readiness/sources.ts) but are not yet wired into the Precision engine, so other markets are rejected rather than approximated." });
  if (path === "/api/precision/config") return reply({ engine: ENGINE_NAME, version: ENGINE_VERSION, status: resolved.status, errors: resolved.errors, configHash: scoreConfigHash(cfg), config: cfg, defaultsHash: scoreConfigHash(DEFAULT_CONFIG) });

  if (path === "/api/precision/calibration") {
    const strategy = url.searchParams.get("strategy") || "intraday";
    if (!isStrategy(strategy)) return reply({ error: "invalid_strategy", strategies: STRATEGIES }, 400);
    const ctx = await loadContext(env, null, strategy, Date.now(), cfg.context.expectancyMaxAgeDays);
    const a = assessCalibration(ctx.calibration, { strategy, hash: scoreConfigHash(cfg), now: Date.now(), cfg: cfg.calibration });
    return reply({ strategy, storeConfigured: ctx.storeConfigured, modelPresent: !!ctx.calibration, usable: a.valid, reasons: a.reasons, metrics: ctx.calibration?.metrics ?? null, samples: ctx.calibration ? { total: ctx.calibration.samples, train: ctx.calibration.trainSamples, test: ctx.calibration.testSamples } : null, trainedAt: ctx.calibration?.trainedAt ?? null,
      confidenceReported: a.valid ? "calibrated_probability" : "qualitative", requirements: cfg.calibration });
  }

  if (path !== "/api/precision/signal") return reply({ error: "not_found" }, 404);

  const symbol = (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase();
  const strategy = url.searchParams.get("strategy") || "intraday";
  if (!SYMBOL_RE.test(symbol) || !isStrategy(strategy)) return reply({ error: "invalid_symbol_or_strategy", strategies: STRATEGIES }, 400);
  const inst = parseInstrument(symbol);
  if (!inst) return reply({ error: "unsupported_market", symbol, detail: "Only crypto spot pairs with a recognised quote currency are supported.", markets: SUPPORTED_MARKETS }, 422);

  const order = providerOrder(env, url.searchParams.get("provider"));
  const need = TIMEFRAMES.filter(t => DEFAULT_WEIGHTS[strategy][t] > 0 || t === EXECUTION_TF[strategy]);
  const candles: Partial<Record<Timeframe, Kline[]>> = {};
  const failures: Record<string, string> = {};
  let provider = "unknown";
  const fetchedAt = Date.now();
  const ctxPromise = loadContext(env, inst.base, strategy, fetchedAt, cfg.context.expectancyMaxAgeDays);
  await Promise.all(need.map(async tf => {
    try { const r = await getMarketData("klines", { symbol, interval: tf, limit: 300 }, order); candles[tf] = r.data as Kline[]; if (tf === EXECUTION_TF[strategy]) provider = r.provider; }
    catch (e) { failures[tf] = e instanceof Error ? e.message : "unknown"; }
  }));
  if (!candles[EXECUTION_TF[strategy]]) return reply({ decision: "DATA_UNRELIABLE", direction: "NO TRADE", error: "market_data_unavailable", executionTimeframe: EXECUTION_TF[strategy], failures, liveExecutionAllowed: false }, 503);
  let depth: { bids: [number, number][]; asks: [number, number][]; timestamp: number } | null = null;
  try { const d = (await getMarketData("depth", { symbol, interval: "1m", limit: 100 }, order)).data as Depth; depth = { bids: d.bids, asks: d.asks, timestamp: Date.now() }; }
  catch (e) { failures.depth = e instanceof Error ? e.message : "unknown"; }

  const ctx = await ctxPromise;
  const now = Date.now();
  const signal = runPrecisionEngine({
    symbol, strategy, candles, depth, now, fetchedAt, provider, config: cfg, configStatus: resolved.status,
    fundamentals: ctx.fundamentals, news: mergeNews(ctx.news, ctx.marketNews), expectancy: ctx.expectancy, calibration: ctx.calibration,
  });
  const notes = [...(ctx.expectancyNote ? [ctx.expectancyNote] : []), ...(resolved.status === "override_rejected" ? [`ETI_PRECISION_CONFIG was rejected and defaults are in use: ${resolved.errors.join("; ")}`] : []),
    ...(!ctx.storeConfigured ? ["No context store (ETI_PRECISION_DATA) is bound: fundamentals, news, expectancy and calibration are unavailable, so the score is capped and confidence is qualitative."] : [])];
  signal.dataQuality.notes.push(...notes);
  return reply({ ...signal, dataQuality: { ...signal.dataQuality, failures } });
}

// ------------------------------------------------------------------ admin
async function handleAdmin(req: Request, env: PrecisionEnv, path: string, url: URL): Promise<Response> {
  if (!env.ETI_PRECISION_ADMIN_TOKEN) return reply({ error: "admin_disabled", detail: "Set the ETI_PRECISION_ADMIN_TOKEN Worker secret (at least 16 characters) to enable data entry." }, 403);
  const auth = req.headers.get("authorization") || "";
  if (!tokenMatches(auth.startsWith("Bearer ") ? auth.slice(7) : null, env.ETI_PRECISION_ADMIN_TOKEN)) return reply({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  const kv = env.ETI_PRECISION_DATA;
  if (!kv) return reply({ error: "store_not_configured", detail: "Bind a KV namespace as ETI_PRECISION_DATA." }, 503);

  const parts = path.slice("/api/precision/admin/".length).split("/");
  const kind = parts[0], arg = parts[1];
  const cfg = resolveConfig(env.ETI_PRECISION_CONFIG).config;
  const put = async (key: string, value: unknown, ttl?: number) => { await kv.put(key, JSON.stringify(value), ttl ? { expirationTtl: ttl } : undefined); };

  if (kind === "calibration" && arg === "fit") {
    if (req.method !== "POST") return reply({ error: "method_not_allowed", allow: "POST" }, 405);
    const strategy = url.searchParams.get("strategy");
    if (!isStrategy(strategy)) return reply({ error: "invalid_strategy", strategies: STRATEGIES }, 400);
    const body = await readBody(req);
    if (bodyError(body)) return reply({ error: bodyError(body) }, 400);
    const raw = isRecord(body) && Array.isArray(body.samples) ? body.samples : null;
    if (!raw || raw.length > 50_000) return reply({ error: "invalid_samples", detail: "Provide { samples: [{ score, win, time? }] } with at most 50000 entries." }, 400);
    const samples: CalibrationSample[] = [];
    for (const s of raw) if (isRecord(s) && isFiniteNumber(s.score) && typeof s.win === "boolean") samples.push({ score: s.score, win: s.win, time: isFiniteNumber(s.time) ? s.time : undefined });
    const outcome = isRecord(body) && typeof body.outcomeDefinition === "string" ? body.outcomeDefinition.slice(0, 200) : undefined;
    const hash = scoreConfigHash(cfg), now = Date.now();
    const fit = fitCalibration(samples, { strategy, scoreConfigHash: hash, outcomeDefinition: outcome, now, minBlockSamples: cfg.calibration.minBlockSamples });
    if (!fit.model) return reply({ stored: false, usable: false, reasons: fit.reasons }, 422);
    const a = assessCalibration(fit.model, { strategy, hash, now, cfg: cfg.calibration });
    // A model that fails validation is still stored so its metrics are inspectable, but the engine will not use it (it re-checks on every read).
    await put(keys.calibration(strategy), fit.model);
    return reply({ stored: true, usable: a.valid, reasons: [...fit.reasons, ...a.reasons], metrics: fit.model.metrics, samples: { total: fit.model.samples, train: fit.model.trainSamples, test: fit.model.testSamples }, blocks: fit.model.blocks.length });
  }

  if (req.method !== "PUT") return reply({ error: "method_not_allowed", allow: "PUT" }, 405);
  const body = await readBody(req);
  if (bodyError(body)) return reply({ error: bodyError(body) }, 400);

  if (kind === "fundamentals" && arg && /^[A-Z0-9]{2,15}$/.test(arg.toUpperCase())) {
    const v = parseFundamentalContext(body);
    if (!v) return reply({ error: "invalid_fundamentals", detail: "Expected { asOf (ISO time), source, factors: [{ name, bias -1..1, weight?, note? }] }" }, 400);
    await put(keys.fundamentals(arg.toUpperCase()), v);
    return reply({ stored: true, asset: arg.toUpperCase(), factors: v.factors.length, asOf: v.asOf });
  }
  if (kind === "news" && arg && (arg === "_market" || /^[A-Z0-9]{2,15}$/.test(arg.toUpperCase()))) {
    const v = parseNewsContext(body);
    if (!v) return reply({ error: "invalid_news", detail: "Expected { asOf (ISO time), source, events: [{ title, time, impact: low|medium|high, sentiment?, scheduled?, source?, url? }] }" }, 400);
    await put(arg === "_market" ? keys.marketNews() : keys.news(arg.toUpperCase()), v);
    return reply({ stored: true, scope: arg === "_market" ? "market-wide" : arg.toUpperCase(), events: v.events.length, asOf: v.asOf });
  }
  if (kind === "expectancy" && isStrategy(arg ?? null)) {
    const v = parseExpectancy(body, arg as Strategy);
    if (!v) return reply({ error: "invalid_expectancy", detail: "Expected { expectancyR (-10..10), samples (integer), asOf (ISO time), source }" }, 400);
    await put(keys.expectancy(arg as Strategy), v);
    return reply({ stored: true, strategy: arg, samples: v.samples, usedOnlyAbove: cfg.minExpectancySamples });
  }
  if (kind === "calibration" && isStrategy(arg ?? null)) {
    const m = parseCalibrationModel(body);
    if (!m || m.strategy !== arg) return reply({ error: "invalid_calibration_model" }, 400);
    const a = assessCalibration(m, { strategy: arg as Strategy, hash: scoreConfigHash(cfg), now: Date.now(), cfg: cfg.calibration });
    await put(keys.calibration(arg as Strategy), m);
    return reply({ stored: true, usable: a.valid, reasons: a.reasons });
  }
  return reply({ error: "not_found" }, 404);
}
