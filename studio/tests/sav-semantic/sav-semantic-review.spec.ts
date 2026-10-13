import { expect, test } from "@playwright/test";
import { SAV_SEMANTIC_E2E_DRAFT, SAV_SEMANTIC_E2E_THREAD } from "../../test/sav-semantic-e2e-fixture";

test("SAV44 exposes understanding and persists independent dossier/draft feedback", async ({ page, baseURL }, testInfo) => {
  const externalRequests: string[] = [];
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== baseURL) { externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.goto(`/studio/sav/${SAV_SEMANTIC_E2E_THREAD}`);
  const understanding = page.getByRole("region", { name: "Compréhension initiale", exact: true });
  const dossier = page.getByRole("region", { name: "Proposition de l’IA", exact: true });
  const draft = page.getByRole("region", { name: "Verdict du brouillon", exact: true });
  await expect(understanding).toContainText("L’export du document échoue malgré une nouvelle tentative.");
  await expect(understanding).toContainText("Le document est au format PDF.");
  await expect(understanding).toContainText("Le client a déjà relancé l’export.");
  await expect(understanding).toContainText("Le message d’erreur exact manque.");
  await expect(understanding).toContainText("Une pièce jointe n’a pas été lue.");
  await understanding.getByText("Éléments retenus dans les sources", { exact: true }).click();
  await expect(understanding.getByRole("blockquote")).toContainText("L’export PDF échoue encore après une nouvelle tentative.");
  await expect(draft.locator("pre").first()).toHaveText(SAV_SEMANTIC_E2E_DRAFT);
  await expect(page.locator('textarea[name="replyDraft"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Ouvrir un nouveau ticket/ })).toBeDisabled();

  const reason = "Recette synthétique : le brouillon doit être repris par un humain.";
  await draft.getByRole("textbox", { name: "Motif du refus (facultatif)", exact: true }).fill(reason);
  await draft.getByRole("checkbox", { name: "Réponse hors sujet", exact: true }).check();
  await draft.getByRole("button", { name: "Refuser le brouillon", exact: true }).click();
  await expect(draft.getByText("Brouillon refusé · traitement humain à observer.", { exact: true })).toBeVisible();

  await dossier.getByText("Évaluer la proposition et proposer une connaissance", { exact: true }).click();
  await dossier.getByRole("checkbox", { name: "Connaissance manquante", exact: true }).check();
  await dossier.getByRole("combobox", { name: "Verdict global", exact: true }).selectOption("partial");
  await dossier.getByRole("combobox", { name: "Fiabilité", exact: true }).selectOption("partial");
  await dossier.getByRole("button", { name: "Valider le dossier / process", exact: true }).click();
  await expect(dossier).toContainText("Dossier · Process validé par ugo@limova.ai");
  await expect(draft).toContainText("Brouillon refusé · traitement humain à observer.");
  await expect(page.getByRole("button", { name: /^Ouvrir un nouveau ticket/ })).toBeEnabled();
  await expect(draft.getByRole("button", { name: "Envoyer la réponse acceptée", exact: true })).toBeDisabled();

  await page.reload();
  await expect(dossier).toContainText("Dossier · Process validé par ugo@limova.ai");
  await expect(draft).toContainText("Brouillon refusé · traitement humain à observer.");
  await expect(draft.getByRole("textbox", { name: "Motif du refus (facultatif)", exact: true })).toHaveValue(reason);
  await expect(draft.getByRole("checkbox", { name: "Réponse hors sujet", exact: true })).toBeChecked();
  await dossier.getByText("Évaluer la proposition et proposer une connaissance", { exact: true }).click();
  await expect(dossier.getByRole("checkbox", { name: "Connaissance manquante", exact: true })).toBeChecked();
  await expect(dossier.getByRole("combobox", { name: "Verdict global", exact: true })).toHaveValue("partial");
  await expect(dossier.getByRole("combobox", { name: "Fiabilité", exact: true })).toHaveValue("partial");
  await expect(draft.locator("pre").first()).toHaveText(SAV_SEMANTIC_E2E_DRAFT);
  await expect(understanding).toContainText("L’export du document échoue malgré une nouvelle tentative.");
  await expect(page.getByText("Aucun ticket lié à ce dossier.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ouvrir un nouveau ticket/ })).toBeEnabled();
  await expect(draft.getByRole("button", { name: "Envoyer la réponse acceptée", exact: true })).toBeDisabled();
  expect(externalRequests).toEqual([]); expect(browserErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("sav44-independent-semantic-review.png"), fullPage: true });
});
