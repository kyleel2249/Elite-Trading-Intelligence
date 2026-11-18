/**
 * Bitget WebSocket transport matrix and SBE decoder.
 * Keep protocol selection explicit: UTA V3, Classic V2, demo UTA V3 and SBE are not wire-compatible.
 */
export type BitgetWsEnvironment = "production" | "demo";
export type BitgetWsAccount = "uta" | "classic";
export type BitgetWsTransport = "v3-json" | "v3-sbe" | "v2-json";

export const BITGET_WS_ENDPOINTS = {
  production: {
    uta: { public: "wss://ws.bitget.com/v3/ws/public", private: "wss://ws.bitget.com/v3/ws/private", sbe: "wss://ws.bitget.com/v3/ws/public/sbe" },
    classic: { public: "wss://ws.bitget.com/v2/ws/public", private: "wss://ws.bitget.com/v2/ws/private" }
  },
  demo: {
    uta: { public: "wss://wspap.bitget.com/v3/ws/public", private: "wss://wspap.bitget.com/v3/ws/private", sbe: "wss://wspap.bitget.com/v3/ws/public/sbe" },
    classic: { public: "wss://ws.bitget.com/v2/ws/public", private: "wss://ws.bitget.com/v2/ws/private" }
  }
} as const;

export function bitgetWsEndpoint(environment: BitgetWsEnvironment, account: BitgetWsAccount, channel: "public" | "private", sbe = false) {
  if (sbe && (account !== "uta" || channel !== "public")) throw new Error("sbe_public_uta_only");
  const endpoints = BITGET_WS_ENDPOINTS[environment][account] as any;
  return sbe ? endpoints.sbe : endpoints[channel];
}

export function bitgetUtaPublicArgs(instType: string, symbol: string, interval = "1m") {
  const args: Record<string, string>[] = [
    { instType, topic: "ticker", symbol },
    { instType, topic: "books5", symbol },
    { instType, topic: "publicTrade", symbol }
  ];
  if (interval) args.push({ instType, topic: "kline", symbol, interval });
  return args;
}

const V2_CANDLES: Record<string, string> = { "1m":"candle1m", "3m":"candle3m", "5m":"candle5m", "15m":"candle15m", "30m":"candle30m", "1H":"candle1H", "4H":"candle4H", "6H":"candle6H", "12H":"candle12H", "1D":"candle1D", "1W":"candle1W" };
export function bitgetClassicPublicArgs(instType: string, symbol: string, interval = "1m") {
  const args: Record<string, string>[] = [
    { instType, channel: "ticker", instId: symbol },
    { instType, channel: "books5", instId: symbol },
    { instType, channel: "trade", instId: symbol }
  ];
  const candle = V2_CANDLES[interval] || V2_CANDLES[interval.toUpperCase()];
  if (candle) args.push({ instType, channel: candle, instId: symbol });
  return args;
}

export function bitgetClassicPrivateSubscriptions() {
  return [
    { instType: "SPOT", channel: "account", coin: "default" },
    { instType: "SPOT", channel: "orders", instId: "default" },
    { instType: "USDT-FUTURES", channel: "orders", instId: "default" },
    { instType: "USDT-FUTURES", channel: "positions", instId: "default" },
    { instType: "USDC-FUTURES", channel: "orders", instId: "default" },
    { instType: "USDC-FUTURES", channel: "positions", instId: "default" },
    { instType: "COIN-FUTURES", channel: "orders", instId: "default" },
    { instType: "COIN-FUTURES", channel: "positions", instId: "default" }
  ];
}

export type SbeHeader = { blockLength: number; templateId: number; schemaId: number; version: number };
export function decodeBitgetSbe(input: ArrayBuffer | Uint8Array) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 8) throw new Error("sbe_frame_too_short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: SbeHeader = { blockLength: view.getUint16(0, true), templateId: view.getUint16(2, true), schemaId: view.getUint16(4, true), version: view.getUint16(6, true) };
  if (header.schemaId !== 1) throw new Error("unsupported_sbe_schema");
  const u64 = (o: number) => Number(view.getBigUint64(o, true));
  const i64 = (o: number) => Number(view.getBigInt64(o, true));
  const i8 = (o: number) => view.getInt8(o);
  const scale = (n: number, e: number) => n * Math.pow(10, e);
  const str = (o: number) => { const len = view.getUint8(o); if (o + 1 + len > bytes.length) throw new Error("sbe_truncated_string"); return new TextDecoder().decode(bytes.subarray(o + 1, o + 1 + len)); };
  const result: any = { header };
  if (header.templateId === 1002) {
    if (header.blockLength < 56 || bytes.length < 8 + header.blockLength + 1) throw new Error("sbe_bbo_truncated");
    const o = 8, pe = i8(o + 40), se = i8(o + 41);
    result.type = "books1"; result.ts = u64(o); result.bids = [[scale(i64(o + 8), pe), scale(i64(o + 16), se)]];
    result.asks = [[scale(i64(o + 24), pe), scale(i64(o + 32), se)]];
    // Canonical offsets from the 56-byte BBO root: ts, bid px/size, ask px/size, exponents, seq, sts, category, padding.
    result.bids = [[scale(i64(o + 8), pe), scale(i64(o + 16), se)]];
    result.asks = [[scale(i64(o + 24), pe), scale(i64(o + 32), se)]];
    result.priceExponent = pe; result.sizeExponent = se; result.seq = u64(o + 42); result.sts = null;
    result.symbol = str(8 + header.blockLength);
    return result;
  }
  if (header.templateId === 1001) {
    const o = 8;
    if (header.blockLength < 24) throw new Error("sbe_depth_root_invalid");
    result.type = "books50"; result.ts = u64(o); result.seq = u64(o + 8); result.priceExponent = i8(o + 16); result.sizeExponent = i8(o + 17);
    let cursor = o + header.blockLength;
    const group = () => {
      if (cursor + 4 > bytes.length) throw new Error("sbe_depth_group_truncated");
      const entryLength = view.getUint16(cursor, true), count = view.getUint16(cursor + 2, true); cursor += 4;
      if (entryLength < 16 || cursor + entryLength * count > bytes.length) throw new Error("sbe_depth_entries_truncated");
      const rows: number[][] = [];
      for (let i = 0; i < count; i++) { const p = i64(cursor), q = i64(cursor + 8); rows.push([scale(p, result.priceExponent), scale(q, result.sizeExponent)]); cursor += entryLength; }
      return rows;
    };
    result.asks = group(); result.bids = group(); result.symbol = str(cursor);
    if (header.version >= 5 && header.blockLength >= 40) { result.sts = u64(o + 18); result.category = view.getUint8(o + 26); result.pseq = u64(o + 27); result.depthAction = view.getUint8(o + 35); }
    return result;
  }
  if (header.templateId === 1003) {
    const o = 8;
    if (header.blockLength < 8) throw new Error("sbe_trade_root_invalid");
    result.type = "publicTrade"; result.priceExponent = i8(o); result.sizeExponent = i8(o + 1);
    const modern = header.blockLength >= 16;
    let cursor = o + header.blockLength;
    if (cursor + 4 > bytes.length) throw new Error("sbe_trade_group_truncated");
    const entryLength = view.getUint16(cursor, true), count = view.getUint16(cursor + 2, true); cursor += 4;
    if (entryLength < 33 || cursor + entryLength * count > bytes.length) throw new Error("sbe_trade_entries_truncated");
    result.trades = [];
    for (let i = 0; i < count; i++) {
      const at = cursor, ts = u64(at), execId = u64(at + 8), price = scale(i64(at + 16), result.priceExponent), size = scale(i64(at + 24), result.sizeExponent), side = view.getUint8(at + 32);
      result.trades.push({ ts, execId: String(execId), price, size, side: side === 0 ? "buy" : "sell", isRPI: entryLength > 33 ? view.getUint8(at + 33) === 1 : false });
      cursor += entryLength;
    }
    if (modern) { result.sts = u64(o + 2); result.category = view.getUint8(o + 10); }
    result.symbol = str(cursor);
    return result;
  }
  throw new Error("unsupported_sbe_template_" + header.templateId);
}

export function bitgetPrivateCredentialSet(env: Record<string, any>, environment: BitgetWsEnvironment, account: BitgetWsAccount) {
  const prefix = environment === "demo" ? "BITGET_DEMO_" : "BITGET_";
  const suffix = account === "classic" ? "CLASSIC_" : "";
  const key = env[prefix + suffix + "API_KEY"] || env[prefix + suffix + "KEY"];
  const secret = env[prefix + suffix + "API_SECRET"] || env[prefix + suffix + "SECRET"];
  const passphrase = env[prefix + suffix + "API_PASSPHRASE"] || env[prefix + suffix + "PASSPHRASE"];
  return { key: typeof key === "string" ? key.trim() : "", secret: typeof secret === "string" ? secret.trim() : "", passphrase: typeof passphrase === "string" ? passphrase.trim() : "" };
}
