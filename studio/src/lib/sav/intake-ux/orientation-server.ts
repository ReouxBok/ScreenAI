import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savIntakeHumanEvents } from "@/db/schema";
import { decryptSavPayload } from "@/lib/sav/crypto";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { readSavIntakeCurrent } from "@/lib/sav/intake/runtime-store";
import { intakeRuntimeHash } from "@/lib/sav/intake/runtime-contract";
import { recordIntakeHumanCommand } from "@/lib/sav/intake/human-commands";
import type { HumanEventPayload } from "@/lib/sav/intake/human-binding";
import { orientationCommand, orientationSchema } from "./orientation";

export async function recordUxOrientation(raw: unknown) {
  await requireIntakeConsoleStaff();
  const input = orientationSchema.parse(raw);
  if (await readUxOrientationReceipt({ commandKey: input.commandKey, threadId: input.threadId, messageId: input.messageId }))
    return recordIntakeHumanCommand(orientationCommand(input)); // canonical actor/content hash check, including a consumed event
  const current = await readSavIntakeCurrent(input.threadId);
  // classify accepts a contact field; qualify it against the server's bound
  // candidates. The canonical transaction still checks the same hash/version.
  if (input.intent === "orient" && input.contactId && (!current || current.id !== input.runId
    || current.messageId !== input.messageId || current.version !== input.version || current.sourceHash !== input.sourceHash
    || !current.candidateContactIds || intakeRuntimeHash([...current.candidateContactIds].sort()) !== input.candidatesHash
    || !current.candidateContactIds.includes(input.contactId))) throw Error("SAV_INTAKE_HUMAN_CONFLICT");
  return recordIntakeHumanCommand(orientationCommand(input));
}
const receiptSchema = z.object({ commandKey: z.uuid(), threadId: z.uuid(), messageId: z.uuid() }).strict();
export async function readUxOrientationReceipt(raw: unknown) {
  const staff = await requireIntakeConsoleStaff(), input = receiptSchema.parse(raw);
  const [row] = await requireDb().select().from(savIntakeHumanEvents).where(and(eq(savIntakeHumanEvents.commandKey, input.commandKey),
    eq(savIntakeHumanEvents.threadId, input.threadId), eq(savIntakeHumanEvents.messageId, input.messageId))).limit(1);
  if (!row) return null;
  const payload = decryptSavPayload<HumanEventPayload>(row.payloadCiphertext);
  if (payload.actor.id !== staff.id) return null;
  return { eventId: row.id, state: row.state, at: row.createdAt.toISOString(), parentVersion: row.parentVersion };
}
