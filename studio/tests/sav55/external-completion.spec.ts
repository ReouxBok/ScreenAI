import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page, baseURL }) => {
  await page.route("**/*", route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
});

test("un dossier traité hors Studio est terminé sans fausse validation IA", async ({ page }, testInfo) => {
  await page.goto("/studio/sav?view=completed&q=SAV62");
  const ledger = page.getByRole("region", { name: "Dossiers SAV", exact: true });
  await expect(ledger.getByRole("button", { name: /^Ouvrir l’email/ })).toHaveCount(1);
  await expect(ledger.getByText("Traité hors Studio", { exact: true })).toHaveCount(2);
  await expect(ledger.getByText("Classement administratif", { exact: false })).toBeVisible();
  await expect(ledger.getByText("Dossier validé", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("external-completion-dashboard.png"), fullPage: true });
  // Direct URL only: never request Gmail filing in this test.
  await page.goto("/studio/sav/62000000-0000-4000-8000-000000000001");
  await expect(page.getByRole("status").filter({ hasText: "Traité hors Studio." })).toContainText("Cela ne valide ni la proposition IA ni le brouillon et ne crée aucun apprentissage");
  await page.screenshot({ path: testInfo.outputPath("external-completion-detail.png"), fullPage: true });
});

test("une nouvelle réponse n’hérite pas du classement externe du fil", async ({ page }) => {
  await page.goto("/studio/sav?view=to_process&q=SAV62");
  const ledger = page.getByRole("region", { name: "Dossiers SAV", exact: true });
  await expect(ledger.getByRole("button", { name: "Ouvrir l’email : SAV62 nouvelle réponse après traitement externe", exact: true })).toBeVisible();
  await expect(ledger.getByText("Traité hors Studio", { exact: true })).toHaveCount(0);
  await page.goto("/studio/sav/62000000-0000-4000-8000-000000000002");
  await expect(page.getByRole("status").filter({ hasText: "Traité hors Studio." })).toHaveCount(0);
});
