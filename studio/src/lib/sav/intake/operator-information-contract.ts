import { createHash } from "node:crypto";
import { z } from "zod";

/** Context from an authenticated operator, never an instruction or a grant. */
export const intakeOperatorInformationSchema = z.object({
  id: z.uuid(), revision: z.number().int().positive(), messageId: z.uuid(),
  actorId: z.uuid(), at: z.iso.datetime(), text: z.string().trim().min(1).max(2000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type IntakeOperatorInformation = z.infer<typeof intakeOperatorInformationSchema>;
export const operatorInformationHash = (text: string) => createHash("sha256").update(text).digest("hex");
export const OPERATOR_COMMAND_ACTION = "sav_intake_operator_command";
