import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { savDerivedCostQuote } from "../derived-budget";
import type { SavGeminiMetadata } from "../gemini-response";
import { intakeRuntimeHash } from "./runtime-contract";

/** Comparison of the single-call reader beside the active path: OFF unless explicitly
 * configured, with its OWN money and mail caps and its OWN append-only ledger. It never
 * reads or consumes the live ledger, attempts, call policy or execution capacity. */
const shadowSchema = z.object({ maxMails: z.number().int().min(1).max(500), maxNanoUsd: z.number().int().min(1).max(50_000_000_000), until: z.iso.datetime() }).strict();
export type SavIntakeShadowConfig = z.infer<typeof shadowSchema>;
export function savIntakeShadowConfig(env: Record<string, string | undefined>, now = new Date()): SavIntakeShadowConfig | null {
  if (!env.SAV_INTAKE_SHADOW_JSON) return null;
  try {
    const config = shadowSchema.parse(JSON.parse(env.SAV_INTAKE_SHADOW_JSON));
    return Date.parse(config.until) > now.getTime() ? config : null;
  } catch { console.warn("sav_intake_shadow", { error: "SAV_INTAKE_SHADOW_CONFIGURATION_INVALID" }); return null; }
}

const ACTION = "sav_intake_shadow_call", ENTITY = "sav_intake_shadow";
type Event = { callId: string; event: "reserved" | "settled"; messageKey?: string; requestHash?: string; reservedNanoUsd?: number; chargedNanoUsd?: number; state?: "settled" | "uncertain" };
async function events(tx: Pick<ReturnType<typeof requireDb>, "select">) {
  const rows = await tx.select({ metadata: auditLogs.technicalMetadata }).from(auditLogs).where(and(eq(auditLogs.action, ACTION), eq(auditLogs.entityType, ENTITY)));
  return rows.map(r => r.metadata as unknown as Event);
}
/** Spend and mails of the comparison: a call costs its reservation until settled (uncertain keeps it). */
export async function readSavIntakeShadowUsage(tx: Pick<ReturnType<typeof requireDb>, "select"> = requireDb()) {
  const all = await events(tx), calls = new Map<string, { reserved: number; charged?: number; messageKey: string }>();
  for (const e of all) {
    if (e.event === "reserved") calls.set(e.callId, { reserved: e.reservedNanoUsd ?? 0, messageKey: e.messageKey ?? "" });
    else { const call = calls.get(e.callId); if (call && e.state === "settled") call.charged = e.chargedNanoUsd ?? call.reserved; }
  }
  const spent = [...calls.values()].reduce((sum, c) => sum + (c.charged ?? c.reserved), 0);
  return { spentNanoUsd: spent, mails: new Set([...calls.values()].map(c => c.messageKey)).size, calls: calls.size, keys: new Set([...calls.values()].map(c => c.messageKey)) };
}
/** Reserve one comparison dispatch within the comparison's own caps (advisory-locked). */
export async function reserveSavIntakeShadowCall(messageId: string, requestHash: string, config: SavIntakeShadowConfig, model: string) {
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-intake-shadow-budget-v1'))`);
    const usage = await readSavIntakeShadowUsage(tx), messageKey = intakeRuntimeHash(`shadow:${messageId}`);
    const price = savDerivedCostQuote(model, 8192);
    if (usage.spentNanoUsd + price.reservedNanoUsd > config.maxNanoUsd || !usage.keys.has(messageKey) && usage.mails >= config.maxMails)
      throw Error("SAV_INTAKE_SHADOW_BUDGET_EXHAUSTED");
    const callId = randomUUID();
    await tx.insert(auditLogs).values({ actorEmail: "system", action: ACTION, entityType: ENTITY, entityId: callId,
      technicalMetadata: { callId, event: "reserved", messageKey, requestHash, reservedNanoUsd: price.reservedNanoUsd } });
    return { id: callId, cached: null };
  });
}
/** Same settlement rule as the live ledger: verified counters, or a received 429/5xx at zero; otherwise uncertain. */
export async function settleSavIntakeShadowCall(callId: string, metadata?: SavGeminiMetadata, result?: unknown, unbilledProviderStatus?: number) {
  void result;
  const { inputTokens: i, outputTokens: o, thoughtTokens: t, totalTokens: total } = metadata ?? {};
  const valid = [i, o, t, total].every(n => Number.isSafeInteger(n) && Number(n) >= 0) && Number(i) >= 1 && Number(i) <= 1_048_576
    && Number(o) + Number(t) <= 8192 && Number(i) + Number(o) + Number(t) === total;
  const unbilled = !valid && unbilledProviderStatus !== undefined && (unbilledProviderStatus === 429 || unbilledProviderStatus >= 500 && unbilledProviderStatus <= 599);
  const charged = valid ? Number(i) * 750 + (Number(o) + Number(t)) * 3750 : 0;
  await requireDb().insert(auditLogs).values({ actorEmail: "system", action: ACTION, entityType: ENTITY, entityId: callId,
    technicalMetadata: { callId, event: "settled", state: valid || unbilled ? "settled" : "uncertain", chargedNanoUsd: charged } });
  return valid || unbilled;
}
