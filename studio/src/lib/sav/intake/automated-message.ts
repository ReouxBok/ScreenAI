import type { IntakeAdapters, IntakeMessage } from "./engine-types";

export const SAV_INTAKE_AUTOMATION_REVISION = "sav-intake-automation-gate.v1";
export type IntakeAutomation = {
  revision: typeof SAV_INTAKE_AUTOMATION_REVISION;
  kind: "automatic_reply" | "support_delivery_failure";
  code: "SAV_INTAKE_AUTOMATED_REPLY" | "SAV_INTAKE_SUPPORT_DELIVERY_FAILURE";
  // Header facts only, never an identifier, address or text.
  signals: string[];
};

const ids = (value: string) => value.match(/<[^<>\s]+>/g) ?? [];
const deliveryReport = /^multipart\/report\s*;(?:[^;]*;)*\s*report-type\s*=\s*"?delivery-status"?\s*(?:;|$)/i;

/** V1 cost filter, decided before any reservation, CRM read or model call. Authority is the
 * Gmail headers stored at ingestion, plus the thread's own support messages: never the subject,
 * the body text or the sender address alone. Missing, partial, repeated or unknown metadata,
 * attachments and forwarded content return null and the mail follows the normal SAV path. */
export function intakeAutomatedMessage(input: { message: IntakeMessage; headers: unknown; attachments: unknown;
  supportMessageIds: readonly string[] }): IntakeAutomation | null {
  const { message, headers } = input;
  // Information added by a person asks for the normal path.
  if (message.direction !== "inbound" || message.operatorInformation || !headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const header = (name: string) => { const value = (headers as Record<string, unknown>)[name]; return typeof value === "string" ? value.trim() : ""; };
  const contentType = header("content-type"), inReplyTo = ids(header("in-reply-to"));
  const support = new Set(input.supportMessageIds);
  const answersSupport = [...inReplyTo, ...ids(header("references"))].some(id => support.has(id));
  const result = (kind: IntakeAutomation["kind"], signals: string[]): IntakeAutomation => ({ revision: SAV_INTAKE_AUTOMATION_REVISION, kind,
    code: kind === "automatic_reply" ? "SAV_INTAKE_AUTOMATED_REPLY" : "SAV_INTAKE_SUPPORT_DELIVERY_FAILURE", signals });
  // A delivery report about a support mail of this thread: the failure stays visible for a follow-up.
  // A report that names no support mail of the thread is not qualified here.
  if (deliveryReport.test(contentType)) return answersSupport ? result("support_delivery_failure", ["content-type:delivery-status", "references:support-message"]) : null;
  // A forward or any attachment may carry a real need, whatever the automation header says.
  if (/\b(?:message\/rfc822|multipart\/mixed)\b/i.test(contentType) || message.attachmentInputs?.length || message.unreadAttachments?.length
    || Array.isArray(input.attachments) && input.attachments.length) return null;
  // RFC 3834: one keyword, optional parameters. A list or an unknown keyword is ambiguous.
  const keyword = /^([a-z-]+)\s*(?:;[^,]*)?$/i.exec(header("auto-submitted"))?.[1].toLowerCase();
  if (keyword === "auto-replied" && inReplyTo.length) return result("automatic_reply", ["auto-submitted:auto-replied", "in-reply-to:present"]);
  if (keyword === "auto-generated" && inReplyTo.some(id => support.has(id))) return result("automatic_reply", ["auto-submitted:auto-generated", "in-reply-to:support-message"]);
  return null;
}

/** The engine's own context path without a model: no request is invented, so the dossier waits for
 * a person (request_scope_uncertain). Any CRM read is refused before leaving the process. */
export function intakeAutomationAdapters(messageId: string): IntakeAdapters {
  const forbidden = async (): Promise<never> => { throw Error("SAV_INTAKE_AUTOMATION_NO_EXTERNAL_READ"); };
  return { analyseMessage: async () => ({ messageId, requests: [] }), findContactsByEmail: forbidden, directAssociations: forbidden,
    getContact: forbidden, ticketsForContact: forbidden, ticketHistory: forbidden, assessIssues: forbidden };
}
