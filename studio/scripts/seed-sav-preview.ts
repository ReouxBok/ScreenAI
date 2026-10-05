import { eq } from "drizzle-orm";
import { closeDb, requireDb } from "../src/db/client";
import { categories, contentItems, contentVersions, savLearningCandidates, savResolutionEvidence } from "../src/db/schema";
import { saveDraft } from "../src/lib/workflow";
import { proposeSavFromOnboarding, proposeOnboardingFromSav } from "../src/lib/knowledge/candidates";

if (process.env.NODE_ENV === "production" || !process.env.DATABASE_URL?.startsWith("pglite:") || !process.env.DATABASE_URL.endsWith("/sav-preview-db")) throw new Error("ISOLATED_SAV_PREVIEW_DATABASE_REQUIRED");
if (["HUBSPOT_ACCESS_TOKEN", "GMAIL_REFRESH_TOKEN", "SAV_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"].some((name) => process.env[name])) throw new Error("EXTERNAL_PREVIEW_CREDENTIALS_FORBIDDEN");
const actor = "ugo@limova.ai";
const db = requireDb();
try {
  await db.insert(categories).values([{ slug: "bien-demarrer", label: "Bien démarrer" }, { slug: "depannage", label: "Dépannage" }]).onConflictDoNothing();
  const [existingTutorial] = await db.select().from(contentItems).where(eq(contentItems.slug, "demo-factures-onboarding"));
  const tutorial = existingTutorial ? { item: existingTutorial, version: (await db.select().from(contentVersions).where(eq(contentVersions.id, existingTutorial.currentDraftVersionId!)))[0] } : await saveDraft({
    type: "onboarding", slug: "demo-factures-onboarding", locale: "fr-FR", title: "Démo — retrouver ses factures", summary: "Tutoriel fictif pour la revue locale", categorySlug: "bien-demarrer", visibility: "charly_only", agentKey: "charly", ownerEmail: actor,
    bodyMarkdown: "Données fictives. Tutoriel : Paramètres en bas à gauche, puis Facturation, puis Factures.", changeNote: "Démo locale uniquement",
    metadata: { objective: "Retrouver ses factures", proposalSignals: ["factures"], qualificationQuestions: [], expectedPages: ["/settings/billing"], successCriteria: ["La liste des factures est visible"], branches: [], fallbacks: ["Faire vérifier le parcours si le menu manque"], sourceMetadata: { trainingSessionId: "demo-local-factures" }, actionSteps: [
      { order: 1, action: "click", path: "/", label: "Paramètres", confidence: "strong", target: { testId: "demo-settings", zone: "bottom-left" }, preconditions: [], expected: { pageMarkers: [], network: [] } },
      { order: 2, action: "click", path: "/settings", label: "Facturation", confidence: "strong", target: { testId: "demo-billing" }, preconditions: [], expected: { pageMarkers: [], network: [] } },
      { order: 3, action: "click", path: "/settings/billing", label: "Factures", confidence: "strong", target: { testId: "demo-invoices" }, preconditions: [], expected: { pageMarkers: [], network: [] } },
    ] } }, actor);
  await proposeSavFromOnboarding(tutorial.item.id, tutorial.version.id, actor);
  const [existingArticle] = await db.select().from(contentItems).where(eq(contentItems.slug, "demo-sav-profil"));
  const article = existingArticle ? { item: existingArticle, version: (await db.select().from(contentVersions).where(eq(contentVersions.id, existingArticle.currentDraftVersionId!)))[0] } : await saveDraft({
    type: "article", slug: "demo-sav-profil", locale: "fr-FR", title: "Démo — modifier son profil", summary: "Résolution fictive relue, non publiée", categorySlug: "depannage", visibility: "charly_only", agentKey: "sav", ownerEmail: actor,
    bodyMarkdown: "Ouvrez Paramètres, puis Profil pour modifier votre nom. Données fictives.", changeNote: "Démo locale uniquement",
    metadata: { intents: ["modifier son profil"], limovaPaths: [], prerequisites: ["Être connecté"], expectedResult: "Le nom du profil est mis à jour", troubleshooting: "Faire vérifier le parcours par un humain", resolution: { symptoms: ["Modifier son nom"], steps: ["Ouvrez Paramètres, puis Profil pour modifier votre nom."], exceptions: [], escalation: "Contacter le support si le menu n’est pas disponible", productVersion: "" } } }, actor);
  let [learning] = await db.select().from(savLearningCandidates).where(eq(savLearningCandidates.sourceRef, "demo:local-profil"));
  if (!learning) {
    [learning] = await db.insert(savLearningCandidates).values({ contentItemId: article.item.id, status: "approved", sourceRef: "demo:local-profil", sourceContentHash: "demo", proposedPatch: {}, explanation: "Fixture simulant une résolution revue ; aucune donnée client", reviewedBy: actor, reviewedAt: new Date() }).returning();
    await db.insert(savResolutionEvidence).values({ itemId: article.item.id, versionId: article.version.id, sourceRef: learning.sourceRef, outcome: "human_resolution", summary: "Fixture de revue locale" });
  }
  await proposeOnboardingFromSav(learning.id, actor);
  console.log("Prévisualisation fictive prête : deux candidats, aucune publication ni connexion externe.");
} finally { await closeDb(); }
