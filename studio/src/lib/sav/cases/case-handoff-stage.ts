// SAV-92 (Ugo 17/11, local, OFF): the V2 hand-over gives the HubSpot ticket back to the team: stage « Nouveau » (V1's new stage) and NO owner, through the EXISTING
// ticket-stage queue, executor, permission (`set_case_ticket_stage`) and HubSpot adapter. ONE stage per hand-over (key `case-stage:<case>:handoff:handoff-v<n>`, n = the
// version of the `owner_changed` hand-over event), queued only once the hand-over is durable:
//   - with a hand-over reply: in the reply's own receipt transaction (`case-effect-driver.ts`), so the owner is cleared only after the customer was told (the reply's
//     executor needs the V2 owner on the ticket to send it);
//   - without one (sensitive topic, `SAV_V2_CLOSING_HANDOFF_REPLY` off, a decision that sends nothing, a reply refused or revoked): by this sweep, from the stored case.
// The two paths share the key: a replay, a second lap or both paths together queue it once. OFF unless `SAV_V2_HANDOFF_STAGE=on` AND `SAV_V2_TICKET_STAGES=on`.
import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savCaseEvents, savCaseReplyValidations } from "@/db/schema";
import type { ExecutionTx } from "../intake/execution-store";
import { caseReplyKey } from "./case-effects";
import { nextSweepPage } from "./case-sweep-cursor";
import { listCaseEvents, lockCaseForWrite, readCase } from "./case-store";
import { closingHandoffReplyEnabled, handoffReplyTrigger } from "./case-terminal-reply";
import { enqueueCaseTicketStage, openHandoffVersion, type EnqueueTicketStageResult } from "./case-ticket-stage-queue";
import type { CaseEvent, CaseSnapshot } from "./case-types";
import { caseHandoffStageEnabled, readCaseTicketStageConfig } from "./customer-return";

type Env = () => Record<string, string | undefined>;
type Policy = Readonly<{ id: string; hash: string }>;

const handoffStageSinceSchema = z.iso.datetime({ offset: true });
let warnedAboutHandoffStageSince = false;

/** Inside the caller's transaction, the case locked by the caller: queues the stage of the hand-over in force, if any. Writes nothing when the switch is off. */
export async function enqueueCaseHandoffStage(tx: ExecutionTx, input: Readonly<{ snapshot: CaseSnapshot; policy: Policy; env: Env; threadId?: string }>): Promise<EnqueueTicketStageResult> {
  const env = input.env();
  if (!caseHandoffStageEnabled(env)) return { ok: false, reason: "handoff_stage_off" };
  const rawSince = env.SAV_V2_HANDOFF_STAGE_SINCE;
  const parsed = handoffStageSinceSchema.safeParse(rawSince);
  const since = parsed.success ? Date.parse(parsed.data) : NaN;
  if (!parsed.success || !Number.isFinite(since)) {
    if (!warnedAboutHandoffStageSince) {
      warnedAboutHandoffStageSince = true;
      console.warn("SAV_V2_HANDOFF_STAGE_SINCE is missing or invalid; handoff stage admission disabled");
    }
    return { ok: false, reason: rawSince ? "handoff_stage_since_invalid" : "handoff_stage_since_missing" };
  }
  const version = await openHandoffVersion(tx, input.snapshot);
  if (version === undefined) return { ok: false, reason: "handoff_not_current" };
  // A threadless case can have a crm_observed version, but admission requires a recorded owner change.
  const [event] = await tx.select({ occurredAt: savCaseEvents.occurredAt }).from(savCaseEvents).where(and(
    eq(savCaseEvents.caseId, input.snapshot.caseId), eq(savCaseEvents.caseVersion, version), eq(savCaseEvents.kind, "owner_changed"),
  )).limit(1);
  if (!event) return { ok: false, reason: "handoff_owner_event_missing" };
  // Case events have millisecond precision. An ISO bound between two milliseconds starts at the next one.
  const subMillisecond = /\.[0-9]{3}[0-9]*[1-9]/.test(parsed.data);
  if (event.occurredAt.getTime() < since + Number(subMillisecond)) return { ok: false, reason: "handoff_before_since" };
  return enqueueCaseTicketStage(tx, { snapshot: input.snapshot, trigger: { kind: "handoff_recorded", caseVersion: version }, policy: input.policy, env: input.env,
    ...(input.threadId ? { threadId: input.threadId } : {}) });
}

async function journal(caseId: string) {
  const events: CaseEvent[] = [];
  for (let page = await listCaseEvents(caseId, { limit: 500 }); page.length; page = await listCaseEvents(caseId, { afterVersion: page.at(-1)!.caseVersion, limit: 500 })) {
    events.push(...page);
    if (page.length < 500) break;
  }
  return events;
}

/**
 * Whether a hand-over reply may still be sent: the stage then waits for its receipt (which queues it), since a ticket without the V2 owner would hold that reply for good.
 * Not outstanding: the reply switch off, no reply allowed now (sensitive, refusal hand-over, a person or a customer mail since), or its execution / approval ended unsent.
 */
async function handoffReplyOutstanding(snapshot: CaseSnapshot, events: readonly CaseEvent[], env: Env): Promise<boolean> {
  if (!closingHandoffReplyEnabled(env())) return false;
  const trigger = handoffReplyTrigger(snapshot, events);
  if (!trigger) return false;
  const key = caseReplyKey(snapshot.caseId, trigger), db = requireDb();
  const [execution] = await db.select({ state: savCaseEffectExecutions.state }).from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.replyKey, key));
  if (execution) return execution.state !== "confirmed" && execution.state !== "refused";
  const validations = await db.select({ state: savCaseReplyValidations.state }).from(savCaseReplyValidations)
    .where(and(eq(savCaseReplyValidations.caseId, snapshot.caseId), eq(savCaseReplyValidations.replyKey, key)));
  // Not proposed yet, or proposed / approved and not queued yet: the reply is still coming. Only rejected / revoked / superseded rows: it will not be sent.
  return !validations.length || validations.some(row => row.state === "proposed" || row.state === "approved");
}

export type HandoffStageRefusal = "handoff_stage_off" | "stages_off" | "case_unknown" | "handoff_not_current" | "handoff_reply_pending" | "version_moved" | (string & {});
export type EnqueueHandoffStageResult = EnqueueTicketStageResult | Readonly<{ ok: false; reason: HandoffStageRefusal }>;

/** The sweep's admission for one case, read from the stored case. Idempotent (one key per hand-over). */
export async function enqueueHandoffStage(input: Readonly<{ caseId: string; policy: Policy; env: Env }>): Promise<EnqueueHandoffStageResult> {
  if (!caseHandoffStageEnabled(input.env())) return { ok: false, reason: "handoff_stage_off" };
  if (readCaseTicketStageConfig(input.env()).mode !== "on") return { ok: false, reason: "stages_off" };
  const snapshot = await readCase(input.caseId);
  if (!snapshot) return { ok: false, reason: "case_unknown" };
  if (snapshot.owner !== "human" || snapshot.phase !== "handoff_pending" || !snapshot.body.handoff || snapshot.body.handoff.humanSince) return { ok: false, reason: "handoff_not_current" };
  if (await handoffReplyOutstanding(snapshot, await journal(snapshot.caseId), input.env)) return { ok: false, reason: "handoff_reply_pending" };
  return requireDb().transaction(async (tx): Promise<EnqueueHandoffStageResult> => {
    const locked = await lockCaseForWrite(tx, snapshot.caseId);
    if (locked.version !== snapshot.version) return { ok: false, reason: "version_moved" };
    return enqueueCaseHandoffStage(tx, { snapshot: locked, policy: input.policy, env: input.env });
  });
}

export type HandoffStageSweepResult = Readonly<{ examined: number; created: number; existing: number; refused: Readonly<Record<string, number>>; windowEnded: boolean; stoppedByDeadline: boolean }>;
/** The cases touched since `since`, at most `limit` per call from a durable cursor (no case starved). A case read twice queues nothing twice. */
export async function enqueueHandoffStages(input: Readonly<{ policy: Policy; env: Env; since: Date; limit?: number; deadlineMs?: number; now?: () => number }>): Promise<HandoffStageSweepResult> {
  const page = await nextSweepPage({ name: "handoff-stage", since: input.since, limit: input.limit ?? 50 });
  let created = 0, existing = 0, handled = 0;
  const refused: Record<string, number> = {};
  for (const id of page.ids) {
    if (input.deadlineMs !== undefined && (input.now ?? Date.now)() >= input.deadlineMs) break;
    const result = await enqueueHandoffStage({ caseId: id, policy: input.policy, env: input.env });
    if (result.ok) { if (result.created) created++; else existing++; } else refused[result.reason] = (refused[result.reason] ?? 0) + 1;
    handled++;
  }
  await page.commit(handled);
  return { examined: handled, created, existing, refused, windowEnded: page.windowEnded && handled === page.ids.length, stoppedByDeadline: handled < page.ids.length };
}
