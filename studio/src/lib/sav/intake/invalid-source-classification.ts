import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { savIntakeRuns } from "@/db/schema";
import { classifySavDossierOtherManually } from "../external-completion";
import { readSavIntakeCurrent, savIntakeSourceSnapshot } from "./runtime-store";
import { invalidIntakeAddressMetadata } from "./source-validation";

const inputSchema = z.object({ requestKey: z.uuid(), threadId: z.uuid(), messageId: z.uuid(), confirmed: z.literal(true) }).strict();

/** Operator "Autres" classification reserved to a current message whose transport
 * addresses refuse the analysis source. The verified run and the invalidity are
 * re-checked under the thread locks before any append: a repaired or reingested
 * source is refused without a marker. No model, email or CRM call. */
export async function classifyInvalidSourceAsOther(raw: unknown) {
  const input = inputSchema.parse(raw);
  const current = await readSavIntakeCurrent(input.threadId);
  if (!current?.sourceInvalid || current.messageId !== input.messageId) throw Error("SAV_INTAKE_SOURCE_NOT_INVALID");
  const verified = { runId: current.id, version: current.version };
  return classifySavDossierOtherManually(input, async (tx, message) => {
    const [run] = await tx.select({ id: savIntakeRuns.id, version: savIntakeRuns.version, messageId: savIntakeRuns.messageId }).from(savIntakeRuns)
      .where(and(eq(savIntakeRuns.threadId, message.threadId), eq(savIntakeRuns.isCurrent, true))).for("update");
    if (!run || run.id !== verified.runId || run.version !== verified.version || run.messageId !== message.id) return false;
    try { await savIntakeSourceSnapshot(tx, message, new Date()); return false; }
    catch (error) { if (invalidIntakeAddressMetadata(error)) return true; throw error; }
  });
}
