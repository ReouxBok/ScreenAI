import { redactSavLearningText } from "@/lib/sav/learning-extraction";

/*
 * SAV-92 (harness phase 1): what a knowledge card may contain, field by field, with the reason. Pure: no database, network or clock.
 *
 * Before, every link was refused, so a card could not carry the Academy tutorial or the booking link the agent must give. Now a link is
 * accepted only when it is one of the official destinations below (a constant, reviewed in code, never an environment variable): https,
 * the exact host, no user, no port, no query and no fragment (a redirect or a customer identifier could hide there), and a path under the
 * listed prefix. Every other link, identifier, phone number, technical path, email address, secret or customer label is still refused.
 */
export type SavCardOfficialLink = Readonly<{ host: string; label: string; pathPrefixes: readonly string[]; identifiersInPath: boolean }>;
export const SAV_CARD_OFFICIAL_LINKS: readonly SavCardOfficialLink[] = Object.freeze([
  // Public tutorials: their path names a public tutorial id, not a customer.
  { host: "academy.limova.ai", label: "Limova Academy", pathPrefixes: ["/"], identifiersInPath: true },
  // The application (SAV_CASE_ACCESS_URL host); a path naming a workspace or record id is a customer's, not a procedure's.
  { host: "new.limova.ai", label: "Application Limova", pathPrefixes: ["/"], identifiersInPath: false },
  // Public onboarding and webinar page, already linked by the extension.
  { host: "bienvenue.limova.ai", label: "Page d'accueil et webinaire Limova", pathPrefixes: ["/"], identifiersInPath: false },
  // Limova's own booking page only: a rescheduling or cancellation link of one customer is refused.
  { host: "calendly.com", label: "Prise de rendez-vous Limova", pathPrefixes: ["/d/cszz-77d-g2h/"], identifiersInPath: false },
].map(entry => Object.freeze({ ...entry, pathPrefixes: Object.freeze(entry.pathPrefixes) })));

export type SavCardTextProblemCode = "link_not_allowed" | "identifier" | "phone" | "path" | "email" | "customer_data" | "secret" | "card_number" | "bank_details" | "markup" | "technical";
export type SavCardTextProblem = Readonly<{ code: SavCardTextProblemCode; detail?: string }>;

export const savCardTextProblemLabels: Record<SavCardTextProblemCode, string> = {
  link_not_allowed: "lien hors des domaines officiels autorisés",
  identifier: "identifiant technique (UUID)",
  phone: "numéro de téléphone",
  path: "chemin technique",
  email: "adresse e-mail",
  customer_data: "donnée client (nom, adresse, identifiant)",
  secret: "secret ou jeton",
  card_number: "numéro long (carte, compte)",
  bank_details: "coordonnées bancaires",
  markup: "balise HTML",
  technical: "repère technique (sélecteur, DOM, coordonnées)",
};

export const technicalKnowledgePattern = /(?:querySelector|data-testid|data-test-id|nth-child|testId\s*[:=]|domId\s*[:=]|selector\s*[:=]|sélecteur\s*[:=]|\bDOM\b|\b(?:xpath|css selector)\b|\b(?:coordinates|coordonnées)\s*[:=]|\b[xy]\s*[:=]\s*-?\d|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/)/i;
export const secretAssignmentPattern = /\b(?:bearer|api[_ -]?key|token|password|mot de passe)["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/i;
export const explicitCssSelectorPattern = /\b(?:s[eé]lecteur\s+CSS|CSS\s+selector|class(?:Name)?\s*[:=])/i;

const LINK = /https?:\/\/[^\s<>]+/gi;
const WRAP_END = /[)\]}>»"'”’.,;:!?…]+$/;
const PATH_IDENTIFIER = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{6,}/i;
/** What replaces an official link before the other checks: plain words that no rule reads as data. */
const OFFICIAL_LINK_TOKEN = "lien officiel";

export function officialCardLink(link: string): SavCardOfficialLink | null {
  let url: URL;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
  const entry = SAV_CARD_OFFICIAL_LINKS.find(row => row.host === url.hostname);
  if (!entry || !entry.pathPrefixes.some(prefix => url.pathname === prefix.replace(/\/$/, "") || url.pathname.startsWith(prefix))) return null;
  if (!entry.identifiersInPath && PATH_IDENTIFIER.test(url.pathname)) return null;
  return entry;
}

/** Replace each official link by a neutral token, so the identifiers of a public tutorial path are not read as customer data. */
export function maskOfficialCardLinks(value: string) {
  const rejectedHosts: string[] = [];
  const text = value.replace(LINK, match => {
    const link = match.replace(WRAP_END, ""), rest = match.slice(link.length);
    if (officialCardLink(link)) return OFFICIAL_LINK_TOKEN + rest;
    let host = "";
    try { host = new URL(link).hostname; } catch { /* unreadable: no host shown */ }
    rejectedHosts.push(host || "adresse illisible");
    return match;
  });
  return { text, rejectedHosts };
}

/**
 * Every problem of one text value, each once. The union is exactly the former refusal (`hasUnsafeKnowledgeText`), except that an official
 * link is accepted; each former rule is kept and named here so the author sees why.
 */
export function savCardTextProblems(value: string): SavCardTextProblem[] {
  const { text, rejectedHosts } = maskOfficialCardLinks(value);
  const found = new Map<SavCardTextProblemCode, string | undefined>();
  const add = (code: SavCardTextProblemCode, detail?: string) => { if (!found.has(code)) found.set(code, detail); };
  if (/https?:\/\/[^\s<>]+|\bwww\.\S+/i.test(text)) add("link_not_allowed", [...new Set(rejectedHosts)].join(", ") || "adresse sans https://");
  // The masking rules of learning texts (redactSavLearningText), one by one.
  if (/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.test(text) || /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(text)) add("identifier");
  if (/\b(?:nom|client|customer|adresse|address)\s*:\s*[^\n,;]+/i.test(text) || /^(?:nom du client|client|contact|adresse|identifiant|email)\s*:/i.test(text)) add("customer_data");
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) add("email");
  if (/(?<!\d)(?:\+?33|0)[1-9](?:[ .-]?\d{2}){4}(?!\d)/.test(text) || /\+\d{1,3}(?:[ .-]?\d){7,14}\b/i.test(text)) add("phone");
  if (/\b(?:\d[ -]*?){13,19}\b/.test(text)) add("card_number");
  if (/\b(?:sk|pk|api|token)[-_][A-Za-z0-9_-]{12,}\b/i.test(text) || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(text) || secretAssignmentPattern.test(text)) add("secret");
  if (/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/i.test(text)) add("bank_details");
  if (/<[^>]+>/.test(text)) add("markup");
  if (/(?:^|\s)\/[a-z][a-z0-9/_?=&.-]*(?:\s|$)/i.test(text)) add("path");
  if (/(?:^|[\s('"«])#[a-z][\w-]*|\[(?:data-|aria-)[^\]]+\]|\b(?:document|window)\.[a-z]+|\bjavascript\s*:|\b(?:coordonn[eé]es|coordinates)\s*:?\s*\(?\d+\s*[,;]\s*\d+/i.test(text)
    || technicalKnowledgePattern.test(text) || explicitCssSelectorPattern.test(text)) add("technical");
  // Any other masking rule of learning texts still refuses the value (a rule added there later is never silently skipped here).
  if (!found.size && redactSavLearningText(text) !== text.trim()) add("customer_data");
  return [...found].map(([code, detail]) => detail === undefined ? { code } : { code, detail });
}

export const hasUnsafeSavCardText = (value: string) => savCardTextProblems(value).length > 0;

export function savCardTextProblemMessage(problem: SavCardTextProblem) {
  const label = savCardTextProblemLabels[problem.code];
  if (problem.code !== "link_not_allowed") return `Retirez : ${label}.`;
  const allowed = SAV_CARD_OFFICIAL_LINKS.map(row => `${row.host}${row.pathPrefixes[0] === "/" ? "" : row.pathPrefixes[0]}`).join(", ");
  return `Retirez : ${label}${problem.detail ? ` (${problem.detail})` : ""}. Liens acceptés, en https, sans paramètre ni ancre : ${allowed}.`;
}
