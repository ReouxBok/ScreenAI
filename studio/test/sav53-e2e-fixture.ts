import { savStructuredProposalSchema } from "../src/lib/sav/proposal";
import { sav44Understanding } from "./sav44-understanding-fixture";

// Public, synthetic identities and encryption key, for a local PGlite recipe only.
export const SAV53_E2E_KEY = "local-only-sav53-synthetic-fixture-key-2026";
export const SAV53_RECEIVED_AT = "2026-10-02T12:00:00Z";
export const SAV53_THREADS = {
  conversation: "00000053-0000-4000-8000-000000000001",
  reopen: "00000053-0000-4000-8000-000000000002",
  waiting: "00000053-0000-4000-8000-000000000003",
  successor: "00000053-0000-4000-8000-000000000004",
  alreadyNew: "00000053-0000-4000-8000-000000000005",
  partnership: "00000053-0000-4000-8000-000000000006",
  failed: "00000053-0000-4000-8000-000000000007",
  singleQuoted: "00000053-0000-4000-8000-000000000008",
  singlePlain: "00000053-0000-4000-8000-000000000009",
} as const;
export const SAV53_CURRENT = "L’export PDF échoue encore après une nouvelle tentative. Une capture est jointe.";
export const SAV53_QUOTED = "Une ancienne demande citée concernait le nom du document.";
export const SAV53_BODY = `${SAV53_CURRENT}\n\n--\nSignature synthétique à replier\n\nLe 1 octobre 2026, Support a écrit :\n> ${SAV53_QUOTED}`;
export const SAV53_PARTNERSHIP = "Nous souhaitons proposer un partenariat de distribution entre notre société fictive et Limova. Qui peut étudier cette collaboration ?";
export const SAV53_SUBJECT = "Re: Re: Échec export PDF fictif";
export const SAV53_TICKET_TITLE = "Échec export PDF fictif";

export function sav53Proposal(partnership = false) {
  const understanding = sav44Understanding();
  understanding.evidence[0] = { id: "evidence-1", source: "current_message", sourceId: "current_body", excerpt: partnership ? SAV53_PARTNERSHIP : SAV53_CURRENT };
  understanding.uncertainties = [];
  const primary = { ...understanding.requests[0], ...(partnership ? { summary: "Proposer un partenariat de distribution à Limova.", nature: "partnership", product: null, feature: null } : {}) };
  return savStructuredProposalSchema.parse({
    schemaVersion: 1, category: partnership ? "other" : "technical", urgency: "normal",
    decision: { kind: "human_review_required", reasonCode: "synthetic_sav53", explanation: partnership ? "Une proposition de partenariat doit être examinée par Nathan." : "L’export PDF échoue malgré une nouvelle tentative. Le message d’erreur doit être vérifié.", confidence: 0 },
    routing: partnership ? { kind: "none", reason: "partnership_human_review" } : { kind: "new", reason: "fixture_existing_contact", contactId: "995301" },
    ticket: { title: partnership ? "Proposition de partenariat fictive" : SAV53_TICKET_TITLE, description: partnership ? SAV53_PARTNERSHIP : SAV53_CURRENT },
    process: [{ kind: "human_review", label: partnership ? "Examiner le partenariat proposé puis préparer un transfert à Nathan." : "Vérifier le message d’erreur de l’export PDF avant toute action.", sourceIds: [] }],
    internalNote: "Cas synthétique SAV-53. Aucune intégration externe.", replyDraft: null,
    sources: [], knowledgeRevision: "not_consulted", model: "synthetic-sav53-model",
    understanding: { ...understanding, requests: [primary], ...(partnership ? { knownFacts: [], attemptedSteps: [], missingInformation: [] } : {}) },
  });
}
