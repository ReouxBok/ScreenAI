import type { IntakeAdapters, IntakeMessage } from "./engine-types";

export const SAV_INTAKE_AUTOMATION_REVISION = "sav-intake-automation-gate.v2";

// Only entire self-contained notices qualify. A second sentence about a
// callback, an account, an invoice, etc. goes through ordinary analysis.
const month = "(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)";
const date = `(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|demain|(?:le )?\\d{1,2}(?: ${month})(?: \\d{4})?)`;
const simpleNotice = new RegExp(`^(?:réponse automatique\\s*:\\s*)?(?:(?:je suis (?:actuellement )?(?:absent(?:e)?|en congés?)(?: jusqu['’]au ${date})?)|(?:nous avons (?:bien )?reçu votre (?:mail|message|demande))|(?:merci pour votre (?:mail|message))|(?:I am (?:currently )?out of (?:the )?office))\\s*[.!]?$`, "iu");
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
  supportMessageIds: readonly string[]; bodyText?: string; subject?: string }): IntakeAutomation | null {
  const { message, headers } = input;
  // Information added by a person asks for the normal path.
  if (message.direction !== "inbound" || message.operatorInformation || !headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const header = (name: string) => { const value = (headers as Record<string, unknown>)[name]; return typeof value === "string" ? value.trim() : ""; };
  if (header("x-studio-automation-headers") !== "singleton-v1") return null;
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
  // A forward or a separately authored subject may be the actual request even
  // when its short body happens to look exactly like an absence message.
  if (input.subject !== undefined && !/^\s*(?:(?:re|rép|aw|sv|réponse automatique|automatic reply)\s*:|(?:absence|out of office)\s*$)/iu.test(input.subject)) return null;
  if (header("x-studio-automation-body") !== "complete-plain-v1" || !message.contentComplete || !simpleNotice.test((input.bodyText ?? message.currentText).trim())) return null;
  // RFC 3834: one keyword, optional parameters. A list or an unknown keyword is ambiguous.
  if (inReplyTo.length !== 1 || header("in-reply-to").trim() !== inReplyTo[0]) return null;
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
