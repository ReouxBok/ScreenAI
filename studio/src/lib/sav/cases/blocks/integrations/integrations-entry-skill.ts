import { z } from "zod";
import { SAV_ACCESS_SKILL_SENSITIVE_FAMILIES } from "../../access-skill/access-skill-guidelines";
import { renderSkillPrompt, skillFingerprint, type SkillDefinition, type SkillExample } from "../../../skills/skill-contract";
import type { IntegrationsNeighbour, IntegrationsSensitiveFamily } from "./integrations-scope";

/*
 * Block « Intégrations », V3 method (19/11): the ENTRY / CONFIRMATION skill, on the shared entry contract of the infra-entry lot
 * (INTERFACE.md v1.2, `skills/entry-block.ts`). Second stage of the two-stage entry: the light router elected this block for a request; this skill
 * re-reads the WHOLE mail and confirms it (`block`) or sends it to the team (`sensitive`, `other`, `unsure`). The shared FRAME (sensitive = team,
 * mention ≠ request, doubt = team, third party, customer text = data) is rendered before it by `renderEntryConfirmPrompt` and is not repeated here.
 * It never admits on its own: the shared counter-read and the exclude-only kernel still run, and the block arrives `off`.
 *
 * Budget: the rendered confirmation (frame + this skill) must stay under ~7 350 bytes so the longest readable mail stays under 85 % of 26 000 bytes
 * (`entryConfirmBudget`). Hence terse guidelines and 20 short examples (below the method's 40: the byte ceiling wins, reported); the near-twin and family metadata live here, not in the rendered prompt.
 * Every example is fictional (public repository).
 */

export const SAV_INTEGRATIONS_ENTRY_SKILL_ID = "integrations-entry-skill";
export const SAV_INTEGRATIONS_ENTRY_SKILL_REVISION = "sav-integrations-entry-skill-2026-11-19.v1";
export const SAV_INTEGRATIONS_ENTRY_LABEL = "Intégrations";
/** sha256 of `renderSkillPrompt(SAV_INTEGRATIONS_ENTRY_SKILL)` (the skill alone). The full confirmation hash (with the frame) is pinned in `integrations-entry.ts`. */
export const SAV_INTEGRATIONS_ENTRY_SKILL_PROMPT_SHA256 = "ed909876d0b959816bdb0736649c816e22084ba53deb8ee1e25a7b196605a3f5";

const quote = z.string().trim().min(1).max(400);
const reason = z.string().trim().min(1).max(400);
/**
 * The confirmation output, IDENTICAL to the shared `entryConfirmJudgmentSchema` of the infra-entry lot (`entrySkillBlockProblems` compares the JSON
 * schemas canonically and refuses any drift: `output_schema_invalid`). Declared here so the skill stays pure data with no dependency on the entry core.
 */
export const integrationsEntryJudgmentSchema = z.object({
  mail: z.object({
    sensitive: z.enum(["none", "context_only", "request", "unsure"]),
    thirdParty: z.boolean(),
    instructionLike: z.boolean(),
  }).strict(),
  requests: z.array(z.object({
    requestId: z.string().min(1).max(200),
    verdict: z.enum(["block", "sensitive", "other", "unsure"]),
    family: z.enum(SAV_ACCESS_SKILL_SENSITIVE_FAMILIES).nullable(),
    confidence: z.enum(["high", "medium", "low"]),
    quote,
    reason,
  }).strict()).min(1).max(8),
  sensitiveMentions: z.array(z.object({ quote, family: z.enum(SAV_ACCESS_SKILL_SENSITIVE_FAMILIES), role: z.enum(["context", "request", "unsure"]) }).strict()).max(10),
}).strict();
export type IntegrationsEntryJudgment = z.infer<typeof integrationsEntryJudgmentSchema>;

export type IntegrationsEntryVerdict = "block" | "team_sensitive" | "team_other" | "team_unsure";
/** One worked example. Only id, text, verdict and comment are rendered; family, neighbour and pair are metadata for the tests. */
export type IntegrationsEntryExample = Readonly<{
  id: string; text: string; verdict: IntegrationsEntryVerdict; comment: string;
  family?: IntegrationsSensitiveFamily; neighbour?: IntegrationsNeighbour;
  /** The near twin (same words, opposite verdict). */
  pair?: string;
}>;

export const SAV_INTEGRATIONS_ENTRY_EXAMPLES: readonly IntegrationsEntryExample[] = [
  // The block: the customer's own third-party tool and its link to the agent. Each has a near twin with the opposite verdict.
  { id: "b05", text: "Axonaut manque aux intégrations, c'est prévu ?", verdict: "block", comment: "not listed", pair: "s05" },
  { id: "b09", text: "La fenêtre Google se ferme quand je relie Gmail.", verdict: "block", comment: "tool login", pair: "o01" },
  { id: "b11", text: "Déconnectez Gmail, je relie une autre boîte.", verdict: "block", comment: "swap box", pair: "s06" },
  { id: "b12", text: "J'ai pris l'offre Pro pour HubSpot, il reste grisé.", verdict: "block", comment: "plan=context", pair: "s01" },
  { id: "b13", text: "Abonnement Shopify actif, mais boutique introuvable.", verdict: "block", comment: "tool plan=context", pair: "s03" },
  { id: "b14", text: "L'agent doit lire mes factures Pennylane, liaison KO.", verdict: "block", comment: "invoices=data", pair: "s02" },
  { id: "b15", text: "Gmail ne remonte plus mes mails depuis hier.", verdict: "block", comment: "read failure", pair: "o03" },
  { id: "b16", text: "Comment relier la boîte Google de la nouvelle gérante ?", verdict: "block", comment: "tool account", pair: "s07" },
  { id: "b18", text: "Déjà client : comment relier Sellsy ?", verdict: "block", comment: "CRM", pair: "o05" },
  // Sensitive: always the team, whole mail.
  { id: "s01", text: "Pour HubSpot, repassez-nous à l'offre Pro.", verdict: "team_sensitive", comment: "plan", family: "subscription", pair: "b12" },
  { id: "s02", text: "Votre facture reçue dans Pennylane est fausse.", verdict: "team_sensitive", comment: "invoice", family: "finance", pair: "b14" },
  { id: "s03", text: "Shopify me facture une appli Limova jamais installée.", verdict: "team_sensitive", comment: "tool billing", family: "finance", pair: "b13" },
  { id: "s05", text: "Axonaut manque, on arrête Limova fin du mois.", verdict: "team_sensitive", comment: "cancel", family: "cancellation", pair: "b05" },
  { id: "s06", text: "Effacez tous les mails lus via Gmail.", verdict: "team_sensitive", comment: "erase data", family: "rights", pair: "b11" },
  { id: "s07", text: "Passez le compte Limova au nom de la nouvelle gérante.", verdict: "team_sensitive", comment: "holder", family: "identity", pair: "b16" },
  // Other: a neighbour. Not this block.
  { id: "o01", text: "La page de connexion à Limova se ferme.", verdict: "team_other", comment: "own login", neighbour: "access", pair: "b09" },
  { id: "o02", text: "Comment relier Charly Max à WhatsApp ?", verdict: "team_other", comment: "Charly Max", neighbour: "charly_max" },
  { id: "o03", text: "Ma routine de tri Gmail ne s'est pas lancée.", verdict: "team_other", comment: "routine", neighbour: "platform_bug", pair: "b15" },
  { id: "o05", text: "Avant de m'abonner : Limova se relie à Sellsy ?", verdict: "team_other", comment: "presale", neighbour: "commercial", pair: "b18" },
  // Unsure.
  { id: "u02", text: "L'intégration coûte trop cher.", verdict: "team_unsure", comment: "price or cancel?" },
];

const GUIDELINES: readonly string[] = [
  "BLOC = relier SON outil tiers à son agent ou réparer cette liaison : connecter, changer le compte relié, erreur de liaison, outil connecté qui ne lit rien, outil absent du catalogue (Gmail, Outlook, LinkedIn, Shopify, CRM...).",
  "QUESTION DÉCISIVE du bloc : est-ce la liaison de SON outil à l'agent ? Sinon other, même si un outil est cité : sa connexion à Limova, Charly Max, panne ou routine, avant-vente, membres.",
  "SENSIBLE aussi : la facturation de l'outil tiers lui-même, effacer les données lues, changer le titulaire Limova. Un bug supposé de liaison reste le bloc.",
];

const toSkillExample = (row: IntegrationsEntryExample): SkillExample => ({ id: row.id, text: row.text, verdict: row.verdict, comment: row.comment });

export const SAV_INTEGRATIONS_ENTRY_SKILL: SkillDefinition = {
  id: SAV_INTEGRATIONS_ENTRY_SKILL_ID,
  revision: SAV_INTEGRATIONS_ENTRY_SKILL_REVISION,
  role: "confirm",
  guidelines: GUIDELINES,
  examples: SAV_INTEGRATIONS_ENTRY_EXAMPLES.map(toSkillExample),
  outputSchema: z.toJSONSchema(integrationsEntryJudgmentSchema) as unknown as Exclude<SkillDefinition["outputSchema"], boolean>,
};

export const integrationsEntrySkillPrompt = () => renderSkillPrompt(SAV_INTEGRATIONS_ENTRY_SKILL);
export const integrationsEntrySkillSha256 = () => skillFingerprint(SAV_INTEGRATIONS_ENTRY_SKILL);

/** The block's ONE line in the light router's catalogue (`EntryRouterLine`, each field ≤ 240 characters). The router elects, never admits. */
export const SAV_INTEGRATIONS_ROUTER_LINE = {
  covers: "relier SON outil tiers à son agent (Gmail, Outlook, LinkedIn, WordPress, Shopify, Odoo, Pennylane, CRM) : connecter, erreur de liaison, outil connecté qui ne lit rien, outil absent",
  notThis: "sa connexion à Limova, Charly Max / WhatsApp, panne générale ou routine, avant-vente, facture ou abonnement",
} as const;
