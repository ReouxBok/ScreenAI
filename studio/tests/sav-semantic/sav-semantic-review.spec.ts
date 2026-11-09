import {warmSavJourneyRoutes} from "../helpers/journey-warmup";
import { submitServerAction } from "../helpers/server-action";
import { expect, test } from "@playwright/test";
import { SAV_REGISTRATION_E2E_THREAD, SAV_SEMANTIC_E2E_DRAFT, SAV_SEMANTIC_E2E_THREAD } from "../../test/sav-semantic-e2e-fixture";

test.beforeAll(warmSavJourneyRoutes);

test("SAV79 requests identity without suggesting a ticket and preserves dossier/draft review", async ({ page, baseURL }, testInfo) => {
  const externalRequests: string[] = [];
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== baseURL) { externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.goto(`/studio/sav/${SAV_REGISTRATION_E2E_THREAD}`);
  const form = page.getByRole("form", { name: "Proposition de l’IA", exact: true });
  const draft = page.locator("#sav-draft");
  await expect(form).toContainText("Identifier le compte avant toute action");
  await expect(form.locator('input[name="humanAction"]')).toHaveCount(0);
  await expect(form.locator('input[name="humanProcess"]')).toHaveCount(0);
  await expect(draft).toContainText("adresse email utilisée lors de votre inscription à Limova");
  await expect(draft).toContainText("Bonjour,");
  await expect(page.getByRole("button", { name: "Préparer l’aperçu de l’action", exact: true })).toBeDisabled();
  await form.getByRole("checkbox", { name: "J’ai relu la demande et l’étape de vérification du compte.", exact: true }).check();
  await submitServerAction(page, form.getByRole("button", { name: "Valider le dossier", exact: true }));
  await page.waitForURL(/review=saved/, { timeout: 30_000 });
  await expect(page.locator("#sav-action")).toContainText("Dossier · validé par ugo@limova.ai");
  await page.reload();
  await expect(form).toContainText("Identifier le compte avant toute action");
  await expect(form.locator('input[name="humanAction"]')).toHaveCount(0);
  await expect(draft).toContainText("adresse email utilisée lors de votre inscription à Limova");
  await form.getByRole("button", { name: "Choisir manuellement une action après vérification du compte", exact: true }).click();
  await expect(form.getByRole("radio", { name: "Créer un nouveau ticket", exact: true })).toBeVisible();
  // Explicitly opening the manual editor is not a CRM action or a persisted choice.
  await page.reload();
  await expect(form.locator('input[name="humanAction"]')).toHaveCount(0);
  expect(externalRequests).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("sav79-registration-identity.png"), fullPage: true });
});

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
  const draft = page.locator("#sav-draft");
  await expect(understanding).toContainText("L’export du document échoue malgré une nouvelle tentative.");
  await expect(understanding).toContainText("Le document est au format PDF.");
  await expect(understanding).toContainText("Le client a déjà relancé l’export.");
  await expect(understanding).toContainText("Le message d’erreur exact manque.");
  await expect(understanding).toContainText("Une pièce jointe n’a pas été lue.");
  await understanding.getByText("Éléments retenus dans les sources", { exact: true }).click();
  await expect(understanding.getByRole("blockquote")).toContainText("L’export PDF échoue encore après une nouvelle tentative.");
  await expect(draft.getByRole("textbox",{name:"Suggestion de réponse",exact:true})).toHaveValue(SAV_SEMANTIC_E2E_DRAFT);
  await expect(page.locator('textarea[name="replyDraft"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Préparer l’aperçu de l’action", exact: true })).toBeDisabled();

  const ticketTitle = reviewForm.getByRole("textbox", { name: "Titre (4 à 6 mots)", exact: true });
  await expect(ticketTitle).toHaveValue("Échec export PDF fictif");
  // SAV-60 (decided by Ugo): the suggestion is no longer sent from the V0 dossier. No send form, no outbound preview (the AI
  // mention of a sent reply now belongs to the V2 reply contract), a stated reason, and the read-only archive.
  await expect(draft.getByRole("button", { name: "Confirmer l’envoi de cette réponse", exact: true })).toHaveCount(0);
  await expect(draft.locator('input[name="outboundHash"], input[name="recipient"]')).toHaveCount(0);
  await expect(draft.getByRole("status").filter({ hasText: "Ancien circuit retiré : aucun envoi depuis ce dossier." })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Ancien circuit retiré." }).getByRole("link", { name: "l’archive", exact: true })).toHaveAttribute("href", `/studio/sav/archives/${SAV_SEMANTIC_E2E_THREAD}`);
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
  await draft.getByText("Feedback facultatif sur la suggestion",{exact:true}).click();
  await draft.getByRole("textbox", { name: "Commentaire", exact: true }).fill(reason);
  await draft.getByRole("checkbox", { name: "Réponse hors sujet", exact: true }).check();
  await submitServerAction(page, draft.getByRole("button", { name: "Signaler un problème dans la suggestion initiale", exact: true }));
  await page.waitForURL(/review=draft_reviewed/, { timeout: 30_000 });
  await expect(draft).toContainText("Le dossier est suivi sans verdict de brouillon");
  await expect(draft.getByRole("button",{name:"Accepter cette version",exact:true})).toHaveCount(0);

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
  // A form rendered by the feedback RSC has no SSR $ACTION_ID field.
  // Match its existing humanProcess multipart contract, excluding recordOpened JSON.
  await submitServerAction(page, dossier.getByRole("button", { name: "Valider le dossier", exact: true }), /name="(?:_\d+_)?humanProcess"/);
  await page.waitForURL(/review=saved/, { timeout: 30_000 });
  // SAV-60 (decided by Ugo): validating no longer schedules the retired context refresh (A31), so no "context not confirmed"
  // progress appears and the stored context stays displayed. The safety gate is now server side: this harness has no CRM
  // credentials, so preparing the preview is refused, no preview and no confirmation are offered, nothing is written.
  const execution = page.getByLabel("Exécution de l’action", { exact: true });
  const prepare = page.getByRole("button", { name: "Préparer l’aperçu de l’action", exact: true });
  await expect(page.getByText("Contexte non confirmé", { exact: false })).toHaveCount(0);
  await expect(page).not.toHaveURL(/refreshId=|context=/);
  await expect(page.getByText("Contexte collecté le", { exact: false })).toBeVisible();
  const refusePreview = async () => {
    await prepare.click();
    await expect(execution).toContainText("La demande HubSpot n’a pas pu être confirmée. Faites vérifier le journal d’actions avant de reprendre.", { timeout: 30_000 });
    await expect(execution.getByRole("region", { name: "Aperçu de l’action HubSpot", exact: true })).toHaveCount(0);
    await expect(execution.getByRole("button", { name: /^Confirmer :/ })).toHaveCount(0);
  };
  await refusePreview();
  await expect(dossier).toContainText("Dossier · validé par ugo@limova.ai");
  await expect(draft).toContainText("Suggestion disponible");
  await expect(draft.getByRole("button", { name: "Accepter cette version", exact: true })).toHaveCount(0);
  await expect(draft.getByRole("button", { name: "Confirmer l’envoi de cette réponse", exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("checkbox", { name: "J’ai vérifié le compte du demandeur", exact: true })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "Email d’inscription vérifié", exact: true })).toHaveValue("fixture@example.invalid");
  await expect(dossier).toContainText("Dossier · validé par ugo@limova.ai");
  await expect(draft).toContainText("Suggestion disponible");
  await expect(draft.getByRole("button", { name: "Accepter cette version", exact: true })).toHaveCount(0);
  await draft.getByText("Feedback facultatif sur la suggestion",{exact:true}).click();
  await expect(draft.getByRole("textbox", { name: "Commentaire", exact: true })).toHaveValue(reason);
  await expect(draft.getByRole("checkbox", { name: "Réponse hors sujet", exact: true })).toBeChecked();
  await dossier.getByText("Évaluer la proposition de l’IA · facultatif", { exact: false }).click();
  await expect(dossier.getByRole("checkbox", { name: "Connaissance manquante", exact: true })).toBeChecked();
  await expect(dossier.getByRole("combobox", { name: "Verdict global", exact: true })).toHaveValue("partial");
  await expect(dossier.getByRole("combobox", { name: "Fiabilité", exact: true })).toHaveValue("partial");
  await expect(draft.getByRole("textbox",{name:"Suggestion de réponse",exact:true})).toHaveValue(SAV_SEMANTIC_E2E_DRAFT);
  await openUnderstanding();
  await expect(understanding).toContainText("L’export du document échoue malgré une nouvelle tentative.");
  await expect(page.getByText("Aucun ticket lié à ce dossier.", { exact: true })).toBeVisible();
  await refusePreview(); // still refused after a reload, still no ticket linked
  await expect(draft.getByRole("button", { name: "Confirmer l’envoi de cette réponse", exact: true })).toHaveCount(0);
  expect(externalRequests).toEqual([]); expect(browserErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("sav44-independent-semantic-review.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(reviewForm.getByRole("button", { name: "Valider le dossier", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Avancement du dossier", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("sav75-mobile.png"), fullPage: true });
});
