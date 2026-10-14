import { expect, test } from "@playwright/test";

test("contact validates a SAV candidate without gaining publication or global admin rights", async ({ page, request }) => {
  test.setTimeout(120_000);
  const title = "Procédure synthétique SAV-54 — choisir un format";
  const bundle = { schemaVersion: 1, namespace: "e2e-sav54", entries: [{ externalId: "format", title,
    document: { schemaVersion: 1, objective: title, applicability: "sav_only", locale: "fr-FR", prerequisites: [], expectedResult: "Format fictif choisi.", exceptions: [], escalation: "Demander une vérification humaine.",
      steps: [{ id: "format.choose", userLabel: "Format", objective: title, instruction: "Sélectionner le format de démonstration.", expectedResult: "Format fictif choisi.", escalation: "Demander une vérification humaine." }] },
    provenance: { sources: [{ emailId: "123", url: "https://app.hubspot.com/contacts/1/email/123", date: "2026-10-01T10:00:00.000Z", ticketIds: [] }], validationNotes: ["Fixture synthétique uniquement."] },
  }] };
  await page.setExtraHTTPHeaders({ "x-studio-test-user": "ugo@limova.ai" });
  await page.goto("/studio/sav/connaissances/imports");
  await page.getByText("Importer des fiches HubSpot", { exact: true }).click();
  await page.getByLabel("Base de connaissances privée").setInputFiles({ name: "fixture.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bundle)) });
  await page.getByRole("button", { name: "Préparer les candidats SAV" }).click();
  await expect(page.getByRole("status")).toContainText("Import préparé");

  await page.setExtraHTTPHeaders({ "x-studio-test-user": "contact@limova.ai" });
  await page.reload();
  const card = page.locator("article[id^='candidate-']").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(page.getByText("Membre", { exact: true }).first()).toBeVisible();
  await card.getByText("Revoir, corriger ou écarter cette connaissance", { exact: true }).click();
  const approve = card.getByRole("button", { name: "Valider et préparer le brouillon SAV", exact: true });
  await expect(approve).toBeDisabled();
  await card.getByRole("button", { name: "Actualiser la comparaison", exact: true }).click();
  await card.getByRole("checkbox", { name: /J’ai vérifié les sources, le contenu corrigé/ }).check();
  await card.getByLabel("Motif de la décision", { exact: true }).fill("Source fictive et procédure relues par contact dans la recette.");
  await approve.click();
  await expect(page.getByRole("status")).toContainText("Décision enregistrée");
  await expect(card.getByText("Validé", { exact: true })).toBeVisible();
  await card.getByText("Lire la connaissance et ses limites", { exact: true }).click();
  await expect(card.getByText(/Revu par contact@limova.ai/)).toBeVisible();
  await card.getByRole("link", { name: "Ouvrir la projection existante →", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/contenus\/[0-9a-f-]+$/, { timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Gestion du contenu", exact: true }).getByText("À valider", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Valider et publier", exact: true })).toHaveCount(0);
  const result = await request.post("/api/internal/knowledge/search", {
    headers: { Authorization: "Bearer e2e-service-token-that-is-at-least-32-characters" },
    data: { query: title, scope: "sav", contentTypes: ["article"] },
  });
  expect(result.ok()).toBe(true);
  expect((await result.json()).results).toEqual([]);
});
