import { expect, request as playwrightRequest, test } from "@playwright/test";
import { submitServerAction } from "../helpers/server-action";

// Cold webpack compilation of the knowledge route can take several minutes on
// the local 8 GB test machine. Warm read-only routes before the browser scenario
// timer; keep all business assertions and action timeouts unchanged.
test.beforeAll(async () => {
  test.setTimeout(600_000);
  const api = await playwrightRequest.newContext({ baseURL: "http://127.0.0.1:3125" });
  try {
    expect((await api.get("/studio/sav/connaissances/proposer", { timeout: 300_000 })).status()).toBe(200);
    expect((await api.get("/studio/sav/connaissances/00000000-0000-4000-8000-000000000000?kind=item", { timeout: 300_000 })).status()).toBe(404);
  } finally {
    await api.dispose();
  }
});

test.beforeEach(async ({ page, baseURL }) => {
  await page.route("**/*", route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
});

test("proposition humaine : brouillon, revue Contact, publication puis activation Ugo séparées", async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setExtraHTTPHeaders({ "x-studio-test-user": "ugo@limova.ai" });
  const title = "Renommer une maquette de démonstration SAV55";
  await page.goto("/studio/sav/connaissances/proposer");
  await page.getByLabel("Titre de la connaissance", { exact: true }).fill(title);
  await page.getByLabel("Demande couverte et valeur pour le client", { exact: true }).fill("Retrouver une maquette de démonstration grâce à un nom explicite.");
  await page.getByLabel("Conditions et prérequis — un par ligne", { exact: true }).fill("Disposer d’une maquette dans un espace de démonstration.");
  await page.getByRole("button", { name: "Ajouter une étape", exact: true }).click();
  await page.getByLabel("Nom de l’étape", { exact: true }).fill("Choisir le nom de la maquette");
  await page.getByLabel("But de l’étape", { exact: true }).fill("Identifier la bonne maquette de démonstration.");
  await page.getByLabel("Instruction", { exact: true }).fill("Ouvrir la maquette fictive et saisir un nom explicite dans son champ de titre.");
  await page.getByLabel("Résultat observable", { exact: true }).fill("Le nouveau nom apparaît sur la maquette de démonstration.");
  await page.getByLabel("Résultat attendu de la procédure", { exact: true }).fill("La maquette est identifiable dans la liste de démonstration.");
  await page.getByLabel("Exceptions et limites — une par ligne", { exact: true }).fill("Procédure fictive réservée aux données de recette.");
  await page.getByLabel("Quand et comment passer la main", { exact: true }).fill("Demander une vérification humaine si le nom ne se met pas à jour.");
  await page.getByLabel("Motif de la création ou de l’amélioration", { exact: true }).fill("Procédure synthétique et sourcée pour vérifier le parcours SAV55.");
  await page.getByLabel("Nom de la source 1", { exact: true }).fill("Documentation fictive de recette");
  await page.getByLabel("Référence de la source 1", { exact: true }).fill("https://example.invalid/sav55/maquette");
  await submitServerAction(page, page.getByRole("button", { name: "Enregistrer le brouillon", exact: true }));
  await expect(page.getByRole("status")).toContainText("Brouillon interne enregistré");
  expect(page.url()).toContain("?draft=");
  await submitServerAction(page, page.getByRole("button", { name: "Enregistrer et voir l’aperçu", exact: true }));
  const preview = page.getByRole("region", { name: "Aperçu avant soumission" });
  await expect(preview).toBeVisible();
  const submit = preview.getByRole("button", { name: "Confirmer et soumettre à validation" });
  await expect(submit).toBeDisabled();
  await page.screenshot({ path: "test-results/sav55-proposal-preview.png", fullPage: true });
  await preview.getByRole("checkbox").check();
  await submitServerAction(page, submit);
  await page.waitForURL(/\/connaissances\/[a-f0-9-]+\?kind=candidate/);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  const candidateUrl = page.url();
  await page.setExtraHTTPHeaders({ "x-studio-test-user": "contact@limova.ai" }); await page.reload();
  const review = page.getByRole("region", { name: "Revue de la proposition" });
  await submitServerAction(page, review.getByRole("button", { name: "Vérifier les sources et comparer" }));
  await expect(review.getByRole("heading", { name: "Comparaison courante" })).toBeVisible();
  await review.getByRole("checkbox").check();
  await review.getByLabel("Motif de la décision", { exact: true }).fill("Source fictive et procédure complète vérifiées par le compte contact.");
  await submitServerAction(page, review.getByRole("button", { name: "Valider la proposition", exact: true }));
  await expect(page.getByText("Validée · à publier", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publier la version validée" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Activer cette version pour le SAV" })).toHaveCount(0);
  await page.setExtraHTTPHeaders({ "x-studio-test-user": "ugo@limova.ai" }); await page.goto(candidateUrl);
  await page.getByRole("button", { name: "Publier la version validée" }).click();
  await submitServerAction(page, page.getByRole("button", { name: "Confirmer la publication", exact: true }));
  await expect(page.getByText("Publiée · à activer", { exact: true })).toBeVisible();
  const search = () => request.post("/api/internal/knowledge/search", { headers: { Authorization: "Bearer synthetic-e2e-service-token-at-least-32-characters" }, data: { query: title, scope: "sav", contentTypes: ["article"] } });
  const before = await search(); expect(before.ok()).toBe(true); expect((await before.json()).results.some((result: { title: string }) => result.title === title)).toBe(false);
  await page.getByRole("button", { name: "Activer cette version pour le SAV" }).click();
  await submitServerAction(page, page.getByRole("button", { name: "Confirmer l’activation", exact: true }));
  await expect(page.getByText("En production", { exact: true })).toBeVisible();
  const after = await search(); expect(after.ok()).toBe(true); expect((await after.json()).results.some((result: { title: string }) => result.title === title)).toBe(true);
  await page.screenshot({ path: "test-results/sav55-knowledge-active.png", fullPage: true });
  await page.goto(`/studio/sav/connaissances?tab=production&q=${encodeURIComponent(title)}`);
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/sav55-library.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("bibliothèque vide et proposition conservent les actions lisibles sur ordinateur", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setExtraHTTPHeaders({ "x-studio-test-user": "contact@limova.ai" });
  await page.goto("/studio/sav/connaissances?tab=human&q=sans-resultat-fictif-sav55");
  await expect(page.getByRole("heading", { name: "Aucune connaissance pour ces filtres" })).toBeVisible();
  for (const label of ["En production", "À valider apprentissage automatique", "À valider proposition Humaine"]) await expect(page.getByRole("link", { name: new RegExp(label) })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole("link", { name: "Proposer une connaissance", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Proposer une connaissance", exact: true })).toBeVisible();
  await expect(page.getByLabel("Titre de la connaissance", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/sav55-knowledge-proposal.png", fullPage: true });
});
