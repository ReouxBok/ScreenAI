import { buildSavInboundContext, SAV_MESSAGE_CONTEXT_REVISION } from "../message-context";
import { intakeMessageSchema, type IntakeMessage } from "./engine-types";

/** Pure transport derivation. Does not open a Studio dossier or mark it read. */
export function prepareSavIntakeMessage(input: Omit<IntakeMessage, "currentText" | "contentComplete"> & {
  subject: string; body: string; bodyComplete: boolean; unresolvedAttachments: boolean;
}) {
  const context = buildSavInboundContext(input);
  const { subject, body, bodyComplete, unresolvedAttachments, ...metadata } = input;
  void body;
  const message = intakeMessageSchema.parse({ ...metadata, currentText: context.currentText,
    contentComplete: bodyComplete && !unresolvedAttachments && !context.truncated });
  return { message, provenance: { revision: SAV_MESSAGE_CONTEXT_REVISION, messageId: message.id,
    subject: subject.slice(0, 2000), subjectInherited: context.subjectInherited,
    quotedText: context.quotedText, signatureText: context.signatureText, parts: context.parts,
    truncated: context.truncated || subject.length > 2000, unresolvedAttachments } };
}
