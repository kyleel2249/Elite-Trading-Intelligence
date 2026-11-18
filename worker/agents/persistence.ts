/** Durable, append-only D1 persistence for complete multi-agent decision snapshots. */
export interface AgentDecisionSnapshot {
  schema: "eti.analysis/1"; id: string; symbol: string; interval: string; generatedAt: string;
  decision: { action: "BUY" | "SELL" | "NO_TRADE"; confidence: number };
  dataQuality: Record<string, unknown>;
}
export interface AgentAuditDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all(): Promise<{ results?: Record<string, unknown>[] }>;
    };
  };
}
export interface PersistResult { status: "stored" | "duplicate"; id: string }
function safeConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
/** INSERT OR IGNORE makes retries idempotent. Existing decision IDs have no update path. */
export async function persistAgentDecision(db: AgentAuditDb, snapshot: AgentDecisionSnapshot, executed = false): Promise<PersistResult> {
  const createdAt = Date.parse(snapshot.generatedAt);
  if (!snapshot.id || snapshot.id.length > 128 || !Number.isFinite(createdAt)) throw new Error("invalid_decision_identity");
  if (!/^[A-Z0-9]{5,20}$/.test(snapshot.symbol) || !snapshot.interval) throw new Error("invalid_decision_market");
  if (!["BUY", "SELL", "NO_TRADE"].includes(snapshot.decision?.action)) throw new Error("invalid_decision_action");
  const payload = JSON.stringify({ ...snapshot, audit: { executed: executed === true, persistedAt: new Date().toISOString() } });
  if (payload.length > 750_000) throw new Error("decision_snapshot_too_large");
  const result = await db.prepare("INSERT OR IGNORE INTO eti_agent_decisions (id, created_at, symbol, interval, provider, action, confidence, executed, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(snapshot.id, createdAt, snapshot.symbol, snapshot.interval, typeof snapshot.dataQuality?.provider === "string" ? snapshot.dataQuality.provider.slice(0, 80) : "unknown", snapshot.decision.action, safeConfidence(snapshot.decision.confidence), executed ? 1 : 0, payload).run();
  return { status: (result.meta?.changes ?? 0) > 0 ? "stored" : "duplicate", id: snapshot.id };
}
export async function listAgentDecisions(db: AgentAuditDb, options: { limit?: number; before?: number; symbol?: string } = {}): Promise<{ records: AgentDecisionSnapshot[]; nextBefore: number | null }> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  const before = Number.isFinite(options.before) ? Number(options.before) : null;
  const symbol = options.symbol && /^[A-Z0-9]{5,20}$/.test(options.symbol) ? options.symbol : null;
  const where = [before === null ? null : "created_at < ?", symbol ? "symbol = ?" : null].filter(Boolean).join(" AND ") || "1=1";
  const values = [before, symbol].filter((x) => x !== null);
  const result = await db.prepare(`SELECT payload_json, created_at FROM eti_agent_decisions WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...values, limit + 1).all();
  const rows = result.results ?? [], page = rows.slice(0, limit);
  const records = page.flatMap((row) => {
    if (typeof row.payload_json !== "string") return [];
    try { const parsed = JSON.parse(row.payload_json); return parsed && parsed.schema === "eti.analysis/1" ? [parsed as AgentDecisionSnapshot] : []; }
    catch { return []; }
  });
  const last = page[page.length - 1];
  return { records, nextBefore: rows.length > limit && typeof last?.created_at === "number" ? last.created_at : null };
}
