import { expect, test, type Locator } from "@playwright/test";

const title = "Renommer l’espace — démo SAV-51 (titre exact)";
const sourceItemId = "00000051-0000-4000-8000-000000000001";
const sourceVersionId = "00000051-0000-4000-9000-000000000001";
const path = "/studio/sav/connaissances";
async function openDetails(summary: Locator) {
  if (await summary.locator("..").getAttribute("open") === null) await summary.click();
}

test("SAV-51 : qualifier un tutoriel incomplet depuis le lot sans publier ni activer sa connaissance", async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setExtraHTTPHeaders({ "x-studio-test-user": "ugo@limova.ai" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);

  // The source and its title are fictional fixtures seeded only in the isolated E2E database.
  await openDetails(page.getByText("Proposer une version de tutoriel au SAV", { exact: true }));
  await page.getByLabel("ID du contenu", { exact: true }).fill(sourceItemId);
  await page.getByLabel("ID de la version source", { exact: true }).fill(sourceVersionId);
  await page.getByRole("button", { name: "Préparer un candidat", exact: true }).click();
  await expect(page).toHaveURL(/result=candidate_ready/);
  const initialCard = page.locator("article[id^='candidate-']").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(initialCard).toHaveCount(1);
  await expect(initialCard.getByText("À compléter", { exact: true })).toBeVisible();
  const cardId = await initialCard.getAttribute("id");
  expect(cardId).toMatch(/^candidate-[0-9a-f-]+$/);

  await openDetails(page.getByText(/^Lots de conversion des tutoriels ·/));
  await page.getByRole("button", { name: "Préparer l’inventaire des tutoriels actifs", exact: true }).click();
  await expect(page).toHaveURL(/result=onboarding_import_started/);
  for (let pass = 0; pass < 3; pass++) {
    await openDetails(page.getByText(/^Lots de conversion des tutoriels ·/));
    await page.getByRole("button", { name: /(?:Préparer les premiers candidats|Poursuivre ou reprendre le lot) · 10 sources maximum/ }).click();
    await expect(page).toHaveURL(/result=onboarding_import_continued/);
    await openDetails(page.getByText(/^Lots de conversion des tutoriels ·/));
    await expect(page.getByRole("progressbar", { name: /^Progression du lot du/ })).toHaveAttribute("value", String((pass + 1) * 10));
  }

  const filters = page.getByRole("form", { name: "Filtrer les connaissances" });
  await filters.getByLabel("Statut", { exact: true }).selectOption("needs_completion");
  await filters.getByLabel("Source", { exact: true }).selectOption("onboarding");
  await filters.getByRole("button", { name: "Afficher les connaissances", exact: true }).click();
  await expect(page).toHaveURL(/status=needs_completion/);
  await expect(page).toHaveURL(/source=onboarding/);
  await page.getByRole("navigation", { name: "Pagination des connaissances", exact: true }).getByRole("link", { name: "Page suivante →", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator(`article#${cardId}`).getByRole("heading", { name: title, exact: true })).toBeVisible();

  // Coverage links reach a candidate even when the current filter deliberately excludes it.
  await filters.getByLabel("Statut", { exact: true }).selectOption("approved");
  await filters.getByRole("button", { name: "Afficher les connaissances", exact: true }).click();
  await openDetails(page.getByText(/^Lots de conversion des tutoriels ·/));
  await page.getByRole("link", { name: "Voir la couverture et les sources du lot", exact: true }).click();
  await expect(page).toHaveURL(/batch=[0-9a-f-]+/);
  const sourceRow = page.getByRole("table", { name: "Sources du lot et résultat de leur préparation" }).getByRole("row").filter({ has: page.getByRole("link", { name: title, exact: true }) });
  await sourceRow.getByRole("link", { name: "Ouvrir la connaissance", exact: true }).click();
  await expect(page).toHaveURL(/candidate=[0-9a-f-]+#candidate-/);
  await expect(page).toHaveURL(/status=approved/);
  const card = page.locator(`article#${cardId}`);
  await expect(card.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(card.getByRole("region", { name: "Connaissance complète", exact: true })).toBeVisible();
  await openDetails(card.getByText("Revoir, corriger ou écarter cette connaissance", { exact: true }));
  const form = card.getByRole("form", { name: `Revoir ${title}`, exact: true });
  const approve = form.getByRole("button", { name: "Valider et préparer le brouillon SAV", exact: true });
  await expect(approve).toBeDisabled();
  await form.getByRole("button", { name: "Vérifier la source et comparer", exact: true }).click();
  await expect(form.getByText(/Version du tutoriel source vérifiée/)).toBeVisible();
  await form.getByLabel("J’ai vérifié la source, la procédure complète et les sujets proches.", { exact: true }).check();
  await form.getByLabel("Preuves et précisions apportées", { exact: true }).fill("La procédure fictive a été relue pour cette recette isolée.");
  await form.getByLabel("J’ai vérifié et traité les informations manquantes indiquées.", { exact: true }).check();
  await form.getByLabel("Motif de la décision", { exact: true }).fill("Qualification synthétique de SAV-51, sans publication.");
  await expect(approve).toBeDisabled();

  await openDetails(form.getByText("Corriger ou compléter la connaissance", { exact: true }));
  await form.getByLabel("Objectif et valeur pour le membre", { exact: true }).fill("Choisir le nom d’un espace de démonstration pour le retrouver facilement.");
  const firstStep = form.getByRole("group", { name: "Étape 1", exact: true });
  await firstStep.getByLabel("But de l’étape", { exact: true }).fill("Ouvrir les paramètres de l’espace de démonstration.");
  await firstStep.getByLabel("Instruction complète", { exact: true }).fill("Ouvrir « Paramètres » en bas à gauche, puis « Général ».");
  await firstStep.getByLabel("Résultat observable", { exact: true }).fill("Le champ « Nom de l’espace » est visible.");
  await expect(form.getByLabel("J’ai vérifié la source, la procédure complète et les sujets proches.", { exact: true })).toHaveCount(0);
  await expect(approve).toBeDisabled();
  await form.getByRole("button", { name: "Vérifier la source et comparer", exact: true }).click();
  await expect(form.getByText(/Version du tutoriel source vérifiée/)).toBeVisible();
  await form.getByLabel("J’ai vérifié la source, la procédure complète et les sujets proches.", { exact: true }).check();
  await form.getByLabel("J’ai vérifié et traité les informations manquantes indiquées.", { exact: true }).check();
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page).toHaveURL(/result=draft_ready/);
  await expect(page).toHaveURL(/candidate=[0-9a-f-]+/);
  await expect(card.getByText("Validé", { exact: true })).toBeVisible();
  await expect(card.getByRole("heading", { name: title, exact: true })).toBeVisible();
  const reviewedKnowledge = card.getByRole("region", { name: "Connaissance complète", exact: true });
  await expect(reviewedKnowledge.getByText("Choisir le nom d’un espace de démonstration pour le retrouver facilement.", { exact: true })).toBeVisible();
  await expect(reviewedKnowledge.getByText("Ouvrir « Paramètres » en bas à gauche, puis « Général ».", { exact: true })).toBeVisible();
  await expect(reviewedKnowledge.getByText("Ouvrir la liste concernée et sélectionner l’élément exact à modifier.", { exact: true })).toHaveCount(0);
  await card.getByRole("link", { name: "Ouvrir la projection existante →", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/contenus\/[0-9a-f-]+$/);
  await expect(page.getByRole("textbox", { name: "Titre", exact: true })).toHaveValue(title);
  await expect(page.getByRole("textbox", { name: "Titre", exact: true })).toHaveAttribute("readonly", "");
  await expect(page.getByLabel("Agent concerné", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Agent concerné", { exact: true })).toHaveValue("sav");
  await expect(page.getByText("À valider", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/non destiné à l’agent IA/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Valider et publier", exact: true })).toBeVisible();
  await expect(page.getByText("v1 · active", { exact: true })).toHaveCount(0);
  const result = await request.post("/api/internal/knowledge/search", {
    headers: { Authorization: "Bearer e2e-service-token-that-is-at-least-32-characters" },
    data: { query: "Renommer un espace de démonstration", scope: "sav", contentTypes: ["article"] },
  });
  expect(result.ok()).toBe(true);
  expect((await result.json()).results).toEqual([]);
  await page.screenshot({ path: "test-results/sav51-reviewed-unpublished.jpg", fullPage: true });
  expect(errors).toEqual([]);
});
