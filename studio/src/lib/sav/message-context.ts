import { z } from "zod";

export const SAV_MESSAGE_CONTEXT_REVISION = "sav-message-context-2026-10-06.v1";
const partKind = z.enum(["current", "quoted", "signature"]);
export const savInboundContextSchema = z.object({
  revision: z.literal(SAV_MESSAGE_CONTEXT_REVISION),
  currentText: z.string().max(12_000),
  quotedText: z.string().max(4_000),
  signatureText: z.string().max(2_000),
  parts: z.array(z.object({ kind: partKind, startLine: z.number().int(), endLine: z.number().int() })).max(100),
  language: z.enum(["fr", "en", "unknown"]),
  intents: z.array(z.enum(["account", "billing", "technical", "integration", "how_to", "callback", "commercial", "partnership"])),
  facts: z.array(z.object({ kind: z.enum(["registration_email", "access_count", "callback_availability", "organization"]), excerpt: z.string().max(500), line: z.number().int() })).max(20),
  subjectInherited: z.boolean(),
  truncated: z.boolean(),
});
export type SavInboundContext = z.infer<typeof savInboundContextSchema>;
type Part = { kind: z.infer<typeof partKind>; startLine: number; endLine: number };

const quoteHeader = /^\s*(?:On\s+.{1,500}\s+wrote\s*:|Le\s+.{1,500}\s+a\s+écrit\s*:|[- ]*(?:Original Message|Message d['’]origine|Forwarded message|Message transféré)[- :]*|Begin forwarded message:)\s*$/i;
const replyPrefix = /^\s*(?:re|rép|aw|sv)\s*:/i;
const closing = /^\s*(?:cordialement|bien cordialement|bien à vous|best regards|kind regards|regards)[,.! ]*$/i;

function outlookHistoryStarts(lines: string[], index: number) {
  if (!/^\s*(?:From|De)\s*:/i.test(lines[index])) return false;
  const following = lines.slice(index + 1, index + 9).join("\n");
  return /^\s*(?:Sent|Envoyé|Date)\s*:/im.test(following)
    && /^\s*(?:To|À|A|Subject|Objet)\s*:/im.test(following);
}

/** Derivation only. The complete email remains untouched in encrypted storage. */
export function splitSavMessageText(raw: string) {
  const text = String(raw || "").replace(/\0/g, "").replace(/\r\n?/g, "\n").slice(0, 100_000);
  const lines = text.split("\n");
  const parts: Part[] = [];
  const current: string[] = [], quoted: string[] = [], signature: string[] = [];
  const currentLines: Array<{ text: string; line: number }> = [];
  let section: "current" | "quoted" | "signature" = "current";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (section !== "quoted" && (quoteHeader.test(line) || outlookHistoryStarts(lines, index))) section = "quoted";
    if (section === "current" && current.some(value => value.trim())) {
      const tail = lines.slice(index + 1, index + 13).filter(value => value.trim());
      const shortSignature = tail.length > 0 && tail.every(value => value.length <= 120
        && !/[?]|\b(?:comment|how|je (?:veux|souhaite)|i (?:want|need)|bug|erreur|impossible|résili|cancel)/i.test(value));
      if (/^\s*--\s*$/.test(line) || /^\s*(?:Envoyé de mon|Envoyé depuis|Sent from my)\b/i.test(line)
        || (closing.test(line) && shortSignature && lines.length - index <= 13)) section = "signature";
    }
    const kind = /^\s*>/.test(line) ? "quoted" : section;
    const last = parts.at(-1);
    if (last?.kind === kind) last.endLine = index + 1;
    else parts.push({ kind, startLine: index + 1, endLine: index + 1 });
    if (kind === "current") { current.push(line); currentLines.push({ text: line, line: index + 1 }); }
    else if (kind === "quoted") quoted.push(line);
    else signature.push(line);
  }
  return { currentText: current.join("\n").trim(), quotedText: quoted.join("\n").trim(), signatureText: signature.join("\n").trim(), parts, currentLines };
}

/** A reply subject is historical context, not a new request in the latest body. */
export function savActiveSubject(input: { subject: string; body: string }) {
  return replyPrefix.test(input.subject) && splitSavMessageText(input.body).currentText ? "" : input.subject;
}

export function buildSavInboundContext(input: { subject: string; body: string }): SavInboundContext {
  const split = splitSavMessageText(input.body);
  const body = split.currentText;
  const active = `${savActiveSubject(input)}\n${body}`;
  const english = (body.match(/\b(?:hello|please|thanks|thank|my|need|would|could|cannot|invoice|subscription|account|available)\b/gi) ?? []).length;
  const french = (body.match(/\b(?:bonjour|merci|mon|mes|je|vous|pour|souhaite|facture|abonnement|compte|disponible)\b/gi) ?? []).length;
  const intents: SavInboundContext["intents"] = [];
  for (const [intent, pattern] of [
    ["account", /\b(?:compte|account|accès|access|invitation|invite|connexion|login|utilisateurs?|users?)\b/i],
    ["billing", /\b(?:factures?|invoice|facturation|billing|abonnement|subscription|remboursement|refund)\b/i],
    ["technical", /\b(?:bug|erreur|error|impossible|bloqué|broken|cannot|problème|problem)\b/i],
    ["integration", /\b(?:intégration|integration|connecteur|connector|hubspot|gmail|slack|zapier)\b/i],
    ["how_to", /\b(?:comment|how|où|where)\b/i],
    ["callback", /\b(?:rappel|rappelez|rappeler|rendez-vous|callback|call me|available|disponible)\b/i],
    ["commercial", /\b(?:tarifs?|pricing|devis|quotation|démonstration|demo|commercial|offre|offer)\b/i],
    ["partnership", /\b(?:partenariat|partenaire|partnership|partner|collaboration)\b/i],
  ] as const) if (pattern.test(active)) intents.push(intent);
  const facts: SavInboundContext["facts"] = [];
  for (const line of split.currentLines) {
    for (const [kind, pattern] of [
      ["registration_email", /(?:email|adresse|e-mail|registration|account).{0,60}[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
      ["access_count", /\b\d{1,4}\s+(?:accès|utilisateurs?|users?|seats?|licences?|licenses?|comptes?|accounts?)\b/i],
      ["callback_availability", /(?:disponible|joignable|available|call me|rappele[rz]|rappeler).{0,160}(?:\d|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i],
      ["organization", /(?:^|\b)(?:entreprise|société|company|organisation|organization)\s*[:=]\s*\S/i],
    ] as const) if (pattern.test(line.text) && facts.length < 20) facts.push({ kind, excerpt: line.text.trim().slice(0, 500), line: line.line });
  }
  return savInboundContextSchema.parse({
    revision: SAV_MESSAGE_CONTEXT_REVISION,
    currentText: body.slice(0, 12_000), quotedText: split.quotedText.slice(0, 4_000), signatureText: split.signatureText.slice(0, 2_000),
    parts: split.parts.slice(0, 100), language: english > french ? "en" : french > 0 ? "fr" : "unknown", intents, facts,
    subjectInherited: replyPrefix.test(input.subject),
    truncated: body.length > 12_000 || split.quotedText.length > 4_000 || split.signatureText.length > 2_000 || split.parts.length > 100 || input.body.length > 100_000,
  });
}

/** Conservative non-support identification; an uncertain message stays human-reviewed. */
export function savNonSupportIntent(input: { from: string; subject: string; body: string }) {
  const body = splitSavMessageText(input.body).currentText;
  const address = input.from.match(/<([^>]+)>/)?.[1] ?? input.from;
  if (/@(?:[a-z0-9-]+\.)?mailinblack\.com\s*$/i.test(address)
    && /(?:authentifi|vérifi|verifi|identifi|expéditeur|sender)/i.test(body)) return "sender_verification";
  if (/(?:je vous propose|nous vous proposons|we offer|we provide|our services)[\s\S]{0,160}(?:services?|seo|backlinks|marketing|leads|prospects|visibilité|visibility)/i.test(body)
    && !/\b(?:bug|erreur|error|bloqu[\p{L}]*|broken|impossible)\b/iu.test(body)) return "commercial_solicitation";
  if (/\b(?:partenariat|partnership|collaboration)\b/i.test(body)
    && !/\b(?:bug|erreur|error|bloqu|broken|impossible)\b/i.test(body)) return "partnership";
  if (/(?:vos|your)\s+(?:tarifs?|pricing|prices)|(?:demande|request).{0,20}(?:devis|quotation|demo|démonstration)/i.test(body)
    && !/\b(?:mon|my)\s+(?:compte|account|abonnement|subscription)|\b(?:facture|invoice|bug|erreur|error)\b/i.test(body)) return "presales";
  if (!body && splitSavMessageText(input.body).quotedText) return "quoted_only";
  return null;
}
