import { expect, test } from "@playwright/test";
test("contact manages only the SAV master prompt and can explicitly roll back a reviewed version", async ({ page }) => {
  test.setTimeout(120000);
  await page.setExtraHTTPHeaders({ "x-studio-test-user": "contact@limova.ai" });
  await page.goto("/studio/sav/connaissances/playbook");
  await expect(page.getByRole("heading", { name: "Master prompt SAV", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(1);
  const longPrompt = ("Consigne fictive : comprendre le panneau de démonstration et citer sa source.\n\n".repeat(60)).trim();
  await page.getByLabel("Consignes générales de l’agent").fill(longPrompt);
  await page.getByRole("button", { name: "Enregistrer le brouillon", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Brouillon enregistré");
  await expect(page.getByLabel("Consignes générales de l’agent")).toHaveValue(longPrompt);
  await page.getByRole("button", { name: "Valider la version 1 après relecture", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Version relue");
  await page.getByRole("button", { name: "Activer la version 1", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Version activée");
  await page.getByLabel("Consignes générales de l’agent").fill("Répondre avec une reformulation courte, les faits compris et la prochaine étape sourcée.");
  await page.getByRole("button", { name: "Enregistrer le brouillon", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Brouillon enregistré");
  await page.getByRole("button", { name: "Valider la version 2 après relecture", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Version relue");
  await page.getByRole("button", { name: "Activer la version 2", exact: true }).click();
  await expect(page.getByText("Version active : 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Réactiver cette version", exact: true }).click();
  await expect(page.getByText("Version active : 1", { exact: true })).toBeVisible();
  if (process.env.STUDIO_E2E_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.STUDIO_E2E_SCREENSHOT_DIR}/master-prompt.png`, fullPage: true });
  await page.setExtraHTTPHeaders({ "x-studio-test-user": "reouven@limova.ai" });
  await page.reload();
  await expect(page.getByRole("button", { name: "Enregistrer le brouillon", exact: true })).toBeDisabled();
});
test("knowledge, enrichment and learning remain separate from the master prompt", async ({ page }) => {
  // This journey compiles three distinct pages on a fresh development server.
  test.setTimeout(60_000);
  await page.setExtraHTTPHeaders({ "x-studio-test-user": "contact@limova.ai" });
  await page.goto("/studio/sav/connaissances");
  await expect(page.getByRole("link", { name: "Master prompt SAV", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Enrichir les fiches actives", exact: true }).click();
  await page.waitForURL(url => url.pathname === "/studio/sav/connaissances/diagnostic", { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Enrichir toutes les fiches actives", exact: true })).toBeVisible();
  const [preparation] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/studio/sav/connaissances/diagnostic", { timeout: 30_000 }),
    page.getByRole("button", { name: "Préparer toutes les fiches actives", exact: true }).click(),
  ]);
  // The final message appears only once every page of the action has returned;
  // Chromium may not report the streamed response as finished in development.
  expect(preparation.status()).toBe(200);
  await expect(page.getByRole("status")).toContainText("Préparation terminée");
  await page.goto("/studio/sav/connaissances/apprentissage");
  await expect(page.getByRole("heading", { name: "Apprentissage : signaux à trier", exact: true })).toBeVisible();
});
