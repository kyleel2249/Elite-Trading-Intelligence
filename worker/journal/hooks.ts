/** Live hooks: called right after an order outcome is decided. They never throw and never delay the response beyond one journal write. */
import { fromAnalysis, fromExecutionRecord, fromRejection, log } from "./record.ts";
import type { AnalysisInput } from "./record.ts";
import type { JournalEnv } from "./store.ts";

export async function journalRejection(env: JournalEnv, key: string, stored: unknown): Promise<void> { try { await log(env, fromRejection(key, stored)); } catch { /* backfill will pick it up */ } }
export async function journalExecution(env: JournalEnv, record: unknown): Promise<void> { try { if ((record as any)?.clientOrderId) await log(env, fromExecutionRecord(record)); } catch { /* backfill will pick it up */ } }
export async function journalAnalysis(env: JournalEnv, a: AnalysisInput): Promise<void> { try { await log(env, await fromAnalysis(a)); } catch { /* never blocks analysis */ } }
