import { intakeThreadHumanHeld } from "./legacy-pause";
import { getSavExternalCompletion, readSavExternalCompletion } from "../external-completion";
import "server-only";
import { intakeAttachmentBody } from "./attachment-display";
import { and, desc, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savThreads, savMessages, savIntakeHumanEvents, savIntakeConsole } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { getSavTranslations } from "../translations";
import { intakeConsoleInstalled } from "./console-capability";
import { intakeMessageHistorical } from "./launch-boundary";
import { readSavIntakeCurrent } from "./runtime-store";
import { readIntakeRunDiagnostics } from "./run-diagnostics";
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
  const [latest] = await db.select().from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  const historical = latest ? await intakeMessageHistorical(latest.id) : false;
  const marker = latest ? await readSavExternalCompletion(latest) : null;
  const completed = marker && latest ? await getSavExternalCompletion(latest) : null;
  const humanHeld = await intakeThreadHumanHeld(threadId);
  const current = await readSavIntakeCurrent(threadId);
  const messages = displayed.map(row => {
    const derived=current?.sourceMatches && current.payload.attachments?.sourceHash===current.currentSourceHash && current.payload.attachments.read.messageId===row.id ? current.payload.attachments.read:undefined;
    return {id:row.id,direction:row.direction,fromEmail:row.fromEmail,receivedAt:row.receivedAt,createdAt:row.createdAt,
      body:intakeAttachmentBody(decryptSavPayload<{text:string;attachments?:unknown[];attachmentInventory?:unknown;attachmentRead?:unknown}>(row.bodyCiphertext),derived),translation:translations[row.id]};
  });
  if (historical) Object.assign(projection, { view: "completed", status: "historical_outside_automation", reason: "Historique — hors automatisation. Aucun ticket HubSpot fermé et aucun apprentissage déclaré terminé.", projectedEpoch: projection.epoch });
  if (completed) Object.assign(projection, { view: "completed", status: "handled_externally", reason: "Traité hors Studio — clôture administrative de ce message. Aucun verdict IA, fermeture HubSpot ou apprentissage terminé ne sont déclarés.", projectedEpoch: projection.epoch });
  else if (marker) Object.assign(projection, { view: null, status: "external_completion_pending", reason: "Traitement externe enregistré ; commande humaine ou résultat externe à rapprocher.", projectedEpoch: projection.epoch });
  else if (humanHeld) Object.assign(projection, { view: "to_validate", status: "human_hold", reason: "L’équipe garde la main sur ce dossier. L’automatisation reste en pause ; une décision humaine est attendue.", projectedEpoch: projection.epoch });
  else if (projection.status === "external_completion_pending") Object.assign(projection, { view: null, status: "processing", reason: "Disposition administrative révoquée ou nouveau message en attente d’analyse." });
  const events = await db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.threadId, threadId))
    .orderBy(desc(savIntakeHumanEvents.createdAt), desc(savIntakeHumanEvents.id)).limit(50);
  const choices = events.map(event => {
    const payload = decryptSavPayload<HumanEventPayload>(event.payloadCiphertext);
    return { id: event.id, kind: event.kind, state: event.state, at: event.createdAt, actor: payload.actor.email,
      reason: payload.reason, parentVersion: event.parentVersion, contactId: payload.contactId, ticketId: payload.ticketId };
  });
  const progress=latest ? await readIntakeExecutionProgress(latest.id) : null;
  const diagnostics=await readIntakeRunDiagnostics(threadId);
  const confirmedCurrent=Boolean(!marker && current && current.messageId===latest?.id && progress?.confirmed && progress.runId===current.id && progress.completionSourceHash && progress.completionSourceHash===current.currentSourceHash);
  return { confirmedCurrent, humanHeld, thread: { id: thread.id, subject: latest?.subject ?? thread.subject, paused: thread.aiPaused, ticketId: thread.hubspotTicketId },
    projection, handledExternally: Boolean(marker), latestMessageId: latest?.id ?? null, current, messages, historyTruncated: rows.length > 200,
    progress, choices, diagnostics };
}
