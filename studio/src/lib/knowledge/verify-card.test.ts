import { describe, expect, it } from "vitest";
import type { CanonicalKnowledge } from "./contracts";
import { hasUnsafeSavCardText, officialCardLink, savCardTextProblems, SAV_CARD_OFFICIAL_LINKS } from "./card-safety";
import { savCardCompletenessChecks, savCardCompletenessMessages, savCardVersionValidityChecks } from "./card-checks";
import { assertSafeKnowledgeDraft, SavCardUnsafeContentError } from "./onboarding-extraction";
import { preparePastedKnowledge } from "./paste-new";
import { verifySavKnowledgeCard } from "./verify-card";

const now = new Date("2026-11-15T10:00:00Z");
const step = (id: string, instruction: string, expectedResult = "La page attendue s’affiche.") => ({ id, userLabel: "Étape de la procédure", objective: "Retrouver l’accès", instruction, location: "", prerequisites: [], expectedResult, exceptions: [], escalation: "", variants: [] });
const card = (patch: Partial<CanonicalKnowledge> = {}): CanonicalKnowledge => ({
  schemaVersion: 1, objective: "Aider le client à se reconnecter", applicability: "sav_only", locale: "fr-FR", productVersion: "V3",
  prerequisites: ["Le client a déjà un compte."], expectedResult: "Le client est connecté.", exceptions: [], escalation: "Transférer à l’équipe si rien ne marche.",
  steps: [step("step.one", "Ouvrir la page de connexion."), step("step.two", "Demander un nouveau code.")],
  supportContext: { symptoms: ["Je n’arrive pas à me connecter"], diagnosticQuestions: [], responseTemplate: "" }, ...patch,
});
const procedure = { version: 1, mode: "procedure", internalStepIds: [], groups: [{ id: "login", label: "Se reconnecter", stepIds: ["step.one", "step.two"], requiresHuman: false, prerequisiteIndexes: [], exceptionIndexes: [], includeExpectedResult: true, includeEscalation: true }] };
const goodInput = { title: "Se reconnecter à Limova", document: card(), delivery: procedure, sources: [{ label: "Tutoriel Academy", ref: "https://academy.limova.ai/tutorials/connexion" }], reason: "Fiche du bloc Accès, revue par Ugo." };

describe("official link allowlist (card content)", () => {
  it("accepts an official Academy, app, welcome or Limova booking link, even with a public tutorial id", () => {
    for (const link of ["https://academy.limova.ai/", "https://academy.limova.ai/tutorials/a642045f-d118-41af-bd8a-58ad05461520", "https://new.limova.ai", "https://bienvenue.limova.ai/", "https://us06web.zoom.us/webinar/register/WN_OBY9OMWETKaRhGrPr3TyJw", "https://us06web.zoom.us/webinar/register/WN_us7DbTjVT2uM-23-Xgz_Eg"])
      expect(officialCardLink(link), link).not.toBeNull();
    expect(hasUnsafeSavCardText("Suivez le tutoriel https://academy.limova.ai/tutorials/a642045f-d118-41af-bd8a-58ad05461520.")).toBe(false);
    expect(hasUnsafeSavCardText("Voir [le tutoriel](https://academy.limova.ai/superpowers/support-client) puis inscrivez-vous (https://us06web.zoom.us/webinar/register/WN_OBY9OMWETKaRhGrPr3TyJw).")).toBe(false);
    expect(hasUnsafeSavCardText("Réservez https://calendly.com/d/cszz-77d-g2h/onboarding-premium")).toBe(true);
    for (const glued of ['https://new.limova.ai/"https://evil.com', "https://new.limova.ai/»https://evil.com", "https://new.limova.ai/)https://evil.com",
      "https://new.limova.ai//evil.com", "https://new.limova.ai/\\evil.com", "https://academy.limova.ai/%2e%2e/x", "https://NEW.limova.ai/"])
      expect(hasUnsafeSavCardText(`Voir ${glued}`), glued).toBe(true);
    expect(hasUnsafeSavCardText("Voir https://us06web.zoom.us/webinar/register/WN_autre")).toBe(true);
    expect(hasUnsafeSavCardText("Voir https://us06web.zoom.us/webinar/register/WN_OBY9OMWETKaRhGrPr3TyJw/extra")).toBe(true);
    expect(SAV_CARD_OFFICIAL_LINKS.map(row => row.host)).toEqual(["academy.limova.ai", "new.limova.ai", "bienvenue.limova.ai", "us06web.zoom.us"]);
  });

  it("still rejects any other link, a look-alike host, a query, a customer path, and every other kind of data", () => {
    const rejected: Array<[string, string]> = [
      ["Voir https://example.com/aide", "link_not_allowed"],
      ["Voir https://academy.limova.ai.evil.example/x", "link_not_allowed"],
      ["Voir https://academy.limova.ai@evil.example/x", "link_not_allowed"],
      ["Voir http://academy.limova.ai/x", "link_not_allowed"],
      ["Voir https://academy.limova.ai/x?email=a", "link_not_allowed"],
      ["Voir https://new.limova.ai/workspaces/a642045f-d118-41af-bd8a-58ad05461520", "link_not_allowed"],
      ["Voir https://calendly.com/reschedulings/5e9d6fee-75c6-4ede-bc86-fcd3c62ab6ed", "link_not_allowed"],
      ["Voir www.example.com", "link_not_allowed"],
      ["Dossier a642045f-d118-41af-bd8a-58ad05461520", "identifier"],
      ["Appeler le 06 12 34 56 78", "phone"],
      ["Appeler le +44 20 7946 0958", "phone"],
      ["Ouvrir /settings/billing ensuite", "path"],
      ["Écrire à client.private@example.test", "email"],
      ["Nom du client : Dupont", "customer_data"],
      ["token: abcdef123456", "secret"],
      ["Cliquer <b>ici</b>", "markup"],
      ["Utiliser querySelector('#login')", "technical"],
    ];
    for (const [text, code] of rejected) expect(savCardTextProblems(text).map(problem => problem.code), text).toContain(code);
    expect(savCardTextProblems("Voir https://example.com/aide")[0]).toEqual({ code: "link_not_allowed", detail: "example.com" });
  });

  it("the save check accepts an Academy link and names every refused field", () => {
    expect(() => assertSafeKnowledgeDraft(card({ escalation: "Suivre https://academy.limova.ai/superpowers/support-client puis transférer." }))).not.toThrow();
    const document = card({ prerequisites: ["Appeler le 06 12 34 56 78"], steps: [step("step.one", "Écrire à client.private@example.test"), step("step.two", "Voir https://example.com/x")] });
    let thrown: unknown;
    try { assertSafeKnowledgeDraft(document); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(SavCardUnsafeContentError);
    expect((thrown as Error).message).toBe("ONBOARDING_KNOWLEDGE_UNSAFE_CONTENT");
    expect((thrown as SavCardUnsafeContentError).fields.map(field => [field.path, field.problems.map(problem => problem.code)])).toEqual([
      ["prerequisites.0", ["phone"]], ["steps.0.instruction", ["email"]], ["steps.1.instruction", ["link_not_allowed"]],
    ]);
  });
});

describe("Vérifier ma fiche", () => {
  it("passes a complete card with an official link, without any error", () => {
    const result = verifySavKnowledgeCard(goodInput, now);
    expect(result.problems.filter(problem => problem.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("returns ALL field-level problems at once, errors first, each with its field label", () => {
    const document = card({
      productVersion: "", validUntil: "2026-01-31", escalation: "",
      prerequisites: ["Appeler le 06 12 34 56 78"],
      steps: [step("step.one", "Écrire à client.private@example.test"), step("step.two", "Voir https://example.com/x", "")],
    });
    const result = verifySavKnowledgeCard({ title: "Ac", document, delivery: { version: 1, mode: "unclassified" }, sources: [{ label: "x", ref: "javascript:alert(1)" }], reason: "court" }, now);
    const byField = result.problems.map(problem => `${problem.severity}|${problem.field}|${problem.code}`);
    expect(byField).toEqual(expect.arrayContaining([
      "error|title|title_short",
      "error|prerequisites.0|unsafe_phone",
      "error|steps.0.instruction|unsafe_email",
      "error|steps.1.instruction|unsafe_link_not_allowed",
      "error|steps.1.expectedResult|step_expected_result_missing",
      "error|escalation|escalation_missing",
      "error|reason|reason_short",
      "error|sources.0.ref|source_ref_invalid",
      "error|sources.0.label|source_label_short",
      "error|validUntil|valid_until_past",
      "error|delivery|delivery_unclassified",
      "warning|productVersion|product_version_missing",
      "warning|escalation|card_escalation_missing",
    ]));
    expect(result.ok).toBe(false);
    expect(result.errors).toBe(11);
    expect(result.problems.find(problem => problem.field === "steps.1.expectedResult")!.fieldLabel).toBe("Étape 2 · résultat attendu");
    expect(result.problems.find(problem => problem.field === "prerequisites.0")!.fieldLabel).toBe("Prérequis 1");
    const firstWarning = result.problems.findIndex(problem => problem.severity === "warning");
    expect(result.problems.slice(firstWarning).every(problem => problem.severity === "warning")).toBe(true);
  });

  it("reports the delivery classification and the publication budget warnings", () => {
    const longSteps = Array.from({ length: 9 }, (_, index) => step(`step.s${index}`, `Étape numéro ${index + 1} à suivre.`));
    const result = verifySavKnowledgeCard({ ...goodInput, document: card({ steps: longSteps }), delivery: procedure }, now);
    expect(result.problems.map(problem => problem.code)).toEqual(expect.arrayContaining(["sav_delivery_reference_invalid", "card_too_many_steps"]));
  });

  it("never throws on a malformed draft: the schema problems are listed by field", () => {
    const result = verifySavKnowledgeCard({ title: "Titre correct", document: { objective: 3, steps: "x" } }, now);
    expect(result.ok).toBe(false);
    expect(result.problems.some(problem => problem.field === "objective")).toBe(true);
  });
});

describe("version and validity: one rule for the screen and the server", () => {
  it("a missing product version is a warning on both, never a blocking item", () => {
    const pasted = preparePastedKnowledge({ title: "Titre", text: "## Objectif\nFaire X.\n## Procédure proposée\n1. Ouvrir X.\n## Résultat attendu\nX ouvert.\n## Escalade\nÉquipe support.", sourceLabel: "Source", sourceRef: "https://academy.limova.ai/" }, now);
    const server = verifySavKnowledgeCard({ title: "Titre", document: pasted.document }, now).problems.filter(problem => ["productVersion", "validUntil"].includes(problem.field));
    expect(pasted.missing).toEqual([]);
    expect(pasted.warnings).toEqual(server.map(problem => problem.message));
    expect(server.map(problem => problem.severity)).toEqual(["warning"]);
  });

  it("the paste screen reads the version and validity lines, and a past date blocks on both", () => {
    const pasted = preparePastedKnowledge({ title: "Titre", text: "Version produit : V3\nValidité : 2026-01-31\n## Objectif\nFaire X.\n## Procédure proposée\n1. Ouvrir X." }, now);
    expect(pasted.document.productVersion).toBe("V3");
    expect(pasted.document.validUntil).toBe("2026-01-31");
    const expected = savCardVersionValidityChecks(pasted.document, now).filter(check => check.severity === "error").map(check => check.message);
    expect(expected).toHaveLength(1);
    expect(pasted.missing).toContain(expected[0]);
    expect(verifySavKnowledgeCard({ title: "Titre", document: pasted.document }, now).problems.find(problem => problem.field === "validUntil")).toMatchObject({ severity: "error", message: expected[0] });
    expect(() => preparePastedKnowledge({ text: "Validité : 31/01/2027\nFaire X.\n1. Ouvrir X." }, now)).toThrow("AAAA-MM-JJ");
  });

  it("keeps the server preview's exact completeness wording", () => {
    const document = card({ steps: [step("step.one", "Ouvrir X.", "")], escalation: "" });
    expect(savCardCompletenessMessages(savCardCompletenessChecks(document, [], "", true))).toEqual([
      "Ajouter au moins une source de preuve.", "Expliquer le motif de la proposition.", "Préciser les limites et le passage à un humain.", "Préciser le résultat observable de chaque étape.",
    ]);
  });
});
