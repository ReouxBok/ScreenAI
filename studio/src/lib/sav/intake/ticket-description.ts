import { splitSavMessageText } from "../message-context";
import { intakeHtmlOwnPart } from "./html-message";

/** HubSpot caps a ticket property near 65 536 characters; the marker and notices need room. */
export const SAV_INTAKE_DESCRIPTION_MAX_BODY = 60_000;
const named: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", agrave: "à", acirc: "â", auml: "ä", ccedil: "ç", icirc: "î", iuml: "ï",
  ocirc: "ô", ouml: "ö", ugrave: "ù", ucirc: "û", uuml: "ü", oelig: "œ", aelig: "æ", Eacute: "É", Egrave: "È", Ecirc: "Ê",
  Agrave: "À", Acirc: "Â", Ccedil: "Ç", Ocirc: "Ô", Ucirc: "Û", Icirc: "Î", OElig: "Œ", rsquo: "’", lsquo: "‘", ldquo: "“",
  rdquo: "”", laquo: "«", raquo: "»", hellip: "…", ndash: "–", mdash: "—", euro: "€" };
/** One pass, so an encoded "&amp;eacute;" stays the literal text "&eacute;". */
function decodeEntities(text: string) {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (all, name: string) => {
    if (name[0] !== "#") return named[name] ?? all;
    const point = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : all;
  });
}
const tidy = (text: string) => decodeEntities(text).normalize("NFC").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();

/** SAV-72: the description of a ticket created from an email is the incoming email
 * itself, derived deterministically from the stored source. No model text, no
 * summary. Quoted history and an incomplete source are named, never rebuilt. */
export function intakeTicketDescription(input: { subject: string; text: string; unreadAttachmentNotice?: string | null }) {
  const raw = String(input.text ?? ""), html = intakeHtmlOwnPart(raw);
  const split = splitSavMessageText(html?.text ?? raw);
  const subject = tidy(input.subject.replace(/[\r\n]+/g, " "));
  let body = [split.currentText, split.signatureText].map(tidy).filter(Boolean).join("\n\n");
  const notices: string[] = [];
  if (!body) notices.push("[Email sans texte dans le corps : seul l'objet a été reçu.]");
  if (body.length > SAV_INTAKE_DESCRIPTION_MAX_BODY) {
    notices.push(`[Message coupé à ${SAV_INTAKE_DESCRIPTION_MAX_BODY} caractères sur ${body.length} : l'email complet est associé au ticket.]`);
    body = body.slice(0, SAV_INTAKE_DESCRIPTION_MAX_BODY);
  }
  if (raw.length >= 100_000 || html?.unclosed) notices.push("[Source reçue incomplète : le texte ci-dessus n'a pas été complété.]");
  if (split.quotedText || html?.quoted) notices.push("[Historique cité non recopié : il reste dans l'email associé au ticket.]");
  if (input.unreadAttachmentNotice) notices.push(input.unreadAttachmentNotice);
  return [subject ? `Objet : ${subject}` : "", body, notices.join("\n")].filter(Boolean).join("\n\n");
}

const unreadNotice = /\n\n((?:1 pièce jointe non lue|\d+ pièces jointes non lues) par l'agent, à vérifier\.)$/;
/** The planner appends this deterministic notice to its summary; it is kept, the summary is not. */
export function intakeUnreadAttachmentNotice(plannedDescription: string) {
  return unreadNotice.exec(plannedDescription)?.[1] ?? null;
}
