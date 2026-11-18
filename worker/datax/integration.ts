import { authenticate } from "../auth/session.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export function dataXCanonical(timestamp: string, nonce: string, pathname: string): string {
  return [timestamp, nonce, "GET", pathname].join("\n");
}

export async function dataXSignature(secret: string, canonical: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
}

function canViewDataX(auth: Awaited<ReturnType<typeof authenticate>>): boolean {
  return auth.master || (auth.user?.role === "admin" && auth.user.mfa && !auth.user.limited);
}

export async function handleDataX(req: Request, env: any, deps: { fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (path !== "/api/datax/summary") return reply({ error: "not_found" }, 404);
  if (req.method !== "GET") return reply({ error: "method_not_allowed", allowed: "GET" }, 405);

  const now = (deps.now ?? Date.now)();
  const auth = await authenticate(req, env, now);
  if (!canViewDataX(auth)) return reply({ error: "forbidden", message: "DataX financial intelligence requires an ETI administrator session with MFA." }, auth.user ? 403 : 401);

  const secret = String(env.DATAX_INTEGRATION_SECRET || "");
  const configured = String(env.DATAX_API_URL || "");
  if (secret.length < 32 || !configured) return reply({ error: "datax_integration_not_configured", message: "Configure DATAX_API_URL and the DATAX_INTEGRATION_SECRET Worker secret." }, 503);

  let origin: URL;
  try {
    origin = new URL(configured);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("invalid_origin");
  } catch {
    return reply({ error: "invalid_datax_api_url", message: "DATAX_API_URL must be an HTTPS origin without credentials, path, query or fragment." }, 500);
  }

  const pathname = "/api/integrations/eti/summary";
  const timestamp = String(Math.floor(now / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const signature = await dataXSignature(secret, dataXCanonical(timestamp, nonce, pathname));
  const endpoint = new URL(pathname, origin);
  try {
    const upstream = await (deps.fetchImpl ?? fetch)(endpoint.toString(), {
      method: "GET",
      headers: {
        "accept": "application/json",
        "x-datax-timestamp": timestamp,
        "x-datax-nonce": nonce,
        "x-datax-signature": signature
      },
      signal: AbortSignal.timeout(8000),
      redirect: "error"
    });
    if (!upstream.ok) {
      const status = upstream.status === 401 || upstream.status === 409 ? 502 : upstream.status === 503 ? 503 : 502;
      return reply({ error: "datax_upstream_rejected", upstreamStatus: upstream.status, message: "DataX did not provide an authenticated summary. Check its integration secret and database migration." }, status);
    }
    const data = await upstream.json() as Record<string, unknown>;
    if (data?.ok !== true || data?.source !== "DataX" || data?.integrationVersion !== 1) return reply({ error: "invalid_datax_payload" }, 502);
    return reply({ ok: true, integration: "DataX", connected: true, receivedAt: new Date(now).toISOString(), data });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return reply({ error: timeout ? "datax_upstream_timeout" : "datax_upstream_unreachable", message: "The DataX service could not be reached. ETI trading and portfolio services remain independent." }, 502);
  }
}

const DATAX_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETI · DataX Intelligence</title>
<style>
:root{color-scheme:dark;--bg:#080d16;--panel:#111b2b;--line:#24334a;--muted:#8fa3bd;--blue:#56a8ff;--green:#21d69a;--amber:#f4bf62}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#14233b,#080d16 60%);color:#eaf2ff;font:14px Inter,system-ui,sans-serif}main{max-width:1280px;margin:auto;padding:28px 4vw}header{display:flex;justify-content:space-between;gap:16px;align-items:center;border-bottom:1px solid var(--line);padding-bottom:18px}h1{font-size:24px;margin:0}p,.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:22px 0}.card{background:linear-gradient(145deg,#121e30,#0d1624);border:1px solid var(--line);border-radius:13px;padding:16px;min-width:0}.label{color:var(--muted);font-size:12px}.value{font-size:24px;font-weight:700;margin:10px 0;overflow-wrap:anywhere}.foot{font-size:11px;color:var(--muted)}button{background:#142b47;color:#eaf2ff;border:1px solid #31557c;border-radius:8px;padding:10px 14px;cursor:pointer}.status{padding:9px 12px;border:1px solid var(--line);border-radius:9px;color:var(--amber)}.good{color:var(--green)}.bad{color:#ff8295}.section{margin-top:22px}.section h2{font-size:16px}.rows{display:grid;gap:8px}.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}@media(max-width:600px){header{align-items:flex-start;flex-direction:column}}
</style></head><body><main><header><div><h1>DataX Financial Intelligence</h1><p>Read-only, authenticated aggregate view from the independent DataX platform.</p></div><button id="refresh">Refresh data</button></header>
<div id="status" class="status" role="status">Connecting to DataX…</div><section class="grid" id="metrics"><div class="card">Loading verified DataX records…</div></section>
<section class="section card"><h2>Reserve and token supply</h2><div id="reserve" class="rows">Awaiting data…</div></section>
<section class="section card"><h2>Rewards and settlement</h2><div id="settlement" class="rows">Awaiting data…</div></section>
<p class="foot">DataX figures are source-reported aggregates. A token reference value is not proof of cash backing. This page does not transfer funds or authorise trading capital. All values remain separate from ETI's trading ledger.</p></main>
<script>
const el=id=>document.getElementById(id),fmt=n=>Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2}),money=n=>'GH₵ '+(Number(n||0)/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}),row=(k,v)=>'<div class="row"><span>'+k+'</span><strong>'+v+'</strong></div>';
async function load(){el('status').textContent='Requesting signed DataX snapshot…';try{const r=await fetch('/api/datax/summary',{credentials:'same-origin',cache:'no-store'});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.message||j.error||'DataX unavailable');const d=j.data;el('status').textContent='Connected · Snapshot '+new Date(d.asOf).toLocaleString();el('status').className='status good';el('metrics').innerHTML=[
['Active accounts',fmt(d.accounts.active),'of '+fmt(d.accounts.total)+' registered'],
['Verified bandwidth',fmt(d.bandwidth.verifiedEligibleBytes)+' bytes',fmt(d.bandwidth.verifiedEvents)+' verified events'],
['Gross recorded revenue',money(d.rewards.grossRevenueMinor),fmt(d.rewards.allocations)+' reward allocations'],
['Contributor allocations',money(d.rewards.contributorAmountMinor),'Funding and issuance status tracked'],
['Verified reserve available',money(d.reserves.availableMinor),fmt(d.reserves.verifiedAccounts)+' verified reserve accounts'],
['Pending bandwidth',fmt(d.bandwidth.pendingEvents)+' events','Awaiting review']
].map(x=>'<article class="card"><div class="label">'+x[0]+'</div><div class="value">'+x[1]+'</div><div class="foot">'+x[2]+'</div></article>').join('');
const s=d.tokenSupply;el('reserve').innerHTML=row('Verified reserve accounts',fmt(d.reserves.verifiedAccounts))+row('Available reserve',money(d.reserves.availableMinor))+row('Reserved for obligations',money(d.reserves.reservedMinor))+row('Circulating DTX atoms',s?fmt(s.circulatingAtoms):'No snapshot')+row('Snapshot backing ratio',s?fmt(s.backingRatioBps/100)+'%':'Not reported');
el('settlement').innerHTML=row('Rewards awaiting funding',fmt(d.rewards.awaitingFunding))+row('Funded allocations',fmt(d.rewards.funded))+row('Issued allocations',fmt(d.rewards.issued))+row('Redemption states',d.redemptions.map(x=>x.status+': '+fmt(x.count)).join(' · ')||'None reported')+row('Payout states',d.payouts.map(x=>x.status+': '+fmt(x.count)).join(' · ')||'None reported')+row('Eligible as ETI trading capital','No — separate approval and cleared-funds reconciliation required');
}catch(e){el('status').textContent='DataX unavailable · '+e.message;el('status').className='status bad';el('metrics').innerHTML='<article class="card">No DataX figures were accepted. ETI trading and portfolio systems remain unaffected.</article>'}}
el('refresh').addEventListener('click',load);load();
</script></body></html>`;

export function withDataX(inner: { fetch(req: Request, env: any, ctx?: any): Promise<Response> | Response }) {
  return { ...inner, fetch: async (req: Request, env: any, ctx?: any) => {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (path === "/api/datax/summary") return handleDataX(req, env);
    if (path === "/datax") {
      if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
      const auth = await authenticate(req, env, Date.now());
      if (!canViewDataX(auth)) return reply({ error: "forbidden", message: "DataX financial intelligence requires an ETI administrator session with MFA." }, auth.user ? 403 : 401);
      return new Response(DATAX_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    return inner.fetch(req, env, ctx);
  }};
}
