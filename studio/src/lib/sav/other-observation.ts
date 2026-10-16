import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";

/** Candidate discovery only. This module grants no routing/reply permission. */
export const savOtherFamilies = {
  trustpilot_positive: { sender: "noreply.notifications@trustpilot.com", label: "Avis Trustpilot 5 étoiles" },
  vistaprint_promotions: { sender: "vistaprint@mail.vistaprint.fr", label: "Promotions Vistaprint" },
  datarevolution_prospecting: { sender: "contact@datarevolution.biz", label: "Prospection DataRevolution" },
  own_campaign_copy: { sender: "hello@limova.ai", label: "Copies de campagnes Limova" },
} as const;
const familySchema = z.enum(["trustpilot_positive", "vistaprint_promotions", "datarevolution_prospecting", "own_campaign_copy"]);
export type SavOtherFamily = z.infer<typeof familySchema>;
const registrySchema = z.object({
  version: z.literal(1),
  rules: z.array(z.object({
    family: familySchema,
    mailboxId: z.uuid(),
    subjectSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100),
  }).strict()).min(1).max(40),
}).strict();
export type SavOtherRegistry = z.infer<typeof registrySchema>;
export type SavOtherConfiguration = {
  status: "not_configured" | "invalid" | "configured";
  registry: SavOtherRegistry | null;
};
export type SavOtherObservation = {
  family: SavOtherFamily;
  label: string;
  ruleVersion: "sav-other-observation-v1";
};
const observedBodySchema = z.object({
  text: z.string().min(1).max(99_999),
  headers: z.record(z.string(), z.string().max(2_000)),
  attachments: z.array(z.unknown()).optional(),
}).passthrough();

/** Server-only private registry. Never log its contents or expose its hashes. */
export function readSavOtherConfiguration(raw = process.env.SAV_OTHER_OBSERVATION_RULES_JSON): SavOtherConfiguration {
  if (!raw) return { status: "not_configured", registry: null };
  if (raw.length > 350_000) return { status: "invalid", registry: null };
  try {
    const registry = registrySchema.parse(JSON.parse(raw));
    // Conflicting definitions cannot be resolved by ordering the configuration.
    const keys = registry.rules.map(rule => `${rule.mailboxId}:${rule.family}`);
    if (new Set(keys).size !== keys.length) return { status: "invalid", registry: null };
    return { status: "configured", registry };
  } catch { return { status: "invalid", registry: null }; }
}

export function savOtherSubjectHash(subject: string) {
  // Exact subject after line-ending normalization only: no keyword/fuzzy match.
  return createHash("sha256").update(subject.replace(/\r\n?/g, "\n")).digest("hex");
}

export function observeSavOther(input: {
  mailboxId: string; fromEmail: string; subject: string; gmailMessageId: string | null;
  body: { text: string; headers?: Record<string, string>; attachments?: unknown[] } | null;
  protectedContext: boolean;
}, registry: SavOtherRegistry | null): SavOtherObservation | null {
  if (!registry || input.protectedContext || !input.gmailMessageId) return null;
  const parsed = observedBodySchema.safeParse(input.body);
  if (!parsed.success || !parsed.data.text.trim()) return null;
  const body = parsed.data;
  const headerEntries = Object.entries(body.headers).map(([name, value]) => [name.toLowerCase(), value] as const);
  const headers = new Map(headerEntries);
  if (headers.size !== headerEntries.length) return null;
  // Missing historical evidence is unknown, not proof of an original message.
  if (!["in-reply-to", "references", "content-type", "message-id"].every(name => headers.has(name))) return null;
  if (!headers.get("message-id")?.trim() || !headers.get("content-type")?.trim()) return null;
  if (headers.get("in-reply-to")?.trim() || headers.get("references")?.trim()) return null;
  if (headers.get("auto-submitted")?.trim().toLowerCase() === "auto-replied") return null;
  if (/\b(?:multipart\/(?:report|mixed)|message\/rfc822|delivery-status)\b/i.test(headers.get("content-type") || "") || body.attachments?.length) return null;
  if (/^\s*(?:(?:re|fw|fwd|tr|rép)\s*(?:\[\d+\])?\s*:|réponse\b|transfert\b)/iu.test(input.subject)) return null;
  // Vetoes only: never use these words to authorize a noise classification.
  if (/(?:^-{2,}\s*(?:original|forwarded|message transféré)|^\s*>|^\s*(?:de|from|objet|subject)\s*:|a écrit\s*:|wrote\s*:)/imu.test(body.text)) return null;
  if (/(?:remboursement|refund|litige|impayé|résiliation|réclamation|fraude|phishing|déconnecté|disconnected|mot de passe|password|connexion suspecte|delivery failure|undeliverable)/iu.test(`${input.subject}\n${body.text}`)) return null;
  const sender = input.fromEmail.trim().toLowerCase();
  const subjectHash = savOtherSubjectHash(input.subject);
  const matches = registry.rules.filter(rule => rule.mailboxId === input.mailboxId
    && savOtherFamilies[rule.family].sender === sender && rule.subjectSha256.includes(subjectHash));
  if (matches.length !== 1) return null;
  const family = matches[0].family;
  if (family === "trustpilot_positive" && !/5[\s-]*(?:étoiles?|stars?)/iu.test(input.subject)) return null;
  // Subject/sender matches are still unverified: body templates and trusted
  // authentication evidence have NOT been qualified. Never hide this message.
  return { family, label: savOtherFamilies[family].label, ruleVersion: "sav-other-observation-v1" };
}
