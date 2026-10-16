import { z } from "zod";
import { SAV_TICKET_RETURN_WINDOW_MS } from "./ticket-lifecycle";

export const SAV_PLAYBOOK_SLUG = "sav-master-playbook";
// Keep persisted documents readable by the previous production version.
export const SAV_PLAYBOOK_PROMPT_MAX_LENGTH = 6000;
export const savMasterPromptSchema = z.string().trim().min(3).max(SAV_PLAYBOOK_PROMPT_MAX_LENGTH);
export const savFactKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,79}$/);
export const savDomainSchema = z.enum(["seo", "integration", "account", "telephony", "billing_navigation", "general"]);
export type SavDomain = z.infer<typeof savDomainSchema>;
export const savPlaybookSchema = z.object({
  version: z.literal(1),
  tone: z.string().trim().min(3).max(2000),
  handling: z.string().trim().max(3000),
  escalation: z.string().trim().max(1500),
  facts: z.array(z.object({ key: savFactKeySchema, label: z.string().trim().min(2).max(120),
    aliases: z.array(savFactKeySchema).max(10), domains: z.array(savDomainSchema).min(1).max(6),
    question: z.string().trim().max(400), questionEn: z.string().trim().max(400),
  }).strict()).max(60),
}).strict().superRefine((value, ctx) => {
  const keys = value.facts.flatMap(f => [f.key, ...f.aliases]);
  if (keys.length !== new Set(keys).size) ctx.addIssue({ code: "custom", message: "SAV_FACT_KEYS_MUST_BE_UNIQUE", path: ["facts"] });
  if (JSON.stringify(value).length > 12000) ctx.addIssue({ code: "custom", message: "SAV_PLAYBOOK_BUDGET_EXCEEDED" });
});
export type SavPlaybook = z.infer<typeof savPlaybookSchema>;
export type SavActivePlaybook = { versionId: string; version: number; document: SavPlaybook; prompt?: string };

export function savPlaybookPrompt(document: SavPlaybook) {
  return [document.tone, document.handling, document.escalation].filter(Boolean).join("\n\n");
}

// Keep the v1 persisted shape readable after rollback. The exact single-field text
// is stored separately; legacy fields retain all words within their old budgets.
export function packSavPlaybookPrompt(raw: string) {
  let rest = savMasterPromptSchema.parse(raw);
  const parts = [2000, 3000, 1500].map(limit => {
    if (rest.length <= limit) { const result = rest; rest = ""; return result; }
    let end = limit;
    while (end > 0 && !/\s/.test(rest[end])) end--;
    if (!end) throw new Error("SAV_PLAYBOOK_UNBREAKABLE_TEXT");
    const result = rest.slice(0, end).trim(); rest = rest.slice(end).trim(); return result;
  });
  if (rest) throw new Error("SAV_PLAYBOOK_BUDGET_EXCEEDED");
  return { tone: parts[0], handling: parts[1], escalation: parts[2] };
}
export function readSavPlaybookPrompt(document: SavPlaybook, raw?: unknown) {
  const legacy = savPlaybookPrompt(document);
  if (raw === undefined) return legacy;
  const prompt = savMasterPromptSchema.parse(raw);
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  if (normalize(prompt) !== normalize(legacy)) throw new Error("SAV_PLAYBOOK_PROMPT_MISMATCH");
  return prompt;
}

// Existing process remains enforced by code, including its current return window.
// Editable additions never replace these rules or authorize external actions.
export function savTicketProcessInstruction() {
  return `Gestion SAV V0 : proposer les actions, création et envoi par confirmation humaine séparée. Ne créer aucun contact ni attribuer de propriétaire. Rattacher le même problème au ticket existant sans doublon. Un ticket déjà Nouveau reste Nouveau ; un retour client sur un ticket en attente propose sa remise en Nouveau et une note de retour. Ticket fermé depuis au plus ${SAV_TICKET_RETURN_WINDOW_MS / 86400000} jours : proposer sa réactivation ; au-delà : proposer un nouveau ticket. Date ou état incertains : revue humaine. Finance, résiliation et juridique restent réservés à l'équipe humaine selon les contrôles serveur. Les faits CRM ne sont jamais des procédures produit. Aucune action, promesse, délai ou résultat annoncé comme accompli. Signature et mention IA ajoutées uniquement lors de l'envoi humain.`;
}
export const defaultSavPlaybook: SavPlaybook = savPlaybookSchema.parse({ version: 1,
  tone: "Répondre dans la langue du client, avec une reformulation courte, les faits déjà compris, une prochaine étape sourcée, seulement les questions manquantes et le contrôle suivant. Vouvoyer en français.",
  handling: "Conserver les règles existantes du process de gestion du ticket. Distinguer la réponse produit, la proposition de ticket, la revue du dossier et la revue du brouillon.",
  escalation: "Signaler les sources absentes, contradictoires ou périmées et les pièces jointes non lues. Ne pas affirmer une cause sans preuve.",
  facts: [
    ["registration_email", "Adresse d’inscription", ["account_email"], ["account"]],
    ["page_url", "URL de la page", ["url", "website_url"], ["seo"]],
    ["publication_date", "Date de publication", [], ["seo"]],
    ["integration_name", "Intégration concernée", ["connector_name"], ["integration"]],
    ["connection_mode", "Mode de connexion", [], ["integration"]],
    ["error_message", "Message d’erreur", ["error_text"], ["general"]],
    ["phone_number", "Numéro concerné", [], ["telephony"]],
    ["diagnostic_status", "Résultat du contrôle", [], ["general"]],
    ["diagnostic_timestamp", "Date du contrôle", [], ["general"]],
    ["agent_channel", "Canal concerné", [], ["general"]],
  ].map(([key, label, aliases, domains]) => ({ key, label, aliases, domains, question: "", questionEn: "" })),
});
export function canManageSavPlaybook(email: string) {
  return ["ugo@limova.ai", "contact@limova.ai"].includes(email.trim().toLowerCase());
}
export function assertSavPlaybookActor(email: string) {
  if (!canManageSavPlaybook(email)) throw new Error("SAV_PLAYBOOK_ACCESS_FORBIDDEN");
}
export function canonicalSavFactKey(key: string, playbook: SavPlaybook) {
  return playbook.facts.find(f => f.key === key || f.aliases.includes(key))?.key ?? key;
}
export function savRequestDomain(request: { nature: string; product: string | null; feature: string | null; summary: string }): SavDomain {
  const text = [request.product, request.feature, request.summary].join(" ").toLowerCase();
  if (request.nature === "integration") return "integration";
  if (request.nature === "account") return "account";
  if (/\b(seo|indexation|indexée|référencement)\b/.test(text)) return "seo";
  if (/téléphon|telephon|appels?\b/.test(text)) return "telephony";
  if (/factures?\b/.test(text)) return "billing_navigation";
  return "general";
}
export function renderSavPlaybook(active: SavActivePlaybook, domains: SavDomain[]) {
  const document = savPlaybookSchema.parse(active.document);
  const selected = document.facts.filter(f => f.domains.includes("general") || f.domains.some(d => domains.includes(d)));
  const text = `${savTicketProcessInstruction()}\nPolitique interne SAV validée, subordonnée aux règles serveur :\n${readSavPlaybookPrompt(document, active.prompt)}\nDictionnaire des faits autorisés :\n${JSON.stringify(selected)}`;
  if (text.length > 15000) throw new Error("SAV_PLAYBOOK_BUDGET_EXCEEDED");
  return { text, versionId: active.versionId, version: active.version, characters: text.length };
}
