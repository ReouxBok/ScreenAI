import { z } from "zod";
import { canonicalKnowledgeSchema } from "./contracts";

export const HUBSPOT_IMPORT_MAX_BYTES = 800_000;
const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/);
const sourceSchema = z.object({
  emailId: z.string().regex(/^\d+$/),
  url: z.url().refine((value) => new URL(value).protocol === "https:" && /(^|\.)hubspot\.com$/.test(new URL(value).hostname), "HUBSPOT_SOURCE_URL_REQUIRED"),
  date: z.iso.datetime(),
  ticketIds: z.array(z.string().regex(/^\d+$/)).max(100),
}).strict();
export const hubspotImportSchema = z.object({
  schemaVersion: z.literal(1),
  namespace: identifier,
  entries: z.array(z.object({
    externalId: identifier,
    title: z.string().trim().min(3).max(500),
    document: canonicalKnowledgeSchema.refine((document) => document.applicability === "sav_only" && document.steps.length > 0 && document.steps.every((step) => !step.variants.length), "HUBSPOT_SAV_PROCEDURE_REQUIRED"),
    provenance: z.object({
      sources: z.array(sourceSchema).min(1).max(300),
      validationNotes: z.array(z.string().trim().min(1).max(2_000)).max(20),
    }).strict(),
  }).strict().refine((entry) => entry.title === entry.document.objective, "HUBSPOT_COMPETENCE_NAME_MISMATCH")).min(1).max(100),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.entries.map((entry) => entry.externalId)).size !== input.entries.length) ctx.addIssue({ code: "custom", message: "HUBSPOT_DUPLICATE_EXTERNAL_ID", path: ["entries"] });
});
export type HubspotKnowledgeImport = z.infer<typeof hubspotImportSchema>;

/** Terminology changes apply to knowledge, never to provenance or source URLs. */
export function normalizeHubspotKnowledgeText(text: string) {
  return text.replace(/\b(?:la\s+|les\s+)?conversations?\s*(?:\(\s*b[êe]ta\s*\)|b[êe]ta\b)/gi, "Limova 3");
}
function normalizeTextTree(value: unknown): unknown {
  if (typeof value === "string") return normalizeHubspotKnowledgeText(value);
  if (Array.isArray(value)) return value.map(normalizeTextTree);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeTextTree(entry)]));
  return value;
}
export function parseHubspotKnowledgeImport(text: string): HubspotKnowledgeImport {
  if (Buffer.byteLength(text, "utf8") > HUBSPOT_IMPORT_MAX_BYTES) throw new Error("HUBSPOT_IMPORT_TOO_LARGE");
  const input = hubspotImportSchema.parse(JSON.parse(text));
  return hubspotImportSchema.parse({ ...input, entries: input.entries.map((entry) => ({ ...entry,
    title: normalizeHubspotKnowledgeText(entry.title), document: normalizeTextTree(entry.document),
  })) });
}

export type KnowledgeComparisonEntry = { ref: string; title: string; body: string; versionId: string; agentKey: string };
const stopWords = new Set("avec pour dans sans les des une est sur par aux qui que pas plus cette votre vous agent limova puis depuis avant apres dans comme meme afin etre faire tout peut faut doit utiliser etape etapes resultat confirme confirmer ugo sav".split(" "));
const plain = (text: string) => normalizeHubspotKnowledgeText(text).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function terms(text: string) { return new Set(plain(text).split(" ").filter((word) => word.length > 3 && !stopWords.has(word))); }
function overlap(a: Set<string>, b: Set<string>) {
  const shared = [...a].filter((word) => b.has(word)).length;
  return { shared, ratio: shared / Math.max(1, Math.min(a.size, b.size)) };
}
/** Lexical suggestions for human review, not an automatic truth/conflict detector. */
export function compareKnowledge(input: { title: string; body: string }, inventory: KnowledgeComparisonEntry[]) {
  return inventory.flatMap((entry) => {
    const title = overlap(terms(input.title), terms(entry.title));
    const body = overlap(terms(input.body), terms(entry.body));
    const identical = plain(input.body) === plain(entry.body);
    const sameTitle = plain(input.title) === plain(entry.title);
    if (!identical && !sameTitle && !(title.shared >= 2 && title.ratio >= 0.5) && !(body.shared >= 6 && body.ratio >= 0.45)) return [];
    return [{ ...entry, signal: identical ? "duplicate" as const : "related" as const,
      explanation: identical ? "Contenu identique après normalisation : doublon possible." : "Sujet ou procédure proche : vérifier les conditions, les versions et les affirmations contradictoires." }];
  });
}
