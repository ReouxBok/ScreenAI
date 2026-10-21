import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savThreads, savMessages, savIntakeHumanEvents, savIntakeConsole } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { getSavTranslations } from "../translations";
import { intakeConsoleInstalled } from "./console-capability";
import { intakeMessageHistorical } from "./launch-boundary";
import { readSavIntakeCurrent } from "./runtime-store";
import { readIntakeExecutionProgress } from "./executor";
import type { HumanEventPayload } from "./human-binding";
export async function readIntakeConsoleDetail(threadId: string) {
  if (!await intakeConsoleInstalled()) return null;
  const db = requireDb(), [projection] = await db.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId, threadId));
  const [thread] = projection ? await db.select().from(savThreads).where(eq(savThreads.id, threadId)) : [];
  if (!thread) return null;
  const rows = await db.select().from(savMessages).where(eq(savMessages.threadId, threadId))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(201);
  const displayed = rows.slice(0, 200), translations = await getSavTranslations(displayed.map(row => row.id));
  const messages = displayed.map(row => ({ id: row.id, direction: row.direction, fromEmail: row.fromEmail,
    receivedAt: row.receivedAt, createdAt: row.createdAt,
    body: decryptSavPayload<{ text: string; attachments?: Array<{ filename: string; mimeType: string; size: number }> }>(row.bodyCiphertext),
    translation: translations[row.id] }));
  const [latest] = await db.select().from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  const historical = latest ? await intakeMessageHistorical(latest.id) : false;
  const current = await readSavIntakeCurrent(threadId);
  if (historical) Object.assign(projection, { view: "completed", status: "historical_outside_automation", reason: "Historique — hors automatisation. Aucun ticket HubSpot fermé et aucun apprentissage déclaré terminé.", projectedEpoch: projection.epoch });
  const events = await db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.threadId, threadId))
    .orderBy(desc(savIntakeHumanEvents.createdAt), desc(savIntakeHumanEvents.id)).limit(50);
  const choices = events.map(event => {
    const payload = decryptSavPayload<HumanEventPayload>(event.payloadCiphertext);
    return { id: event.id, kind: event.kind, state: event.state, at: event.createdAt, actor: payload.actor.email,
      reason: payload.reason, parentVersion: event.parentVersion, contactId: payload.contactId, ticketId: payload.ticketId };
  });
  return { thread: { id: thread.id, subject: latest?.subject ?? thread.subject, paused: thread.aiPaused, ticketId: thread.hubspotTicketId },
    projection, latestMessageId: latest?.id ?? null, current, messages, historyTruncated: rows.length > 200,
    progress: latest ? await readIntakeExecutionProgress(latest.id) : null, choices };
}
