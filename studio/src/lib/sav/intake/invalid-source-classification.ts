import "server-only";
import { z } from "zod";
import { classifySavDossierOtherManually } from "../external-completion";
import { readSavIntakeCurrent } from "./runtime-store";

const inputSchema = z.object({ requestKey: z.uuid(), threadId: z.uuid(), messageId: z.uuid(), confirmed: z.literal(true) }).strict();

/** Operator "Autres" classification reserved to a current message whose transport
 * addresses refuse the analysis source. No model, email or CRM call; the source,
 * its journal and limits stay untouched. */
export async function classifyInvalidSourceAsOther(raw: unknown) {
  const input = inputSchema.parse(raw);
  const current = await readSavIntakeCurrent(input.threadId);
  if (!current?.sourceInvalid || current.messageId !== input.messageId) throw Error("SAV_INTAKE_SOURCE_NOT_INVALID");
  return classifySavDossierOtherManually(input);
}
