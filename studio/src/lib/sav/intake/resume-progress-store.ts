import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savIntakeJournal, savIntakeRuns } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { intakeResumeNextProbeAt, intakeResumeProofKey, parseIntakeResumeProof, probeIntakeResume, type IntakeResumeDecision, type IntakeResumeProbe, type IntakeResumeProof } from "./resume-progress";
import type { IntakeRuntimePayload } from "./runtime-contract";

type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
const MARKER = "sav_intake_resume_hold";
const hold = (runId: string) => and(eq(auditLogs.entityType, MARKER), eq(auditLogs.entityId, runId), eq(auditLogs.action, MARKER));

/** Read only, no lock: the proof of the run, when it is current and waiting. Nothing here claims or refunds anything. */
export async function readIntakeResumeProof(runId: string): Promise<IntakeResumeProof | null> {
  const [row] = await requireDb().select({ state: savIntakeRuns.state, isCurrent: savIntakeRuns.isCurrent, payloadCiphertext: savIntakeRuns.payloadCiphertext })
    .from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
  if (!row?.isCurrent || row.state !== "waiting") return null;
  try { return parseIntakeResumeProof(decryptSavPayload<IntakeRuntimePayload>(row.payloadCiphertext).resumeProof); } catch { return null; }
}

/**
 * Bounded CRM re-read of what the proof names, before any claim: GET and search only (the readers allow nothing else),
 * 15 seconds, the readers' own request bound, and never a model call. Failure to read is « unavailable », not progress.
 */
export async function probeIntakeResumeForRun(proof: IntakeResumeProof, deps: { env: () => Record<string, string | undefined>; network: typeof fetch }): Promise<IntakeResumeProbe> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const readers = createSavIntakeHubspotReaders({ network: async (url, init) => deps.network(url, { ...init, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]), redirect: "error",
      headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${deps.env().HUBSPOT_ACCESS_TOKEN}` } }) });
    return await probeIntakeResume(proof, readers, controller.signal);
  } catch { return { state: "unavailable", checked: 0 }; }
  finally { clearTimeout(timer); }
}

/**
 * Inside the claim transaction, with the run row already locked: leaves the run exactly as it was (no attempt taken, no
 * lease, no model call) and records why. One marker per run holds the next look (plain columns the scheduler can filter
 * on); the journal gets a row only when the stuck state or its cause changes, so a held run never floods it.
 */
export async function holdIntakeResume(tx: Tx, runId: string, proof: IntakeResumeProof, cause: Extract<IntakeResumeDecision, { kind: "hold" }>["cause"], now: Date) {
  const key = intakeResumeProofKey(proof);
  const [prior] = await tx.select().from(auditLogs).where(hold(runId)).for("update");
  const before = prior?.technicalMetadata as { proofKey?: unknown; holds?: unknown; cause?: unknown } | undefined;
  const same = before?.proofKey === key, holds = (same && typeof before?.holds === "number" ? before.holds : 0) + 1;
  const technicalMetadata = { state: "held", proofKey: key, cause, holds, lastProbeAt: now.toISOString(), nextProbeAt: intakeResumeNextProbeAt(holds, now), configHash: proof.configHash };
  if (prior) await tx.update(auditLogs).set({ technicalMetadata }).where(eq(auditLogs.id, prior.id));
  else await tx.insert(auditLogs).values({ actorEmail: "system", action: MARKER, entityType: MARKER, entityId: runId, technicalMetadata });
  if (!same || before?.cause !== cause) await tx.insert(savIntakeJournal).values({ runId, kind: "resume_held", payloadCiphertext: encryptSavPayload({ cause, attemptsUnchanged: true, modelCallsUnchanged: true,
    incomplete: proof.incomplete, reads: proof.reads.length, notComplete: proof.reads.filter(r => r.status !== "complete").map(r => r.method) }) });
}
/** The run is resumed because the CRM moved: the journal says what moved (a method name, never content). */
export async function recordIntakeResumeProgress(tx: Tx, runId: string, probe: Extract<IntakeResumeProbe, { state: "progress" }>) {
  await tx.insert(savIntakeJournal).values({ runId, kind: "resume_progress", payloadCiphertext: encryptSavPayload({ method: probe.method, change: probe.change, checked: probe.checked }) });
  await tx.update(auditLogs).set({ technicalMetadata: sql`jsonb_set(${auditLogs.technicalMetadata}, '{state}', '"released"')` }).where(hold(runId));
}

/** The scheduler leaves a held run alone until its next look; the operator's resume ignores this on purpose. */
export const noResumeHoldSql = (runId: ReturnType<typeof sql>, now: Date) =>
  sql`not exists(select 1 from public.audit_logs h where h.entity_type='sav_intake_resume_hold' and h.action='sav_intake_resume_hold' and h.entity_id=${runId}::text
    and h.technical_metadata->>'state'='held' and h.technical_metadata->>'nextProbeAt'>${now.toISOString()})`;
