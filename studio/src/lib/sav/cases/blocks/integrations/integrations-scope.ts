import type { CorpusCase, CorpusLabel, RequestRoute } from "../../../skills/corpus-contract";

/*
 * Block « Intégrations » (V3 method, 19/11): the scope shared by its skills, corpus, blind set and manifest. PURE data (no server-only import,
 * no network, database or clock). Nothing here is wired: the block is `off` and no admission reads this file.
 *
 * The scope is the connection of a THIRD-PARTY tool to the customer's Limova agent: connect, reconnect, an error while connecting, a tool that
 * shows « connected » but reads nothing, a permission error (403) of the tool, or a tool missing from the catalogue. It is not the customer's own
 * login to Limova (Access), not Charly Max on WhatsApp, not a platform bug or a routine that does not run, not a sales question.
 *
 * Fictional data only (public repository). No knowledge id or version lives here: they are mapped by root, privately, before any draft mode.
 */

export const SAV_INTEGRATIONS_BLOCK_ID = "integrations";

/** Sub-families. PR #275 listed 12; the CRMs (2nd most cited integration in the N1 sample) were missing; WhatsApp moved to the Charly Max neighbour. */
export const SAV_INTEGRATIONS_SUBFAMILIES = [
  "gmail_google", "outlook_microsoft", "mail_other", "linkedin", "facebook_instagram", "google_business",
  "wordpress", "webflow_wix", "shopify", "odoo", "pennylane", "dougs", "crm", "unlisted_tool", "unknown_tool",
] as const;
export type IntegrationsSubfamily = typeof SAV_INTEGRATIONS_SUBFAMILIES[number];

/** The tools named in each sub-family (for the prompts and the reports). Names only, never a procedure. */
export const SAV_INTEGRATIONS_SUBFAMILY_TOOLS: Readonly<Record<IntegrationsSubfamily, readonly string[]>> = {
  gmail_google: ["Gmail", "Google Agenda", "Google Drive", "Google Sheets", "Google Contacts"],
  outlook_microsoft: ["Outlook", "calendrier Outlook", "Microsoft 365", "OneDrive"],
  mail_other: ["OVH", "IONOS", "Orange", "Zoho Mail", "autre messagerie IMAP"],
  linkedin: ["LinkedIn"],
  facebook_instagram: ["Facebook", "Instagram"],
  google_business: ["fiche d'établissement Google", "avis Google"],
  wordpress: ["WordPress"],
  webflow_wix: ["Webflow", "Wix"],
  shopify: ["Shopify"],
  odoo: ["Odoo"],
  pennylane: ["Pennylane"],
  dougs: ["Dougs"],
  crm: ["Brevo", "Axonaut", "Sellsy", "Act!", "HubSpot", "autre CRM"],
  unlisted_tool: ["outil absent du catalogue (demande d'ajout)"],
  unknown_tool: ["outil non nommé"],
};

/** What the customer asks about the tool's connection. */
export const SAV_INTEGRATIONS_NEEDS = ["connection_setup", "reconnection", "connection_error", "read_failure_while_connected", "permission_error", "tool_not_listed"] as const;
export type IntegrationsNeed = typeof SAV_INTEGRATIONS_NEEDS[number];

/** Neighbours this block never takes. `access` is a live block; the others are the team today (or a future block, see INTERFACE). */
export const SAV_INTEGRATIONS_NEIGHBOURS = ["access", "charly_max", "platform_bug", "commercial", "collaborators", "developer_api", "other_usage"] as const;
export type IntegrationsNeighbour = typeof SAV_INTEGRATIONS_NEIGHBOURS[number];

/** Always human, for every block (permanent product rule), plus the third-party tool's own billing (Ugo's brief, 19/11). */
export const SAV_INTEGRATIONS_SENSITIVE_FAMILIES = ["cancellation", "subscription", "finance", "rights", "identity"] as const;
export type IntegrationsSensitiveFamily = typeof SAV_INTEGRATIONS_SENSITIVE_FAMILIES[number];

export const SAV_INTEGRATIONS_CORPUS_TRAITS = [
  "typo", "english", "forwarded", "signature_ps", "sensitive_ps", "old_subject", "return", "negation", "injection", "error_paste", "long_cut",
] as const;
export type IntegrationsCorpusTrait = typeof SAV_INTEGRATIONS_CORPUS_TRAITS[number];

export type IntegrationsDecision = "answer" | "ask" | "orient" | "handoff";

/** One labelled fictional mail. `requests[].expected` is what the whole entry chain must conclude; the rest is ground truth for reports. */
export type IntegrationsCorpusCase = CorpusCase & Readonly<{
  subfamily: IntegrationsSubfamily | null;
  need: IntegrationsNeed | null;
  neighbour: IntegrationsNeighbour | null;
  sensitiveFamily: IntegrationsSensitiveFamily | null;
  traits: readonly IntegrationsCorpusTrait[];
  purpose: "first_mail" | "return";
  /** The id of the near twin (same words, opposite verdict), in the same set. */
  pair: string | null;
  /** For a mail the block takes: what the decision skill should do with today's knowledge map (annotation, not an admission). */
  expectedDecision: IntegrationsDecision | null;
}>;

export const INTEGRATIONS_ROUTE: RequestRoute = { kind: "block", blockId: SAV_INTEGRATIONS_BLOCK_ID };
export const TEAM_ROUTE: RequestRoute = { kind: "team" };
export const SENSITIVE_LABEL: CorpusLabel = { kind: "sensitive" };

/**
 * The route a neighbour's request must take. Only Access is a live block today; the other neighbours go to the team until their block exists
 * and is active (re-label the corpus then: INTERFACE.md of the infra-entry lot names the block ids).
 */
export function integrationsNeighbourRoute(neighbour: IntegrationsNeighbour): RequestRoute {
  return neighbour === "access" ? { kind: "block", blockId: "access" } : TEAM_ROUTE;
}
