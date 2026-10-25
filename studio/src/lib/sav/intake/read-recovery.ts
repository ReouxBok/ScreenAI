import { createHash } from "node:crypto";
import { z } from "zod";
import type { IntakeAdapters, ReadResult } from "./engine-types";
export const intakeReadRecoveryPolicySchema = z.object({ maxAttempts: z.number().int().min(1).max(3),
  delayMs: z.number().int().min(30_000).max(120_000), maxAgeMs: z.number().int().min(60_000).max(300_000) }).strict();
export const DEFAULT_INTAKE_READ_RECOVERY = Object.freeze({ maxAttempts: 3, delayMs: 30_000, maxAgeMs: 300_000 });
type Config = { configHash: string; readRecovery?: z.infer<typeof intakeReadRecoveryPolicySchema> };
export type IntakeReadRecovery = { revision: "intake-read-recovery.v1"; configHash: string; sourceHash: string;
  attempts: number; startedAt: string; retryAt: string; expiresAt: string;
  state: "scheduled" | "claimed" | "exhausted" | "invalidated" | "complete";
  operation: string; code: string;
  cache: Array<{ method: string; key: string; resultHash: string; result: ReadResult<unknown> }> };
export const intakeReadRetryable = (code: unknown) => typeof code === "string" && /^(?:HUBSPOT_HTTP_(?:429|502|503|504)|SAV_HUBSPOT_READ_(?:TIMEOUT|UNAVAILABLE))$/.test(code);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const methods = ["findContactsByEmail", "directAssociations", "getContact", "ticketsForContact", "ticketHistory"] as const;
const recoverySchema = z.object({ revision: z.literal("intake-read-recovery.v1"), configHash: z.string().regex(/^[a-f0-9]{64}$/), sourceHash: z.string().min(1).max(200),
  attempts: z.number().int().min(0).max(3), startedAt: z.iso.datetime(), retryAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  state: z.enum(["scheduled", "claimed", "exhausted", "invalidated", "complete"]), operation: z.string().max(40), code: z.string().max(100),
  cache: z.array(z.object({ method: z.enum(methods), key: z.string().regex(/^[a-f0-9]{64}$/), resultHash: z.string().regex(/^[a-f0-9]{64}$/),
    result: z.object({ status: z.literal("complete"), data: z.unknown(), observedAt: z.iso.datetime(), reconstructedAsOf: z.string().optional() }).strict() }).strict()).max(50) }).strict();
export function readRecoveryDue(raw: unknown, config: Config, now: Date, allowFuture=false): IntakeReadRecovery | null {
  const r = recoverySchema.safeParse(raw); if (!r.success) return null;
  const p = config.readRecovery ?? DEFAULT_INTAKE_READ_RECOVERY, state = r.data;
  return state.configHash === config.configHash && ["scheduled", "claimed"].includes(state.state) && state.attempts < p.maxAttempts
    && Date.parse(state.startedAt) <= now.getTime() && (allowFuture || Date.parse(state.retryAt) <= now.getTime())
    && now.getTime() < Date.parse(state.expiresAt) && Date.parse(state.expiresAt) - Date.parse(state.startedAt) <= p.maxAgeMs ? state : null;
}
export function newReadRecovery(config: Config, sourceHash: string, now = new Date()): IntakeReadRecovery {
  const p = config.readRecovery ?? DEFAULT_INTAKE_READ_RECOVERY;
  return { revision: "intake-read-recovery.v1", configHash: config.configHash, sourceHash, attempts: 0, startedAt: now.toISOString(),
    retryAt: now.toISOString(), expiresAt: new Date(now.getTime() + p.maxAgeMs).toISOString(), state: "claimed", operation: "", code: "", cache: [] };
}
/** Results keep their original observation time. A reused result never becomes
 * newly observed, and the executor still rereads authoritative CRM before writes. */
export function recoverableIntakeReads(readers: Pick<IntakeAdapters, typeof methods[number]>, state: IntakeReadRecovery,
  options: { reuse: boolean; checkpoint: () => void; now?: () => Date; pending?:Promise<unknown>[] }) {
  const now = options.now ?? (() => new Date());
  return Object.fromEntries(methods.map(method => [method, async (arg: string, signal: AbortSignal) => {
    if (signal.aborted) throw Error("SAV_INTAKE_RUNTIME_CONTEXT_CHANGED");
    const key = hash([method, arg]), cached = state.cache.find(r => r.method === method && r.key === key);
    if (options.reuse && cached && cached.resultHash === hash(cached.result) && cached.result.status === "complete"
      && Date.parse(cached.result.observedAt) <= now().getTime() && now().getTime() - Date.parse(cached.result.observedAt) < 60_000) return structuredClone(cached.result);
    const work=(readers[method] as (a: string, s: AbortSignal) => Promise<ReadResult<unknown>>)(arg, signal);options.pending?.push(work);
    const result = await work;
    if (result.status === "complete") {
      const entry = { method, key, resultHash: hash(result), result: structuredClone(result) };
      if (cached) state.cache.splice(state.cache.indexOf(cached), 1, entry); else if (state.cache.length < 50) state.cache.push(entry);
      options.checkpoint();
    }
    return result;
  }])) as Pick<IntakeAdapters, typeof methods[number]>;
}
