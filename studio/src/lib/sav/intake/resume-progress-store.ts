import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savIntakeJournal } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { intakeResumeNextProbeAt, intakeResumeConfirmation, intakeResumeProbeEarly, intakeResumeProofKey, probeIntakeResume, type IntakeResumeDecision, type IntakeResumeProbe, type IntakeResumeProof } from "./resume-progress";

type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
const MARKER = "sav_intake_resume_hold";
const hold = (runId: string) => and(eq(auditLogs.entityType, MARKER), eq(auditLogs.entityId, runId), eq(auditLogs.action, MARKER));

/**
 * Bounded CRM re-read of what the proof names, before any claim: GET and search only (the readers allow nothing else),
 * 15 seconds, the readers' own request bound, and never a model call. Failure to read is « unavailable », not progress.
 */
export async function probeIntakeResumeForRun(proof: IntakeResumeProof, deps: { env: () => Record<string, string | undefined>; network: typeof fetch; check: () => Promise<void> }): Promise<IntakeResumeProbe> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    // SAV-92: the reason of the last not-complete read (a closed reader code), so a hold is tied to the fault really observed.
    let fault: string | null = null;
    const readers = createSavIntakeHubspotReaders({ onRead: trace => { if (trace.status !== "complete") fault = trace.reason; }, network: async (url, init) => {
      await deps.check(); controller.signal.throwIfAborted();
      return deps.network(url, { ...init, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]), redirect: "error",
      headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${deps.env().HUBSPOT_ACCESS_TOKEN}` } });
    } });
    const probe = await probeIntakeResume(proof, readers, controller.signal);
    return probe.state === "same" ? { ...probe, fault } : probe;
  } catch { return { state: "unavailable", checked: 0 }; }
  finally { clearTimeout(timer); }
}

/**
 * Inside the claim transaction, with the run row already locked: leaves the run exactly as it was (no attempt taken, no
 * lease, no model call) and records why. One marker per run holds the next look (plain columns the scheduler can filter
 * on); the journal gets a row only when the stuck state or its cause changes, so a held run never floods it.
 */
export async function holdIntakeResume(tx: Tx, runId: string, proof: IntakeResumeProof, cause: Extract<IntakeResumeDecision, { kind: "hold" }>["cause"], now: Date,
  probe?: IntakeResumeProbe | null) {
  const key = intakeResumeProofKey(proof);
  const [prior] = await tx.select().from(auditLogs).where(hold(runId)).for("update");
  const before = prior?.technicalMetadata as { proofKey?: unknown; holds?: unknown; cause?: unknown; state?: unknown; fault?: unknown; confirmations?: unknown; nextProbeAt?: unknown } | undefined;
  const same = before?.proofKey === key;
  // SAV-92 (stuck dossiers): only successful probes confirming the same deterministic fault count (see
  // intakeResumeConfirmation); at the bound the run is handed to the team and the scheduler stops probing it
  // (noResumeHoldSql). An early probe (operator's resume before the due time) keeps holds and nextProbeAt: clicks never
  // push the automatic look away. No attempt, no model call, nothing erased.
  const priorState = { sameProof: same, state: before?.state, fault: before?.fault, confirmations: before?.confirmations, nextProbeAt: before?.nextProbeAt };
  const early = intakeResumeProbeEarly(priorState, now);
  const previousHolds = same && typeof before?.holds === "number" ? before.holds : 0, holds = early ? previousHolds : previousHolds + 1;
  const confirmation = intakeResumeConfirmation(proof, cause, probe?.state === "same" ? probe.fault : null, priorState, now);
  const team = confirmation.team;
  const technicalMetadata = { state: team ? "team_required" : "held", proofKey: key, cause, holds, fault: confirmation.fault, confirmations: confirmation.confirmations,
    lastProbeAt: now.toISOString(), nextProbeAt: team ? null : early ? before!.nextProbeAt as string : intakeResumeNextProbeAt(holds, now), configHash: proof.configHash };
  if (prior) await tx.update(auditLogs).set({ technicalMetadata }).where(eq(auditLogs.id, prior.id));
  else await tx.insert(auditLogs).values({ actorEmail: "system", action: MARKER, entityType: MARKER, entityId: runId, technicalMetadata });
  if (team && !(same && before?.state === "team_required")) await tx.insert(savIntakeJournal).values({ runId, kind: "resume_team_required", payloadCiphertext: encryptSavPayload({
    cause, confirmations: confirmation.confirmations, attemptsUnchanged: true, modelCallsUnchanged: true, incomplete: confirmation.fault, notComplete: proof.reads.filter(r => r.status !== "complete").map(r => r.method) }) });
  if (!same || before?.cause !== cause) await tx.insert(savIntakeJournal).values({ runId, kind: "resume_held", payloadCiphertext: encryptSavPayload({ cause, attemptsUnchanged: true, modelCallsUnchanged: true,
    incomplete: proof.incomplete, reads: proof.reads.length, notComplete: proof.reads.filter(r => r.status !== "complete").map(r => r.method) }) });
}
/** The run is resumed because the CRM moved: the journal says what moved (a method name, never content). */
export async function recordIntakeResumeProgress(tx: Tx, runId: string, probe: Extract<IntakeResumeProbe, { state: "progress" }>) {
  await tx.insert(savIntakeJournal).values({ runId, kind: "resume_progress", payloadCiphertext: encryptSavPayload({ method: probe.method, change: probe.change, checked: probe.checked }) });
  await tx.update(auditLogs).set({ technicalMetadata: sql`jsonb_set(${auditLogs.technicalMetadata}, '{state}', '"released"')` }).where(hold(runId));
}

/** The scheduler leaves a held run alone until its next look, and a run handed to the team (SAV-92) for good; the
 * operator's resume ignores this on purpose. */
export const noResumeHoldSql = (runId: ReturnType<typeof sql>, now: Date) =>
  sql`not exists(select 1 from public.audit_logs h where h.entity_type='sav_intake_resume_hold' and h.action='sav_intake_resume_hold' and h.entity_id=${runId}::text
    and (h.technical_metadata->>'state'='team_required' or h.technical_metadata->>'state'='held' and h.technical_metadata->>'nextProbeAt'>${now.toISOString()}))`;
