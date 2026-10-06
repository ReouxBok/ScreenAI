import { expect, test } from "@playwright/test";

test("Ugo recompare le contenu corrigé avant de préparer un brouillon SAV", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setExtraHTTPHeaders({ "x-studio-test-user": "ugo@limova.ai" });
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const title = "Exporter une démonstration fictive E2E";
  const bundle = { schemaVersion: 1, namespace: "e2e-review", entries: [{ externalId: "export-demo", title,
    document: { schemaVersion: 1, objective: title, applicability: "sav_only", locale: "fr-FR", productVersion: "demo", prerequisites: [], expectedResult: "Export fictif visible.", exceptions: [], escalation: "Consulter un humain.",
      steps: [{ id: "export.step-1", userLabel: "Format", objective: title, instruction: "Choisir le format fictif.", expectedResult: "Format choisi.", escalation: "Consulter un humain." }] },
    provenance: { sources: [{ emailId: "123", url: "https://app.hubspot.com/contacts/1/email/123", date: "2026-09-08T10:00:00.000Z", ticketIds: [] }], validationNotes: ["Fixture synthétique uniquement."] },
  }] };
  await page.goto("/studio/sav/connaissances");
  await expect(page.getByRole("heading", { name: "Connaissances SAV à valider" })).toBeVisible();
  await page.getByText("Importer des fiches HubSpot", { exact: true }).click();
  await page.getByLabel("Base de connaissances privée").setInputFiles({ name: "fixture.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bundle)) });
  await page.getByRole("button", { name: "Préparer les candidats SAV" }).click();
  await expect(page.getByRole("status")).toContainText("Import préparé");
  const approve = page.getByRole("button", { name: "Valider et préparer le brouillon SAV" });
  await expect(approve).toBeDisabled();
  await page.getByRole("button", { name: "Actualiser la comparaison" }).click();
  const acknowledgment = page.getByRole("checkbox", { name: /J’ai vérifié les sources, le contenu corrigé/ });
  await acknowledgment.check();
  await expect(approve).toBeEnabled();
  await page.getByText("Corriger la connaissance avant validation (JSON métier, sans DOM)", { exact: true }).click();
  const editor = page.getByLabel("Connaissance complète");
  const document = JSON.parse(await editor.inputValue());
  document.steps[0].instruction = "Choisir le nouveau format fictif corrigé.";
  await editor.fill(JSON.stringify(document));
  await expect(approve).toBeDisabled();
  await expect(acknowledgment).toHaveCount(0);
  await page.getByRole("button", { name: "Actualiser la comparaison" }).click();
  await expect(page.getByRole("region", { name: "Comparaison du contenu corrigé" })).toContainText(document.steps[0].instruction);
  await acknowledgment.check();
  await page.getByLabel("Motif de la décision").fill("Sources fictives et correction revues dans le test navigateur.");
  await approve.click();
  await expect(page.getByRole("status")).toContainText("Décision enregistrée");
  await expect(page.locator("article").filter({ hasText: title }).getByText("Validé", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Ouvrir la projection existante →" }).click();
  await expect(page.getByText("À valider", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".tiptap")).toContainText(document.steps[0].instruction);
  await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});
