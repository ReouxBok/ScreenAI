import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savIntakeExecutions, savMessages } from "@/db/schema";
import { savContentHash } from "../crypto";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { savV2WakeWorkflowsEnabled, CASE_WAKE_STEP_BUDGET_MS } from "./case-v2-latency-wakes";
import { recordCaseAfterConfirmedIntake, relayPaused, v2HubspotOwnerId } from "./intake-boundary";
import { continueCaseAfterCommit, savV2EntryEnabled, v2EntryRelayDeps } from "./v2-entry";

type Env = Record<string, string | undefined>;
export type OwnerEvent = { subscriptionType: string; propertyName?: string; propertyValue?: string; portalId?: number; objectId?: string | number; occurredAt?: number; eventId?: number; changeSource?: string };
export const OWNER_HANDOVER_MARK = { action: "sav_v2_owner_handover", entityType: "sav_hubspot_ticket" } as const;
const RECOVERY_DELAY_MS = 300_000;
const MAX_HANDOVER_AGE_MS = 3_600_000;
const handoverExpired = (metadata: Record<string, unknown>, now: number) => Number(metadata.occurredAt) + MAX_HANDOVER_AGE_MS <= now;
const MAX_RECOVERY_RETRIES = 3;
const whereMark = (id: string) => and(eq(auditLogs.action, OWNER_HANDOVER_MARK.action), eq(auditLogs.entityType, OWNER_HANDOVER_MARK.entityType), eq(auditLogs.entityId, id));
export const ownerHandoverEnabled = (env: Env) => env.SAV_V2_OWNER_HANDOVER === "on" && savV2EntryEnabled(env) && savV2WakeWorkflowsEnabled(env);
export function isOwnerHandoverEvent(event: OwnerEvent, env: Env) {
  const owner = v2HubspotOwnerId(env);
  return !!owner && event.subscriptionType === "ticket.propertyChange" && event.propertyName === "hubspot_owner_id"
    && String(event.portalId) === String(SAV_HUBSPOT_SUPPORT.portalId) && event.propertyValue === owner && ["CRM_UI", "MOBILE"].includes(event.changeSource ?? "");
}
export type OwnerHandoverStart = (ticketId: string, token: string, wakeAt: string) => Promise<unknown>;
const startDefault: OwnerHandoverStart = async (...args) => {
  const [{ start }, { processSavV2OwnerHandoverWorkflow }] = await Promise.all([import("workflow/api"), import("@/workflows/sav-v2-owner-handover")]);
  return start(processSavV2OwnerHandoverWorkflow, args);
};
/** Every owner change invalidates an older handover, including a return through API. Retries of the same receipt never reset the recovery budget. */
export async function requestOwnerHandover(event: OwnerEvent, options: { env: Env; start?: OwnerHandoverStart }) {
  if (!ownerHandoverEnabled(options.env)) return { status: "off" };
  if (event.subscriptionType !== "ticket.propertyChange" || event.propertyName !== "hubspot_owner_id" || String(event.portalId) !== String(SAV_HUBSPOT_SUPPORT.portalId)
    || !/^\d{1,30}$/.test(String(event.objectId ?? "")) || !Number.isSafeInteger(event.occurredAt) || event.occurredAt! <= 0 || event.occurredAt! > 8.64e15 - 305_000) return { status: "ignored" };
  const ticketId = String(event.objectId), occurredAt = event.occurredAt!, wakeAt = new Date(occurredAt + 305_000).toISOString();
  const token = savContentHash({ eventId: event.eventId, occurredAt, value: event.propertyValue, source: event.changeSource });
  const eligible = isOwnerHandoverEvent(event, options.env);
  const reserved = await requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`owner-handover:${ticketId}`}))`);
    const [row] = await tx.select().from(auditLogs).where(whereMark(ticketId)).for("update");
    const old = row?.technicalMetadata;
    if (old && (Number(old.occurredAt) > occurredAt || (old.receiptToken ?? old.token) === token)) return false;
    const technicalMetadata = { token, receiptToken: token, occurredAt, wakeAt, recoverAt: new Date(Math.max(Date.now(), Date.parse(wakeAt)) + RECOVERY_DELAY_MS).toISOString(), retries: 0, state: eligible ? "starting" : "cancelled" };
    if (row) await tx.update(auditLogs).set({ technicalMetadata }).where(eq(auditLogs.id, row.id));
    else await tx.insert(auditLogs).values({ actorEmail: "system", ...OWNER_HANDOVER_MARK, entityId: ticketId, technicalMetadata });
    return eligible;
  });
  if (!reserved) return { status: "not_reserved" };
  await startReservedHandover(ticketId, token, wakeAt, options.start ?? startDefault);
  return { status: "scheduled", wakeAt };
}

async function startReservedHandover(ticketId: string, token: string, wakeAt: string, start: OwnerHandoverStart) {
  try { await start(ticketId, token, wakeAt); }
  catch {
    await requireDb().transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`owner-handover:${ticketId}`}))`);
      const [row] = await tx.select().from(auditLogs).where(whereMark(ticketId)).for("update");
      if (row?.technicalMetadata.token === token && row.technicalMetadata.state === "starting")
        await tx.update(auditLogs).set({ technicalMetadata: { ...row.technicalMetadata, state: "start_failed" } }).where(eq(auditLogs.id, row.id));
    });
    throw Error("SAV_OWNER_HANDOVER_START_FAILED");
  }
}

/** Called by the periodic relay sweep, independently of processed webhook receipts.
 * Rotate the attempt token under the same lock as consumption: late workflows and
 * concurrent sweeps cannot consume or settle a replacement attempt. */
export async function recoverOwnerHandovers(options: { env: Env; limit: number }) {
  const now = new Date();
  const due = sql`technical_metadata->>'state' in ('starting', 'start_failed', 'consumed') and (${!ownerHandoverEnabled(options.env)} or (technical_metadata->>'occurredAt')::numeric + ${MAX_HANDOVER_AGE_MS} <= ${now.getTime()} or coalesce((technical_metadata->>'recoverAt')::timestamptz, (technical_metadata->>'wakeAt')::timestamptz + interval '5 minutes') <= ${now.toISOString()}::timestamptz)`;
  const rows = await requireDb().select({ ticketId: auditLogs.entityId }).from(auditLogs)
    .where(and(eq(auditLogs.action, OWNER_HANDOVER_MARK.action), eq(auditLogs.entityType, OWNER_HANDOVER_MARK.entityType), due))
    .orderBy(sql`coalesce(technical_metadata->>'recoverAt', technical_metadata->>'wakeAt')`, auditLogs.id).limit(options.limit);
  for (const { ticketId } of rows) {
    if (!ticketId) continue;
    const reserved = await requireDb().transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`owner-handover:${ticketId}`}))`);
      const [row] = await tx.select().from(auditLogs).where(and(whereMark(ticketId), due)).for("update");
      if (!row) return null;
      const old = row.technicalMetadata, retries = Number(old.retries ?? 0);
      const reason = !ownerHandoverEnabled(options.env) ? "switch_off" : handoverExpired(old, now.getTime()) ? "expired" : retries >= MAX_RECOVERY_RETRIES ? "recovery_exhausted" : null;
      if (reason) {
        await tx.update(auditLogs).set({ technicalMetadata: { ...old, state: "abandoned", outcome: reason, abandonedAt: now.toISOString() } }).where(eq(auditLogs.id, row.id));
        console.info("sav_v2_owner_handover", { ticketId, status: "abandoned", retries });
        return null;
      }
      const token = savContentHash({ previous: old.token, retry: retries + 1 });
      await tx.update(auditLogs).set({ technicalMetadata: { ...old, receiptToken: old.receiptToken ?? old.token, token, retries: retries + 1,
        state: "starting", recoverAt: new Date(now.getTime() + RECOVERY_DELAY_MS).toISOString() } }).where(eq(auditLogs.id, row.id));
      return { token, wakeAt: String(old.wakeAt) };
    });
    if (reserved) {
      try { await startReservedHandover(ticketId, reserved.token, reserved.wakeAt, startDefault); }
      catch { console.info("sav_v2_owner_handover", { ticketId, status: "recovery_start_failed" }); }
    }
  }
}

/** Transient markers expire one hour after the owner event. Consumed means checks
 * are in progress, including a delayed or interrupted CRM read. A team-last result
 * blocks the old mail until a newer confirmed inbound, regardless of the event age.
 * SQL form also protects the first relay of a case that does not exist yet. */
export const noOwnerHandoverGrace = (ticketId: unknown) => sql`not exists (select 1 from public.audit_logs h where h.action = ${OWNER_HANDOVER_MARK.action} and h.entity_type = ${OWNER_HANDOVER_MARK.entityType} and h.entity_id = ${ticketId} and (((h.technical_metadata->>'occurredAt')::numeric + ${MAX_HANDOVER_AGE_MS} > extract(epoch from clock_timestamp()) * 1000 and h.technical_metadata->>'state' in ('starting', 'start_failed', 'consumed')) or (h.technical_metadata->>'state' = 'team_replied_last' and not exists (select 1 from sav.intake_executions e join sav.messages m on m.id = e.message_id where e.ticket_id = h.entity_id and e.state = 'confirmed' and m.direction = 'inbound' and m.received_at > (h.technical_metadata->>'teamLastAt')::timestamptz))))`;
export async function ownerHandoverGraceOpen(ticketId: string) {
  const [row] = await requireDb().select({ clear: noOwnerHandoverGrace(ticketId) }).from(auditLogs).limit(1);
  return row ? !row.clear : false;
}

type TicketState = { owner: string | null; pipeline: string | null; lastEmailAt: number; lastDirection: "customer" | "team" | "unknown" };
export async function runOwnerHandover(ticketId: string, token: string, options: {
  env: Env; now?: Date; readTicket?: (id: string) => Promise<TicketState>;
  relay?: typeof recordCaseAfterConfirmedIntake; continuation?: typeof continueCaseAfterCommit;
}) {
  const now = options.now ?? new Date();
  const consumed = await requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`owner-handover:${ticketId}`}))`);
    const [row] = await tx.select().from(auditLogs).where(whereMark(ticketId)).for("update");
    if (!row || row.technicalMetadata.token !== token || row.technicalMetadata.state !== "starting") return false;
    const reason = !ownerHandoverEnabled(options.env) ? "switch_off" : handoverExpired(row.technicalMetadata, now.getTime()) ? "expired" : null;
    if (reason) {
      await tx.update(auditLogs).set({ technicalMetadata: { ...row.technicalMetadata, state: "abandoned", outcome: reason, abandonedAt: now.toISOString() } }).where(eq(auditLogs.id, row.id));
      return reason;
    }
    if (Date.parse(String(row.technicalMetadata.wakeAt)) > now.getTime()) return false;
    await tx.update(auditLogs).set({ technicalMetadata: { ...row.technicalMetadata, state: "consumed", recoverAt: new Date(now.getTime() + RECOVERY_DELAY_MS).toISOString() } }).where(eq(auditLogs.id, row.id));
    return true;
  });
  const settle = async (state: string, detail: Record<string, string> = {}) => requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`owner-handover:${ticketId}`}))`);
    const [row] = await tx.select().from(auditLogs).where(whereMark(ticketId)).for("update");
    if (row?.technicalMetadata.token !== token || row.technicalMetadata.state !== "consumed") return false;
    await tx.update(auditLogs).set({ technicalMetadata: { ...row.technicalMetadata, state, ...detail } }).where(eq(auditLogs.id, row.id));
    return true;
  });
  const done = async (status: string) => {
    // Does not overwrite a newer owner event, team-last, or an admitted result.
    if (consumed === true) await settle("rejected", { outcome: status });
    console.info("sav_v2_owner_handover", { ticketId, status });
    return { status };
  };
  if (!consumed) return done("not_consumed");
  if (consumed === "switch_off") return done("off");
  if (consumed === "expired") return done("expired");
  if (await relayPaused(requireDb())) return done("paused");
  const ticket = await (options.readTicket ?? (await import("../hubspot")).readOwnerHandoverTicket)(ticketId);
  if (ticket.owner !== v2HubspotOwnerId(options.env) || ticket.pipeline !== "0") return done("owner_or_pipeline_changed");
  if (ticket.lastDirection === "team") {
    // Keep the sweep from replaying the older customer mail after this wake stops.
    if (!await settle("team_replied_last", { teamLastAt: new Date(ticket.lastEmailAt).toISOString() })) return done("replaced");
    return done("team_replied_last");
  } // Existing J2 remains untouched; no new reminder is invented.
  if (ticket.lastDirection !== "customer") return done("history_unavailable");
  const [source] = await requireDb().select({ id: savMessages.id, at: savMessages.receivedAt }).from(savIntakeExecutions)
    .innerJoin(savMessages, eq(savMessages.id, savIntakeExecutions.messageId))
    .where(and(eq(savIntakeExecutions.ticketId, ticketId), eq(savIntakeExecutions.state, "confirmed"), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.id)).limit(1);
  if (!source) return done("no_confirmed_v1_mail");
  if (ticket.lastEmailAt > source.at.getTime()) return done("latest_mail_not_confirmed");
  const [current] = await requireDb().select().from(auditLogs).where(whereMark(ticketId));
  if (current?.technicalMetadata.token !== token || current.technicalMetadata.state !== "consumed") return done("replaced");
  if (handoverExpired(current.technicalMetadata, Math.max(now.getTime(), Date.now()))) {
    await settle("abandoned", { outcome: "expired", abandonedAt: new Date().toISOString() });
    return done("expired");
  }
  if (!ownerHandoverEnabled(options.env)) {
    await settle("abandoned", { outcome: "switch_off", abandonedAt: new Date().toISOString() });
    return done("off");
  }
  const result = await (options.relay ?? recordCaseAfterConfirmedIntake)(source.id, v2EntryRelayDeps(options.env));
  if (!("owner" in result) || result.owner !== "agent") return done("not_admitted");
  // The relay has committed the case. Release the sweep only after this durable
  // result, and before starting its continuation (which can fail independently).
  if (!await settle("admitted", { caseId: result.caseId })) return done("replaced");
  const outcome = await (options.continuation ?? continueCaseAfterCommit)(result.caseId, "relay", { env: options.env, immediateDeadlineMs: Date.now() + CASE_WAKE_STEP_BUDGET_MS });
  return done(outcome.status);
}
