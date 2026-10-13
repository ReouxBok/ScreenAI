import { describe, expect, it } from "vitest";
import type { OnboardingMetadata } from "@/db/schema";
import { canonicalKnowledgeSchema, semanticStepSchema } from "./contracts";
import { assertCompleteOnboardingKnowledge, assertSafeOnboardingKnowledge, prepareOnboardingKnowledge } from "./onboarding-extraction";

const metadata: OnboardingMetadata = { objective: "Renommer un espace de travail", proposalSignals: [], qualificationQuestions: [], expectedPages: [], successCriteria: [], branches: [], fallbacks: [], actionSteps: [] };
const body = `# Renommer un espace
## Quand utiliser ce parcours
Quand le nom d’un espace existant doit changer.
## Point d’entrée
Ouvrir « Paramètres » en bas à gauche.
## Prérequis
- Disposer du rôle administrateur de cet espace.
## Questions à poser si l’information manque
- Quel espace voulez-vous renommer ?
## Étapes opérationnelles
1. Ouvrir « Paramètres » en bas à gauche, puis « Général ».
2. Saisir le nouveau nom dans « Nom de l’espace ». Si le nom est déjà utilisé, choisir un autre nom.
3. Cliquer sur « Enregistrer » et attendre la confirmation.
## Vérification de réussite
- Le nouveau nom apparaît dans l’en-tête de l’espace.
## Variantes et blocages
- Si le nom est déjà utilisé : choisir un nom différent.
## Reprise sûre
- Si la confirmation ne s’affiche pas, vérifier le nom affiché avant de recommencer.`;
function prepare(overrides: Partial<Parameters<typeof prepareOnboardingKnowledge>[0]> = {}) {
  return prepareOnboardingKnowledge({ title: "Renommer un espace", bodyMarkdown: body, metadata, locale: "fr-FR", sourceKey: "tutorial:test:v1", ...overrides });
}

describe("SAV-51 onboarding knowledge extraction", () => {
  it("preserves exact title and structured business procedure, conditions and source order", () => {
    const result = prepare({ title: "Renommer un espace — édition test" });
    expect(result.title).toBe("Renommer un espace — édition test");
    expect(result.quality.state).toBe("ready");
    expect(result.document.applicability).toBe("sav_only");
    expect(result.document.steps).toHaveLength(3);
    expect(result.document.steps[0].instruction).toContain("en bas à gauche");
    expect(result.document.steps[1].instruction).toContain("Si le nom est déjà utilisé");
    expect(result.document.prerequisites).toEqual(["Disposer du rôle administrateur de cet espace."]);
    expect(result.document.supportContext?.diagnosticQuestions).toEqual(["Quel espace voulez-vous renommer ?"]);
    expect(result.document.exceptions).toEqual(["Si le nom est déjà utilisé : choisir un nom différent."]);
    expect(result.provenance).toContainEqual({ field: "title", source: "contentItem.title" });
    expect(canonicalKnowledgeSchema.safeParse(result.document).success).toBe(true);
  });
  it("does not present generic seeded templates as complete", () => {
    const result = prepare({ bodyMarkdown: body.replace("Ouvrir « Paramètres » en bas à gauche, puis « Général ».", "Ouvrir la liste concernée et sélectionner l’élément exact à modifier.") });
    expect(result.document.steps).toHaveLength(3);
    expect(result.quality.state).toBe("needs_completion");
    expect(result.quality.missing.join(" ")).toContain("génériques");
  });
  it("does not manufacture a procedure from recorded labels", () => {
    const result = prepare({ bodyMarkdown: "## Objectif\nChanger un nom", metadata: { ...metadata, actionSteps: [{ order: 1, action: "click", path: "/private/account", label: "Enregistrer", confidence: "strong", preconditions: [], expected: { pageMarkers: [], network: [] } }] } });
    expect(result.document.steps).toEqual([]);
    expect(result.quality.state).toBe("needs_completion");
    expect(JSON.stringify(result)).not.toContain("Renseignez");
  });
  it("extracts only demo narrations in source order, not technical reps or actions", () => {
    const result = prepare({ bodyMarkdown: `## Objectif\nChanger un nom\n## Démonstration\n1. Départ · Page — https://example.test/private/123\n2. Cliquez sur « Enregistrer »\n3. Explication : Ouvrir « Paramètres » en bas à gauche.\n4. Résultat après clic · Params\n5. Explication : Modifier le nom et cliquer sur « Enregistrer ».\n## Repères techniques appris\n- DOM selector: #secret\n- Explication : instruction technique interdite.` });
    expect(result.document.steps.map((step) => step.instruction)).toEqual(["Ouvrir « Paramètres » en bas à gauche.", "Modifier le nom et cliquer sur « Enregistrer »."]);
    expect(result.supportBody).not.toMatch(/secret|https:|instruction technique/);
    expect(result.quality.state).toBe("needs_completion");
  });
  it("marks truncated narration explicitly", () => {
    const result = prepare({ bodyMarkdown: "## Objectif\nChanger un nom\n## Démonstration\n1. Explication : Ouvrir les paramètres puis…" });
    expect(result.quality.missing.join(" ")).toContain("tronquées");
    expect(result.document.steps[0].instruction).toContain("puis…");
  });
  it("uses an explicit corrected navigation label without changing the tutorial title", () => {
    const result = prepare({ title: "Ouvrir Limova Bêta", bodyMarkdown: "Narration de l’entrée de navigation : dire « Limova 3.0 en haut à gauche ». Les anciens libellés « Limova Bêta » ne doivent pas être prononcés.\n" + body.replace("Ouvrir « Paramètres » en bas à gauche, puis « Général ».", "Ouvrir « Limova Bêta ».") });
    expect(result.title).toBe("Ouvrir Limova Bêta");
    expect(result.document.steps[0].instruction).toBe("Ouvrir « Limova 3.0 en haut à gauche ».");
    expect(result.provenance).toContainEqual({ field: "navigation", source: "bodyMarkdown.preamble.navigationCorrection" });
  });
  it.each([" Signé ", "Compte test@example.com", "Numéro 0612345678", "Clef sk-1234567890abcdefghijkl", "Lien https://example.test/x"]) ("blocks unsafe titles instead of changing them: %s", (title) => {
    expect(() => prepare({ title })).toThrow("ONBOARDING_KNOWLEDGE_TITLE_REQUIRES_REVIEW");
  });
  it("removes private values, identifiers, URLs and technical passages with an explicit quality flag", () => {
    const result = prepare({ bodyMarkdown: body.replace("Saisir le nouveau nom dans « Nom de l’espace ». Si le nom est déjà utilisé, choisir un autre nom.", "Écrire à demo@example.test et ouvrir https://example.test/clients/123 avec token=secret123 puis repérer 123e4567-e89b-42d3-a456-426614174000.").replace("Cliquer sur « Enregistrer » et attendre la confirmation.", "Cliquer avec querySelector('#secret') aux coordonnées: x=23,y=45.") });
    expect(JSON.stringify(result)).not.toMatch(/demo@example|https:\/\/|secret123|123e4567|querySelector|x=23/);
    expect(result.quality.state).toBe("needs_completion");
    expect(result.quality.warnings.join(" ")).toMatch(/sensibles|technique/);
  });
  it("keeps semantic steps and role variants with their context", () => {
    const step = semanticStepSchema.parse({ id: "semantic.first", userLabel: "Options avancées", objective: "Ouvrir les options", instruction: "Ouvrir les options après sélection de l’espace.", expectedResult: "Options visibles", escalation: "Demander au responsable de l’espace.", variants: [{ roles: ["admin"], productVersion: "2026.10", instruction: "Ouvrir les options de l’équipe.", expectedResult: "Options d’équipe visibles" }] });
    const result = prepare({ metadata: { ...metadata, semanticSteps: [step] } });
    expect(result.document.steps).toHaveLength(1);
    expect(result.document.steps[0].variants[0].roles).toEqual(["admin"]);
    expect(result.document.steps[0].variants[0].instruction).toBe("Ouvrir les options de l’équipe.");
    expect(result.document.steps[0].expectedResult).toBe("Options visibles");
  });
  it("retains metadata business signals, qualification and branch conditions", () => {
    const result = prepare({ metadata: { ...metadata, proposalSignals: ["L’utilisateur ne retrouve pas son espace."], qualificationQuestions: ["Avez-vous le rôle administrateur ?"], branches: [{ condition: "le rôle est lecteur", next: "demander à un administrateur" }] } });
    expect(result.document.supportContext?.symptoms).toContain("L’utilisateur ne retrouve pas son espace.");
    expect(result.document.supportContext?.diagnosticQuestions).toContain("Avez-vous le rôle administrateur ?");
    expect(result.document.exceptions).toContain("Si le rôle est lecteur : demander à un administrateur");
  });
  it("does not silently truncate long content", () => {
    const longInstruction = "Rechercher un espace. ".repeat(120);
    const result = prepare({ bodyMarkdown: body.replace("Ouvrir « Paramètres » en bas à gauche, puis « Général ».", longInstruction) });
    expect(result.quality.state).toBe("needs_completion");
    expect(result.quality.missing.join(" ")).toContain("2 000");
    expect(result.supportBody).toContain(longInstruction.trim());
    expect(result.document.onboardingContext?.sourceNotes.join("\n")).toContain(longInstruction.trim());
    expect(result.document.steps.every((step) => step.instruction.length <= 2_000)).toBe(true);
  });
  it("caps the canonical step count visibly and retains overflow for completion", () => {
    const result = prepare({ bodyMarkdown: "## Étapes opérationnelles\n" + Array.from({ length: 52 }, (_, i) => `${i + 1}. Ouvrir la rubrique numéro ${i + 1}.`).join("\n") });
    expect(result.document.steps).toHaveLength(50);
    expect(result.supportBody).toContain("rubrique numéro 52");
    expect(result.quality.missing.join(" ")).toContain("50 étapes");
  });
  it("does not infer a navigation procedure from raw technical metadata", () => {
    const result = prepare({ metadata: { ...metadata, expectedPages: ["/organization/settings/secret"], sourceMetadata: { password: "real-secret" }, actionSteps: [] } });
    expect(JSON.stringify(result)).not.toMatch(/\/organization|real-secret/);
  });
  it("adds the product boundary for finance without authorizing any action", () => {
    const result = prepare({ title: "Consulter les factures", metadata: { ...metadata, objective: "Consulter ses factures" } });
    expect(result.document.escalation).toContain("n’autorise aucune opération financière");
    expect(result.provenance).toContainEqual({ field: "escalation", source: "policy:PRODUCT_GUARDRAILS" });
  });
  it("generates deterministic step identities and no source key leakage into prose", () => {
    expect(prepare().document.steps).toEqual(prepare().document.steps);
    expect(prepare().supportBody).not.toContain("tutorial:test:v1");
  });
  it("keeps staff supplements and the entry point in canonical retrieval context", () => {
    const result = prepare({ bodyMarkdown: body + "\n## Repères techniques appris\nselector: #private\n## Compléments déjà transmis par le staff\nSi deux espaces ont le même nom, demander lequel est concerné." });
    expect(result.document.onboardingContext?.entryPoint).toBe("Ouvrir « Paramètres » en bas à gauche.");
    expect(result.document.onboardingContext?.sourceNotes).toContain("Si deux espaces ont le même nom, demander lequel est concerné.");
    expect(JSON.stringify(result.document)).not.toContain("#private");
  });
  it("finds EXT-1 correction after a document title and compact old label", () => {
    const result = prepare({ title: "Ouvrir Limova3.0Bêta", bodyMarkdown: "# Ouvrir Limova3.0Bêta\nNarration de l’entrée de navigation : dire « Limova 3.0 en haut à gauche ». Les anciens libellés ne doivent pas être prononcés.\n" + body.replace("Ouvrir « Paramètres » en bas à gauche, puis « Général ».", "Ouvrir « Limova3.0Bêta ».") });
    expect(result.title).toBe("Ouvrir Limova3.0Bêta");
    expect(result.document.steps[0].instruction).toBe("Ouvrir « Limova 3.0 en haut à gauche ».");
  });
  it.each(["Ouvrir la section indiquée et choisir l’action correspondant à la demande.", "Recueillir les valeurs obligatoires visibles dans le formulaire."])("requires completion of generic action %s", (instruction) => {
    const result = prepare({ bodyMarkdown: body.replace("Ouvrir « Paramètres » en bas à gauche, puis « Général ».", instruction) });
    expect(result.quality.state).toBe("needs_completion");
  });
  it("marks a demo as incomplete even without a visible truncation marker", () => {
    const result = prepare({ bodyMarkdown: body.replace(/## Étapes opérationnelles[\s\S]*?## Vérification/, "## Démonstration\n1. Explication : Ouvrir les paramètres puis lorsque l’on\n## Vérification") });
    expect(result.quality.state).toBe("needs_completion");
    expect(result.quality.missing.join(" ")).toContain("tronquées sans marque visible");
  });
  it.each(["Contacter test@example.test", "Contacter +32 470 12 34 56", "Cliquer sur #secret", "Cible [data-testid=private]", "Coordonnées 123, 456", "document.querySelector('#secret')", "Le token=secret doit être utilisé", "Ouvrir https://example.test/user/123", "Compte 123e4567-e89b-42d3-a456-426614174000", "<script>alert(1)</script>"])("blocks unsafe human edits: %s", (instruction) => {
    const document = prepare().document;
    document.steps[0].instruction = instruction;
    expect(() => assertSafeOnboardingKnowledge(document)).toThrow("ONBOARDING_KNOWLEDGE_UNSAFE_CONTENT");
  });
  it("permits safe business mentions about not disclosing credentials", () => {
    const document = prepare().document;
    document.steps[0].instruction = "Ne jamais recopier une clé ni demander un mot de passe. Ouvrir les paramètres en haut à gauche.";
    expect(() => assertSafeOnboardingKnowledge(document)).not.toThrow();
  });

  it("omits route inventories cleanly without creating a business completeness issue", () => {
    const result = prepare({ bodyMarkdown: body.replace("## Prérequis", "Pages repérées dans le front Limova :\n- `/organization/billing`\n- `/organization/[id]/settings`\n- `/workspace`\n\n## Prérequis") });
    expect(result.document.onboardingContext?.entryPoint).toBe("Ouvrir « Paramètres » en bas à gauche.");
    expect(JSON.stringify(result)).not.toMatch(/Pages repérées|chemin technique retiré|organization|workspace/);
    expect(result.quality.state).toBe("ready");
  });
  it("does not lose business text after an entry route inventory", () => {
    const result = prepare({ bodyMarkdown: body.replace("## Prérequis", "Pages repérées dans le front Limova :\n- `/organization/billing`\n\nSi plusieurs espaces sont visibles, demander lequel est concerné.\n\n## Prérequis") });
    expect(result.document.onboardingContext?.entryPoint).toContain("Si plusieurs espaces sont visibles, demander lequel est concerné.");
    expect(result.quality.state).toBe("ready");
  });
  it("deduplicates equal conditional branches with and without Si while preserving distinct actions", () => {
    const result = prepare({ metadata: { ...metadata, branches: [
      { condition: "le nom est déjà utilisé", next: "choisir un nom différent." },
      { condition: "Si le nom est déjà utilisé", next: "choisir un nom différent" },
      { condition: "le nom est déjà utilisé", next: "demander au responsable" },
    ] } });
    expect(result.document.exceptions).toEqual(["Si le nom est déjà utilisé : choisir un nom différent.", "Si le nom est déjà utilisé : demander au responsable"]);
  });
  it.each(["Créer une image", "Créer un dossier"])("does not infer finance from generic caution text for %s", (title) => {
    const result = prepare({ title, metadata: { ...metadata, objective: title }, bodyMarkdown: body.replace("Cliquer sur « Enregistrer » et attendre la confirmation.", "Présenter le récapitulatif au membre et demander confirmation si l’action publie, facture, invite, active ou contacte un tiers.") });
    expect(result.quality.warnings.join(" ")).not.toContain("Périmètre financier");
    expect(result.provenance).not.toContainEqual({ field: "escalation", source: "policy:PRODUCT_GUARDRAILS" });
  });
  it("still adds the finance guard for an explicit finance group", () => {
    const result = prepare({ metadata: { ...metadata, sourceMetadata: { group: "Facturation et abonnement" } } });
    expect(result.provenance).toContainEqual({ field: "escalation", source: "policy:PRODUCT_GUARDRAILS" });
  });
  it("keeps the default generic journey incomplete after route removal", () => {
    const result = prepare({ bodyMarkdown: body.replace("Ouvrir « Paramètres » en bas à gauche, puis « Général ».", "Ouvrir la section correspondant à « Renommer un espace » dans l’organisation et l’espace actifs.").replace("## Prérequis", "Pages repérées dans le front Limova :\n- `/organization/settings`\n\n## Prérequis") });
    expect(result.quality.state).toBe("needs_completion");
    expect(result.quality.missing.join(" ")).toContain("génériques");
    expect(result.quality.missing.join(" ")).not.toContain("techniques ont été retirées");
  });
  it("cleans spoken introductions and retains continuation paragraphs in their original step", () => {
    const result = prepare({ bodyMarkdown: "## Objectif\nCréer un espace\n## Démonstration\n1. Cliquez sur « Nouveau »\n2. Explication : Salut Charlie, aujourd’hui on va voir comment créer un espace. Ouvrir « Paramètres » en haut à gauche.\n\nSi plusieurs espaces sont visibles, demander lequel est concerné avant de continuer.\n\nAttendre que le nom soit affiché.\n3. Explication : Donc, cliquer sur « Enregistrer ».\n\nSi la confirmation manque, vérifier le nom avant de recommencer.\n## Repères techniques appris\nselector: #private" });
    expect(result.document.steps).toHaveLength(2);
    expect(result.document.steps[0].instruction).toBe("Créer un espace. Ouvrir « Paramètres » en haut à gauche.\n\nSi plusieurs espaces sont visibles, demander lequel est concerné avant de continuer.\n\nAttendre que le nom soit affiché.");
    expect(result.document.steps[1].instruction).toBe("Cliquer sur « Enregistrer ».\n\nSi la confirmation manque, vérifier le nom avant de recommencer.");
    expect(result.quality.state).toBe("needs_completion");
    expect(result.supportBody).not.toMatch(/Salut Charlie|on va voir|Donc,|#private/);
  });
  it("preserves paragraph continuations inside a written numbered step", () => {
    const result = prepare({ bodyMarkdown: body.replace("2. Saisir le nouveau nom", "Si plusieurs espaces sont proposés, choisir celui confirmé par le membre.\n\n2. Saisir le nouveau nom") });
    expect(result.document.steps).toHaveLength(3);
    expect(result.document.steps[0].instruction).toContain("Si plusieurs espaces sont proposés");
  });

  it("preserves an explicit narration question and a multi-paragraph prompt until the next recorded action", () => {
    const result = prepare({ bodyMarkdown: `## Objectif
Préparer une publication
## Démonstration
8. Explication : Salut Charlie, aujourd’hui on va voir comment préparer une publication. Ouvrir une nouvelle conversation.

Tu dois demander à l'utilisateur sur quels réseaux il souhaite créer son post, quel est le but de ce post et ce qu'il souhaite comme visuel. Une fois qu'il a répondu, personnalise ce prompt selon ses réponses et mets-le dans la zone texte :

"Rédige un post pour (plateforme).

Ce post a pour but de (demande utilisateur).

Pour le visuel je souhaite (demande utilisateur)."
9. Cliquez sur « Continuer » — https://example.test/private/id
## Repères techniques appris
selector: #private` });
    expect(result.document.steps).toHaveLength(1);
    expect(result.document.steps[0].instruction).toContain("Pour le visuel je souhaite (demande utilisateur).");
    expect(result.document.steps[0].instruction).toContain("Une fois qu'il a répondu");
    expect(result.document.supportContext?.diagnosticQuestions).toContain("Tu dois demander à l'utilisateur sur quels réseaux il souhaite créer son post, quel est le but de ce post et ce qu'il souhaite comme visuel.");
    expect(result.supportBody).not.toMatch(/https:|#private|Salut Charlie/);
  });
  it("preserves a business preamble and removes only its navigation correction line", () => {
    const result = prepare({ title: "Créer une image — Limova Bêta", bodyMarkdown: `# Créer une image
Avant toute saisie, vérifier que « Conversations Bêta » est ouvert ; sinon revenir au bon menu.
Narration de l’entrée de navigation : dire « Limova 3.0 en haut à gauche ». Les anciens libellés « Limova Bêta » ne doivent pas être prononcés.
Ne pas saisir le prompt dans une autre conversation.
Pages repérées dans le front Limova :
- /organization/conversations
${body}` });
    expect(result.document.onboardingContext?.sourceNotes.join("\n")).toContain("Avant toute saisie, vérifier que « Conversations Bêta » est ouvert ; sinon revenir au bon menu.");
    expect(result.document.onboardingContext?.sourceNotes.join("\n")).toContain("Ne pas saisir le prompt dans une autre conversation.");
    expect(result.supportBody).not.toMatch(/Narration de l’entrée|anciens libellés|\/organization|chemin technique retiré/);
    expect(result.title).toBe("Créer une image — Limova Bêta");
  });
  it("keeps business text next to repeated navigation guidance inside the same paragraph", () => {
    const result = prepare({ bodyMarkdown: body.replace("Ouvrir « Paramètres » en bas à gauche.\n## Prérequis", "Ouvrir « Limova Bêta ».\nNarration de l’entrée de navigation : dire « Limova 3.0 en haut à gauche ».\nVérifier le bon espace avant de saisir les informations.\n## Prérequis") });
    expect(result.document.onboardingContext?.entryPoint).toBe("Ouvrir « Limova 3.0 en haut à gauche ».\nVérifier le bon espace avant de saisir les informations.");
  });

  it("retains bullet continuations within an explanation rather than treating them as recorded actions", () => {
    const result = prepare({ bodyMarkdown: "## Objectif\nPréparer une image\n## Démonstration\n1. Explication : Demander les précisions suivantes :\n\n- le style souhaité ;\n- le format souhaité.\n\nAttendre les réponses avant de continuer.\n2. Cliquez sur « Créer »" });
    expect(result.document.steps).toHaveLength(1);
    expect(result.document.steps[0].instruction).toContain("- le style souhaité ;\n- le format souhaité.");
    expect(result.document.steps[0].instruction).toContain("Attendre les réponses avant de continuer.");
  });

  it("requires business documentation for code inventory sources even if all fields look complete", () => {
    const result = prepare({ metadata: { ...metadata, sourceMetadata: { origin: "limova_code_inventory" } } });
    expect(result.quality.state).toBe("needs_completion");
    expect(result.quality.missing.join(" ")).toContain("inventaire de code");
  });
  it("accepts documented semantic steps without the code inventory warning", () => {
    const plain = prepare();
    const result = prepare({ metadata: { ...metadata, sourceMetadata: { origin: "limova_code_inventory" }, semanticSteps: plain.document.steps } });
    expect(result.quality.missing.join(" ")).not.toContain("inventaire de code");
    expect(result.quality.state).toBe("ready");
  });
  it("blocks cosmetic changes while a generic destructive instruction remains", () => {
    const document = prepare().document;
    document.objective = "Démarrer, suspendre ou archiver une campagne avec prudence";
    document.steps[0].instruction = "Ouvrir la fiche de l’élément exact et vérifier son identité, son espace et son statut.";
    expect(() => assertCompleteOnboardingKnowledge(document)).toThrow("ONBOARDING_KNOWLEDGE_GENERIC_STEPS");
  });
  it("blocks generic integration instructions rather than treating their provider-neutral text as documented", () => {
    const document = prepare().document;
    document.steps[0].instruction = "Ouvrir le catalogue des intégrations et rechercher le fournisseur demandé.";
    expect(() => assertCompleteOnboardingKnowledge(document)).toThrow("ONBOARDING_KNOWLEDGE_GENERIC_STEPS");
  });
  it("checks the corrected instruction, not the old generic step objective", () => {
    const document = prepare().document;
    document.steps[0].objective = "Ouvrir la liste concernée et sélectionner l’élément exact à modifier.";
    expect(() => assertCompleteOnboardingKnowledge(document)).not.toThrow();
  });
  it("accepts a concrete completed document and an explicit absence of additional prerequisites", () => {
    const document = prepare().document;
    document.prerequisites = ["Aucun prérequis supplémentaire pour un membre déjà connecté."];
    expect(() => assertCompleteOnboardingKnowledge(document)).not.toThrow();
  });
  it("rejects an empty procedure after a human edit", () => {
    const document = prepare().document; document.steps = [];
    expect(() => assertCompleteOnboardingKnowledge(document)).toThrow("ONBOARDING_KNOWLEDGE_STEPS_REQUIRED");
  });
  it("rejects missing prerequisites after a human edit", () => {
    const document = prepare().document; document.prerequisites = [];
    expect(() => assertCompleteOnboardingKnowledge(document)).toThrow("ONBOARDING_KNOWLEDGE_PREREQUISITES_REQUIRED");
  });
  it.each(["", "Le parcours démontré est terminé.", "Le résultat de « Modifier une campagne » est visible dans Limova après réinspection de la page."])("rejects a missing or generic result: %s", (result) => {
    const document = prepare().document; document.expectedResult = result;
    expect(() => assertCompleteOnboardingKnowledge(document)).toThrow("ONBOARDING_KNOWLEDGE_RESULT_REQUIRED");
  });
  it("rejects missing usage situations after a human edit", () => {
    const document = prepare().document; document.supportContext!.symptoms = [];
    expect(() => assertCompleteOnboardingKnowledge(document)).toThrow("ONBOARDING_KNOWLEDGE_SITUATIONS_REQUIRED");
  });
  it.each(['{"api_key":"fixture-secret-a1b2c3"}', '{"password":"fixture-pass-123"}', "{'token':'fixture-token-123'}"])("redacts quoted secret assignments and rejects their human reintroduction: %s", (assignment) => {
    const instruction = `Utiliser ${assignment} pour la connexion.`;
    const result = prepare({ bodyMarkdown: body.replace("1. Ouvrir", `1. ${instruction}\n2. Ouvrir`) });
    expect(JSON.stringify(result.document)).not.toMatch(/fixture-(?:secret|pass|token)/);
    expect(result.quality.state).toBe("needs_completion");
    const edited = prepare().document;
    edited.steps[0].instruction = instruction;
    expect(() => assertSafeOnboardingKnowledge(edited)).toThrow("ONBOARDING_KNOWLEDGE_UNSAFE_CONTENT");
  });
  it("excludes an explicit CSS selector and rejects its human reintroduction", () => {
    const instruction = "Cliquer sur le sélecteur CSS .save-button.";
    const result = prepare({ bodyMarkdown: body.replace("1. Ouvrir", `1. ${instruction}\n2. Ouvrir`) });
    expect(JSON.stringify(result.document)).not.toContain(".save-button");
    expect(result.quality.state).toBe("needs_completion");
    const edited = prepare().document;
    edited.steps[0].instruction = instruction;
    expect(() => assertSafeOnboardingKnowledge(edited)).toThrow("ONBOARDING_KNOWLEDGE_UNSAFE_CONTENT");
  });
  it("rejects missing recovery and exceptions after a human edit", () => {
    const document = prepare().document; document.escalation = ""; document.exceptions = [];
    expect(() => assertCompleteOnboardingKnowledge(document)).toThrow("ONBOARDING_KNOWLEDGE_RECOVERY_REQUIRED");
  });

  it.each(["V2", "V3"])("preserves the explicit product scope %s in the tutorial title", (version) => {
    const title = `Renommer un espace (${version})`;
    const result = prepare({ title });
    expect(result.title).toBe(title);
    expect(result.document.productVersion).toBe(version);
    expect(result.provenance).toContainEqual({ field: "productVersion", source: "contentItem.title" });
  });
  it("preserves a safe explicitly sourced product version", () => {
    const result = prepare({ metadata: { ...metadata, sourceMetadata: { productVersion: "2026.10" } } });
    expect(result.document.productVersion).toBe("2026.10");
    expect(result.provenance).toContainEqual({ field: "productVersion", source: "metadata.sourceMetadata.productVersion" });
  });
  it("makes conflicting explicit version scopes visible before review", () => {
    const result = prepare({ title: "Renommer un espace (V3)", metadata: { ...metadata, sourceMetadata: { productVersion: "V2" } } });
    expect(result.quality.state).toBe("needs_completion");
    expect(result.quality.missing.join(" ")).toContain("version produit");
    expect(result.document.onboardingContext?.sourceNotes.join("\n")).toContain("Version du titre : V3");
  });
  it("does not infer a product scope from a navigation label or route", () => {
    const result = prepare({ bodyMarkdown: body.replace("Ouvrir « Paramètres » en bas à gauche.", "Ouvrir « Limova 3.0 » en haut à gauche."), metadata: { ...metadata, expectedPages: ["/v3/settings"] } });
    expect(result.document.productVersion).toBe("");
  });

});
