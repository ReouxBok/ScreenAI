import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { intakeOperatorInformationSchema, operatorInformationHash, OPERATOR_COMMAND_ACTION } from "./operator-information-contract";

/** Immutable encrypted revisions use the existing durable journal. Exactly
 * one message is read; an unreadable current revision fails shut. */
export async function readIntakeOperatorInformation(threadId: string, messageId: string,
  db: Pick<ReturnType<typeof requireDb>, "select"> = requireDb()) {
  const [row] = await db.select().from(auditLogs).where(and(
    eq(auditLogs.action, OPERATOR_COMMAND_ACTION), eq(auditLogs.entityType, "sav_intake_operator_command"), eq(auditLogs.entityId, threadId),
    sql`${auditLogs.technicalMetadata}->>'messageId'=${messageId} and ${auditLogs.technicalMetadata}->>'kind'='information'`,
  )).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(1);
  if (!row) return null;
  const encrypted = row.technicalMetadata.payloadCiphertext;
  if (typeof encrypted !== "string") throw Error("SAV_INTAKE_OPERATOR_INFORMATION_UNREADABLE");
  const value = intakeOperatorInformationSchema.parse(decryptSavPayload<{ information: unknown }>(encrypted).information);
  if (value.id !== row.id || value.messageId !== messageId || value.contentHash !== operatorInformationHash(value.text))
    throw Error("SAV_INTAKE_OPERATOR_INFORMATION_UNREADABLE");
  return value;
}
