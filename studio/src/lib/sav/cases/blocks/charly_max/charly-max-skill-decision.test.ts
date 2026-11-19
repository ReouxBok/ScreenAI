import { describe, expect, it } from "vitest";
import { lintCorpus } from "../../../skills/corpus-lint";
import { skillFingerprint } from "../../../skills/skill-contract";
import {
  CHARLY_MAX_DECISION_EXAMPLES, CHARLY_MAX_DECISION_SKILL, CHARLY_MAX_DECISION_SKILL_PROMPT_SHA256, CHARLY_MAX_DECISION_SKILL_REVISION,
  charlyMaxDecisionGuard, charlyMaxDecisionSchema, charlyMaxDecisionSkillPrompt, charlyMaxDecisionSkillSha256, type CharlyMaxDecisionContext,
} from "./charly-max-skill-decision";

describe("Charly Max, skill de décision : révision et exemples", () => {
  it("l'empreinte épinglée est celle du prompt rendu", () => {
    expect(charlyMaxDecisionSkillSha256()).toBe(CHARLY_MAX_DECISION_SKILL_PROMPT_SHA256);
    expect(skillFingerprint(CHARLY_MAX_DECISION_SKILL)).toBe("00c1ffe0375d6dae440453096727cfbfb6d59b33bd59e876e2cb5c943e509acd");
    expect(CHARLY_MAX_DECISION_SKILL_REVISION).toBe("sav-charly_max-decision-skill-2026-11-19.v1");
    expect(CHARLY_MAX_DECISION_SKILL.role).toBe("decision");
  });
  it("40 à 60 exemples fictifs, chaque action et les règles d'écriture représentées", () => {
    expect(CHARLY_MAX_DECISION_EXAMPLES.length).toBeGreaterThanOrEqual(40);
    expect(CHARLY_MAX_DECISION_EXAMPLES.length).toBeLessThanOrEqual(60);
    expect(new Set(CHARLY_MAX_DECISION_EXAMPLES.map(row => row.id)).size).toBe(CHARLY_MAX_DECISION_EXAMPLES.length);
    for (const action of ["reply_first_connection", "ask_incident_evidence", "handoff"]) {
      expect(CHARLY_MAX_DECISION_EXAMPLES.some(row => row.decision.startsWith(action)), action).toBe(true);
    }
    expect(CHARLY_MAX_DECISION_EXAMPLES.filter(row => row.decision.startsWith("REFUSÉ")).length).toBeGreaterThanOrEqual(5);
    for (const row of CHARLY_MAX_DECISION_EXAMPLES.filter(example => example.pair)) {
      expect(CHARLY_MAX_DECISION_EXAMPLES.find(example => example.id === row.pair), row.id).toBeDefined();
    }
    const issues = lintCorpus({ cases: [], examples: CHARLY_MAX_DECISION_SKILL.examples, minimums: { positive: 1, neighbour: 1, sensitive: 1, mixed: 1, trap: 1 } });
    expect(issues.filter(issue => issue.code !== "below_quota")).toEqual([]);
  });
  it("la consigne porte la règle d'Ugo du 9/11 : capture et numéro du client, un seul message, puis transfert ; jamais « transmis » sans reçu", () => {
    const prompt = charlyMaxDecisionSkillPrompt();
    for (const rule of ["aucun dépannage, aucun message de test", "le numéro de Charly ne compte jamais", "UN seul message", "customerText=null", "sans reçu", "Ne prétends jamais avoir lu une image"]) {
      expect(prompt, rule).toContain(rule);
    }
  });
});

const CARD = { knowledgeId: "card-a", contentVersionId: "card-a-v1" };
const context = (overrides: Partial<CharlyMaxDecisionContext> = {}): CharlyMaxDecisionContext => ({
  topic: "incident", answerSources: [CARD], evidenceAskedBefore: false, procedureGivenBefore: false,
  evidencePresent: { screenshot: false, customer_phone: false }, handoffReceipt: null, ...overrides,
});
const ASK_TEXT = "Pouvez-vous nous envoyer une capture d'écran de votre conversation WhatsApp avec Charly Max, ainsi que le numéro de téléphone avec lequel vous lui écrivez ?";
const ask = (overrides: Record<string, unknown> = {}) => ({
  requestId: "r1", action: "ask_incident_evidence", askFor: ["screenshot", "customer_phone"], citedSources: [], handoff: null, customerText: ASK_TEXT, teamNote: "Incident, aucune pièce.", ...overrides,
});
const handoff = (overrides: Record<string, unknown> = {}) => ({
  requestId: "r1", action: "handoff", askFor: [], citedSources: [], handoff: { reason: "incident_evidence_complete", recipient: "support_technique" }, customerText: null, teamNote: "Capture et numéro reçus.", ...overrides,
});
const reply = (overrides: Record<string, unknown> = {}) => ({
  requestId: "r1", action: "reply_first_connection", askFor: [], citedSources: [CARD], handoff: null, customerText: "Voici comment commencer à parler à Charly Max sur WhatsApp : suivez les étapes de la rubrique Charly Max.", teamNote: "Première connexion.", ...overrides,
});

describe("Charly Max, garde de décision (pure, exclure seulement)", () => {
  it("laisse passer les trois chemins conformes", () => {
    expect(charlyMaxDecisionGuard(ask(), context())).toEqual([]);
    expect(charlyMaxDecisionGuard(ask({ askFor: ["customer_phone"] }), context({ evidencePresent: { screenshot: true, customer_phone: false } }))).toEqual([]);
    expect(charlyMaxDecisionGuard(handoff(), context({ evidenceAskedBefore: true, evidencePresent: { screenshot: true, customer_phone: true } }))).toEqual([]);
    expect(charlyMaxDecisionGuard(reply(), context({ topic: "first_connection" }))).toEqual([]);
  });
  it("une seule demande de pièces : jamais une deuxième, jamais une pièce déjà présente, jamais une demande vide", () => {
    expect(charlyMaxDecisionGuard(ask(), context({ evidenceAskedBefore: true }))).toContain("ask_repeated");
    expect(charlyMaxDecisionGuard(ask(), context({ evidencePresent: { screenshot: true, customer_phone: false } }))).toContain("ask_already_present");
    expect(charlyMaxDecisionGuard(ask({ askFor: [] }), context())).toContain("ask_nothing");
    expect(charlyMaxDecisionGuard(ask(), context({ topic: "first_connection" }))).toContain("ask_outside_incident");
  });
  it("le numéro du client, jamais celui de Charly ; aucun message de test ; aucun dépannage ; aucune lecture d'image prétendue", () => {
    expect(charlyMaxDecisionGuard(ask({ customerText: "Pouvez-vous nous donner le numéro de Charly et une capture ?" }), context())).toContain("asks_charly_number");
    expect(charlyMaxDecisionGuard(ask({ customerText: `${ASK_TEXT} Le numéro de Charly ne nous sert pas.` }), context())).toEqual([]);
    expect(charlyMaxDecisionGuard(ask({ customerText: `${ASK_TEXT} Envoyez aussi un message de test à Charly.` }), context())).toContain("test_message");
    expect(charlyMaxDecisionGuard(ask({ customerText: `${ASK_TEXT} Essayez de redémarrer WhatsApp.` }), context())).toContain("troubleshooting");
    expect(charlyMaxDecisionGuard(ask({ customerText: "J'ai bien regardé votre capture. Pouvez-vous envoyer votre numéro ?", askFor: ["customer_phone"] }), context({ evidencePresent: { screenshot: true, customer_phone: false } }))).toContain("claims_read_image");
  });
  it("jamais « transmis » sans reçu ; un transfert n'écrit aucun texte client", () => {
    expect(charlyMaxDecisionGuard(ask({ customerText: `${ASK_TEXT} Nous transmettrons ensuite à l'équipe technique.` }), context())).toContain("transmitted_without_receipt");
    expect(charlyMaxDecisionGuard(handoff({ customerText: "Votre demande a été transmise à notre équipe." }), context())).toEqual(expect.arrayContaining(["handoff_with_customer_text", "transmitted_without_receipt"]));
    expect(charlyMaxDecisionGuard(handoff({ handoff: null }), context())).toContain("handoff_missing");
  });
  it("une réponse s'appuie sur une fiche answer du bloc à version exacte, jamais sur un incident ni deux fois", () => {
    expect(charlyMaxDecisionGuard(reply({ citedSources: [] }), context({ topic: "first_connection" }))).toContain("reply_without_source");
    expect(charlyMaxDecisionGuard(reply({ citedSources: [{ knowledgeId: "card-a", contentVersionId: "card-a-v0" }] }), context({ topic: "first_connection" }))).toContain("source_outside_support");
    expect(charlyMaxDecisionGuard(reply(), context({ topic: "first_connection", answerSources: [] }))).toContain("source_outside_support");
    expect(charlyMaxDecisionGuard(reply(), context({ topic: "incident" }))).toContain("reply_on_incident");
    expect(charlyMaxDecisionGuard(reply(), context({ topic: "number_already_used" }))).toContain("reply_on_incident");
    expect(charlyMaxDecisionGuard(reply(), context({ topic: "hourglass", procedureGivenBefore: true }))).toContain("procedure_repeated");
  });
  it("le noyau s'applique à notre propre texte", () => {
    expect(charlyMaxDecisionGuard(reply({ customerText: "Si cela ne vous convient pas, vous pouvez résilier votre abonnement." }), context({ topic: "first_connection" }))).toContain("kernel_in_reply");
    expect(charlyMaxDecisionGuard(reply({ customerText: "Nous pouvons vous rembourser ce mois." }), context({ topic: "first_connection" }))).toContain("kernel_in_reply");
  });
  it.each([
    ["champ en trop", { ...ask(), extra: true }],
    ["action inconnue", ask({ action: "fix" })],
    ["pièce inconnue", ask({ askFor: ["password"] })],
    ["raison inconnue", handoff({ handoff: { reason: "because", recipient: "support" } })],
    ["destinataire inconnu", handoff({ handoff: { reason: "unclear_request", recipient: "ceo" } })],
    ["note vide", ask({ teamNote: " " })],
    ["null", null],
  ])("sortie malformée = équipe : %s", (_name, value) => {
    expect(charlyMaxDecisionSchema.safeParse(value).success).toBe(false);
    expect(charlyMaxDecisionGuard(value, context())).toEqual(["malformed"]);
  });
});
