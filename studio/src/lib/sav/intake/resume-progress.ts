import { createHash } from "node:crypto";
import { z } from "zod";
import type { IntakeAdapters, ReadResult } from "./engine-types";

/**
 * Proof of progress for a V1 resume (pure: no database, no network of its own).
 *
 * A run that waits because a CRM read was incomplete (pagination cycle, page or history limit, partial batch...) is
 * picked up again by the cron, by a wake or by the operator's « reprendre ». Each pick-up takes one of the two durable
 * attempts and makes the model read the same message again, whatever the CRM now says. The proof below is written when
 * such a wait ends and compared, before any claim, with a bounded re-read of exactly the same CRM objects: no attempt
 * and no model call unless a read that was incomplete is now complete, or a complete read changed. Digests only, never
 * the content of a read.
 */
export const SAV_INTAKE_RESUME_REVISION = "intake-resume-proof.v1";
/** Reads fingerprinted per analysis. Beyond it « unchanged » cannot be shown and the proof is not used. */
export const SAV_INTAKE_RESUME_MAX_READS = 40;
/** Wait before the scheduler looks again at a held run: the operator's button is never throttled. */
export const SAV_INTAKE_RESUME_PROBE_DELAYS_MS: readonly number[] = Object.freeze([10, 30, 120, 360].map(minutes => minutes * 60_000));
/** Reasons handed back to the caller and shown to the operator. */
export const SAV_INTAKE_RESUME_NO_PROGRESS = "SAV_INTAKE_RESUME_NO_PROGRESS";
export const SAV_INTAKE_RESUME_PROBE_UNAVAILABLE = "SAV_INTAKE_RESUME_PROBE_UNAVAILABLE";
export const SAV_INTAKE_RESUME_METHODS = ["findContactsByEmail", "directAssociations", "getContact", "ticketsForContact", "ticketHistory"] as const;
export type IntakeResumeMethod = typeof SAV_INTAKE_RESUME_METHODS[number];
export type IntakeResumeReaders = Pick<IntakeAdapters, IntakeResumeMethod>;

const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const intakeResumeProofSchema = z.object({
  revision: z.literal(SAV_INTAKE_RESUME_REVISION), configHash: hex, sourceHash: z.string().min(1).max(200),
  /** First reason code of the wait, for people: never used to decide. */
  incomplete: z.string().max(100), truncated: z.boolean(),
  reads: z.array(z.object({ method: z.enum(SAV_INTAKE_RESUME_METHODS), arg: z.string().min(1).max(320), status: z.enum(["complete", "partial", "failed"]), digest: hex }).strict()).max(SAV_INTAKE_RESUME_MAX_READS),
}).strict();
export type IntakeResumeProof = z.infer<typeof intakeResumeProofSchema>;
export type IntakeResumeRead = IntakeResumeProof["reads"][number];

const canonical = (value: unknown): string => value === undefined ? "null" : value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
/** What a read says, without when it was observed: only a complete read has content. */
const readDigest = (result: ReadResult<unknown>) => digest(result.status === "complete" ? result.data : null);

export type IntakeResumeObservation = { reads: IntakeResumeRead[]; truncated: boolean };
export const newIntakeResumeObservation = (): IntakeResumeObservation => ({ reads: [], truncated: false });
/** Records, in the sink, what each CRM read of one analysis returned. Reads are passed through unchanged. */
export function observeIntakeReads<T extends IntakeResumeReaders>(readers: T, sink: IntakeResumeObservation): T {
  const wrapped: T = { ...readers };
  for (const method of SAV_INTAKE_RESUME_METHODS) {
    const read = readers[method] as (arg: string, signal: AbortSignal) => Promise<ReadResult<unknown>>;
    (wrapped as unknown as Record<string, unknown>)[method] = async (arg: string, signal: AbortSignal) => {
      const result = await read.call(readers, arg, signal);
      const entry: IntakeResumeRead = { method, arg, status: result.status, digest: readDigest(result) };
      const index = sink.reads.findIndex(r => r.method === method && r.arg === arg);
      if (index >= 0) sink.reads[index] = entry;
      else if (sink.reads.length >= SAV_INTAKE_RESUME_MAX_READS || arg.length === 0 || arg.length > 320) sink.truncated = true;
      else sink.reads.push(entry);
      return result;
    };
  }
  return wrapped;
}

/** Only an analysis that really met an incomplete read leaves a proof. */
export function intakeResumeProof(observation: IntakeResumeObservation, context: { configHash: string; sourceHash: string; incomplete: string }): IntakeResumeProof | undefined {
  if (!observation.reads.some(r => r.status !== "complete")) return undefined;
  const reads = observation.reads.map(r => ({ ...r })).sort((a, b) => `${a.method}\u0000${a.arg}`.localeCompare(`${b.method}\u0000${b.arg}`));
  const proof = { revision: SAV_INTAKE_RESUME_REVISION, configHash: context.configHash, sourceHash: context.sourceHash, incomplete: context.incomplete.slice(0, 100), truncated: observation.truncated, reads };
  const parsed = intakeResumeProofSchema.safeParse(proof);
  return parsed.success ? parsed.data : undefined;
}
/** A stored value that does not parse is no proof: the resume then follows its ordinary path. */
export function parseIntakeResumeProof(raw: unknown): IntakeResumeProof | null {
  const parsed = intakeResumeProofSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
/** A claimed run starts a new attempt: the proof of the previous wait must not outlive it (a crashed attempt is then resumed by the ordinary path). */
export function withoutIntakeResumeProof<T extends { resumeProof?: unknown }>(payload: T): Omit<T, "resumeProof"> {
  const copy = { ...payload };
  delete copy.resumeProof;
  return copy;
}
/** Identity of what a proof says, for the durable hold: same key = same stuck state. */
export const intakeResumeProofKey = (proof: IntakeResumeProof) => digest(proof.reads.map(r => [r.method, r.arg, r.status, r.digest])).slice(0, 32);

export type IntakeResumeProbe =
  | { state: "progress"; method: IntakeResumeMethod; change: "completed" | "changed"; checked: number }
  | { state: "same"; checked: number }
  | { state: "unavailable"; checked: number };
/**
 * Re-reads, in the order of the analysis, exactly the CRM objects the proof names. Stops at the first progress.
 * A read that was incomplete and now is complete, or a complete read whose content changed, is progress. A read that
 * was complete and now is not (outage, request bound) proves nothing: it is never taken for progress.
 */
export async function probeIntakeResume(proof: IntakeResumeProof, readers: IntakeResumeReaders, signal: AbortSignal): Promise<IntakeResumeProbe> {
  let checked = 0, regressed = false;
  for (const before of proof.reads) {
    if (signal.aborted) return { state: "unavailable", checked };
    let result: ReadResult<unknown>;
    try { result = await (readers[before.method] as (arg: string, signal: AbortSignal) => Promise<ReadResult<unknown>>)(before.arg, signal); }
    catch { return { state: "unavailable", checked }; }
    checked++;
    if (result.status === "complete") {
      if (before.status !== "complete") return { state: "progress", method: before.method, change: "completed", checked };
      if (readDigest(result) !== before.digest) return { state: "progress", method: before.method, change: "changed", checked };
    } else if (before.status === "complete") regressed = true;
  }
  return signal.aborted || regressed ? { state: "unavailable", checked } : { state: "same", checked };
}

export type IntakeResumeDecision =
  | { kind: "resume"; cause: "no_proof" | "stale_proof" | "unprovable" | "progress" }
  | { kind: "hold"; cause: "no_progress" | "unchecked" | "probe_unavailable" };
/**
 * `resume` leaves the claim exactly as it always was (one attempt, the model reads the message). `hold` leaves the run
 * as it is: no attempt, no model call. Only a proof written for this very message content and configuration, complete
 * enough to show « unchanged », can hold; anything else (no proof, another content, another configuration, too many
 * reads) is the ordinary resume.
 */
export function intakeResumeDecision(proof: IntakeResumeProof | null, current: { configHash: string; sourceHash: string }, probe: IntakeResumeProbe | null): IntakeResumeDecision {
  if (!proof) return { kind: "resume", cause: "no_proof" };
  if (proof.configHash !== current.configHash || proof.sourceHash !== current.sourceHash) return { kind: "resume", cause: "stale_proof" };
  if (proof.truncated || !proof.reads.length) return { kind: "resume", cause: "unprovable" };
  // A proof that applies and was not probed holds: a resume that skipped the check is never a free attempt.
  if (!probe) return { kind: "hold", cause: "unchecked" };
  if (probe.state === "progress") return { kind: "resume", cause: "progress" };
  return { kind: "hold", cause: probe.state === "same" ? "no_progress" : "probe_unavailable" };
}
export const intakeResumeHoldReason = (cause: Extract<IntakeResumeDecision, { kind: "hold" }>["cause"]) =>
  cause === "no_progress" ? SAV_INTAKE_RESUME_NO_PROGRESS : SAV_INTAKE_RESUME_PROBE_UNAVAILABLE;

/** `holds` counts consecutive looks at the same stuck state; the scheduler looks again after the matching delay. */
export function intakeResumeNextProbeAt(holds: number, now: Date) {
  const delays = SAV_INTAKE_RESUME_PROBE_DELAYS_MS;
  return new Date(now.getTime() + delays[Math.min(Math.max(holds, 1), delays.length) - 1]).toISOString();
}
