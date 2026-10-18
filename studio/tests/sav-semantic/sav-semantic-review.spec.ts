import { submitServerAction } from "../helpers/server-action";
import { expect, test } from "@playwright/test";
import { SAV_SEMANTIC_E2E_DRAFT, SAV_SEMANTIC_E2E_THREAD } from "../../test/sav-semantic-e2e-fixture";

test("SAV76 diagnostics are readable directly without opening or replaying the dossier", async ({ request }) => {
  const response = await request.get(`/api/internal/sav/dossiers/${SAV_SEMANTIC_E2E_THREAD}/diagnostics`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  const data = await response.json();
  expect(data.runs).toHaveLength(1);
  expect(data.runs[0]).toMatchObject({ historicalDetailUnavailable: true, proposalReadable: true });
  expect(JSON.stringify(data)).not.toMatch(/fixture-customer|export PDF|Bonjour/);
  const denied = await request.get(`/api/internal/sav/dossiers/${SAV_SEMANTIC_E2E_THREAD}/diagnostics`, { headers: { "x-studio-test-user": "stranger@example.invalid" } });
  expect(denied.status()).toBe(403);
});

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
  const dossier = page.locator("#sav-action");
  const reviewForm = page.getByRole("form", { name: "Proposition de l’IA", exact: true });
  const openUnderstanding = () => page.locator("#sav-findings summary").filter({ hasText: "Compréhension initiale de l’IA" }).click();
  await openUnderstanding();
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
  await expect(page.getByRole("button", { name: "Préparer l’aperçu de l’action", exact: true })).toBeDisabled();

  const ticketTitle = reviewForm.getByRole("textbox", { name: "Titre (4 à 6 mots)", exact: true });
  await expect(ticketTitle).toHaveValue("Échec export PDF fictif");
  const preview = draft.locator("details").filter({has: page.getByText("Aperçu de l’email après validation", {exact:true})});
  await preview.locator("summary").click();
  await expect(preview.locator("pre")).toContainText("L’équipe Limova");
  await expect(preview.locator("pre")).toContainText("validée par notre équipe");
  await expect(preview.locator("pre")).not.toContainText("envoyée automatiquement");
  await expect(reviewForm.getByRole("radio")).toHaveCount(6);
  for (const action of ["partnership", "commercial", "no_ticket", "link_ticket", "reopen_ticket", "create_ticket"]) {
    await reviewForm.locator(`label:has(input[name="humanAction"][value="${action}"])`).click();
    await expect(reviewForm.locator(`input[name="humanAction"][value="${action}"]`)).toBeChecked();
    if (["create_ticket", "reopen_ticket"].includes(action)) await expect(ticketTitle).toBeVisible();
    else await expect(ticketTitle).toBeHidden();
    await expect(reviewForm.locator('input[type="checkbox"][required]')).not.toBeChecked();
    if (action === "link_ticket" || action === "reopen_ticket") {
      const query = reviewForm.getByRole("searchbox", { name: "Rechercher le ticket concerné", exact: true });
      const choices = reviewForm.getByRole("radiogroup", { name: "Ticket concerné", exact: true });
      await expect(choices.getByRole("radio")).toHaveCount(action === "link_ticket" ? 2 : 1);
      await query.fill(action === "link_ticket" ? "VPN" : "PDF");
      await expect(choices.getByRole("radio")).toHaveCount(1);
      await choices.getByRole("radio").locator("..").click();
      await expect(choices.getByRole("radio")).toBeChecked();
      await query.fill("introuvable-fixture");
      await expect(choices).toContainText("Aucun ticket ne correspond à cette recherche.");
      expect(await reviewForm.evaluate(form => (form.querySelector('input[name="humanTicket"]') as HTMLInputElement).validity.valueMissing)).toBe(false);
      await query.fill("");
      await expect(choices.getByRole("radio", { checked: true })).toHaveCount(1);
    }
  }
  const reason = "Recette synthétique : le brouillon doit être repris par un humain.";
  await draft.getByRole("textbox", { name: "Motif du refus (facultatif)", exact: true }).fill(reason);
  await draft.getByRole("checkbox", { name: "Réponse hors sujet", exact: true }).check();
  await submitServerAction(page, draft.getByRole("button", { name: "Refuser le brouillon", exact: true }));
  await page.waitForURL(/review=draft_reviewed/, { timeout: 30_000 });
  await expect(draft.getByText("Brouillon refusé · traitement humain à observer.", { exact: true })).toBeVisible();

  await dossier.getByText("Évaluer la proposition de l’IA · facultatif", { exact: false }).click();
  await dossier.getByRole("checkbox", { name: "Connaissance manquante", exact: true }).check();
  await dossier.getByRole("combobox", { name: "Verdict global", exact: true }).selectOption("partial");
  await dossier.getByRole("combobox", { name: "Fiabilité", exact: true }).selectOption("partial");
  const processConfirmation = reviewForm.getByRole("checkbox", { name: "J’ai vérifié la demande : c’est un problème distinct des tickets ouverts.", exact: true });
  await expect(processConfirmation).toHaveAttribute("required");
  await expect(processConfirmation).not.toBeChecked();
  // Identity fields live in section 2 and must still submit with the section 3 form.
  await page.getByRole("checkbox", { name: "J’ai vérifié le compte du demandeur", exact: true }).check();
  await page.getByRole("textbox", { name: "Email d’inscription vérifié", exact: true }).fill("fixture@example.invalid");
  const formData = await reviewForm.evaluate(form => {
    const data = new FormData(form as HTMLFormElement);
    return { identityVerified: data.get("identityVerified"), registrationEmail: data.get("registrationEmail") };
  });
  expect(formData).toEqual({ identityVerified: "on", registrationEmail: "fixture@example.invalid" });

  await processConfirmation.check();
  await submitServerAction(page, dossier.getByRole("button", { name: "Valider le dossier", exact: true }));
  await page.waitForURL(/review=saved/, { timeout: 30_000 });
  await expect(dossier).toContainText("Dossier · validé par ugo@limova.ai");
  await expect(draft).toContainText("Contexte ou texte modifié : nouvelle lecture nécessaire.");
  await expect(draft.getByRole("button", { name: "Accepter cette version", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Préparer l’aperçu de l’action", exact: true })).toBeEnabled();
  await expect(draft.getByRole("button", { name: "Envoyer la réponse acceptée", exact: true })).toBeDisabled();

  await page.reload();
  await expect(page.getByRole("checkbox", { name: "J’ai vérifié le compte du demandeur", exact: true })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "Email d’inscription vérifié", exact: true })).toHaveValue("fixture@example.invalid");
  await expect(dossier).toContainText("Dossier · validé par ugo@limova.ai");
  await expect(draft).toContainText("Contexte ou texte modifié : nouvelle lecture nécessaire.");
  await expect(draft.getByRole("button", { name: "Accepter cette version", exact: true })).toBeEnabled();
  await expect(draft.getByRole("textbox", { name: "Motif du refus (facultatif)", exact: true })).toHaveValue(reason);
  await expect(draft.getByRole("checkbox", { name: "Réponse hors sujet", exact: true })).toBeChecked();
  await dossier.getByText("Évaluer la proposition de l’IA · facultatif", { exact: false }).click();
  await expect(dossier.getByRole("checkbox", { name: "Connaissance manquante", exact: true })).toBeChecked();
  await expect(dossier.getByRole("combobox", { name: "Verdict global", exact: true })).toHaveValue("partial");
  await expect(dossier.getByRole("combobox", { name: "Fiabilité", exact: true })).toHaveValue("partial");
  await expect(draft.locator("pre").first()).toHaveText(SAV_SEMANTIC_E2E_DRAFT);
  await openUnderstanding();
  await expect(understanding).toContainText("L’export du document échoue malgré une nouvelle tentative.");
  await expect(page.getByText("Aucun ticket lié à ce dossier.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Préparer l’aperçu de l’action", exact: true })).toBeEnabled();
  await expect(draft.getByRole("button", { name: "Envoyer la réponse acceptée", exact: true })).toBeDisabled();
  expect(externalRequests).toEqual([]); expect(browserErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("sav44-independent-semantic-review.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(reviewForm.getByRole("button", { name: "Valider le dossier", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Avancement du dossier", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("sav75-mobile.png"), fullPage: true });
});
