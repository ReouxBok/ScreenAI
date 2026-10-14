import { expect, test, type Page } from "@playwright/test";
import { SAV53_BODY, SAV53_CURRENT, SAV53_PARTNERSHIP, SAV53_QUOTED, SAV53_THREADS, SAV53_TICKET_TITLE } from "../../test/sav53-e2e-fixture";

const duplicateKeyWarnings = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page, baseURL }) => {
  const warnings: string[] = [];
  duplicateKeyWarnings.set(page, warnings);
  page.on("console", message => { if (/same key|unique.*key.*prop/i.test(message.text())) warnings.push(message.text()); });
  await page.route("**/*", route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
});
test.afterEach(async ({ page }) => {
  expect(duplicateKeyWarnings.get(page)).toEqual([]);
});

test("le dernier email reçu est seul visible puis la conversation entière remplace le résumé sans doublon", async ({ page }, testInfo) => {
  await page.goto(`/studio/sav/${SAV53_THREADS.conversation}`);
  const mail = page.getByRole("region", { name: "Dernier email reçu", exact: true });
  await expect(mail.locator("article")).toHaveCount(1);
  await expect(mail.locator("pre")).toHaveText(SAV53_CURRENT);
  await expect(mail).not.toContainText(SAV53_QUOTED);
  await expect(mail).not.toContainText("Signature synthétique à replier");
  await expect(mail).not.toContainText("Ancien email entrant conservé intégralement.");
  await expect(mail).not.toContainText("Réponse sortante plus récente, masquée au départ.");
  await expect(mail.getByRole("button", { name: /^Afficher toute la conversation/ })).toHaveAttribute("aria-expanded", "false");
  await mail.getByRole("button", { name: /^Afficher toute la conversation/ }).click();
  await expect(mail.locator("article")).toHaveCount(3);
  const history = mail.getByRole("region", { name: "Conversation complète avec défilement", exact: true });
  await expect(history).toHaveAttribute("tabindex", "0");
  await expect(history).toHaveCSS("overflow-y", "auto");
  expect(await history.evaluate(element => Number.parseFloat(getComputedStyle(element).maxHeight))).toBeLessThanOrEqual(640);
  await expect(mail.locator("pre").nth(0)).toHaveText(SAV53_BODY);
  await expect(mail.locator("pre").nth(1)).toHaveText("Réponse sortante plus récente, masquée au départ.");
  await expect(mail.locator("pre").nth(2)).toHaveText("Ancien email entrant conservé intégralement.");
  await expect(mail.getByRole("button", { name: "Réduire la conversation", exact: true })).toHaveAttribute("aria-expanded", "true");
  await mail.getByText("1 pièce(s) jointe(s) — non analysée(s)", { exact: true }).click();
  await expect(mail.getByText(/capture-fictive.txt/)).toBeVisible();
  await mail.getByRole("button", { name: "Réduire la conversation", exact: true }).click();
  await expect(mail.locator("article")).toHaveCount(1);
  await expect(mail.locator("pre")).toHaveText(SAV53_CURRENT);
  await page.reload();
  await expect(mail.locator("pre")).toHaveText(SAV53_CURRENT);
  await page.screenshot({ path: testInfo.outputPath("sav53-conversation-repliee.png"), fullPage: true });
});

test("un email unique avec citation peut être développé, un email sans citation reste complet", async ({ page }) => {
  await page.goto(`/studio/sav/${SAV53_THREADS.singleQuoted}`);
  let mail = page.getByRole("region", { name: "Dernier email reçu", exact: true });
  await expect(mail.locator("pre")).toHaveText(SAV53_CURRENT);
  await mail.getByRole("button", { name: /^Afficher toute la conversation/ }).click();
  await expect(mail.locator("pre")).toHaveText(SAV53_BODY);
  await expect(mail.locator("article")).toHaveCount(1);
  await page.goto(`/studio/sav/${SAV53_THREADS.singlePlain}`);
  mail = page.getByRole("region", { name: "Dernier email reçu", exact: true });
  await expect(mail.locator("pre")).toHaveText(SAV53_CURRENT);
  await expect(mail.getByRole("button", { name: /^Afficher toute la conversation/ })).toHaveCount(0);
});

for (const scenario of [
  { key: "reopen", label: "Réouvrir le ticket", explanation: "Le ticket existant passe en Nouveau." },
  { key: "waiting", label: "Repasser en Nouveau", explanation: "Le ticket existant passe en Nouveau." },
  { key: "successor", label: "Ouvrir un nouveau ticket", explanation: "fermé depuis plus de 15 jours" },
  { key: "alreadyNew", label: "Rattacher le ticket", explanation: "Ce ticket est déjà en Nouveau." },
] as const) {
  test(`${scenario.key} : sélection nommée et aperçu séparé après validation locale`, async ({ page }) => {
    await page.goto(`/studio/sav/${SAV53_THREADS[scenario.key]}`);
    const rail = page.getByRole("complementary", { name: "Contexte client et actions", exact: true });
    const selected = rail.getByRole("radio", { name: new RegExp(`^${SAV53_TICKET_TITLE} #\\d+`) });
    const newTicket = rail.getByRole("radio", { name: `Ouvrir un nouveau ticket ${SAV53_TICKET_TITLE}`, exact: true });
    await expect(selected).toBeChecked();
    await expect(newTicket).not.toBeChecked();
    const prepare = rail.getByRole("button", { name: "Préparer l’aperçu de l’action", exact: true });
    await expect(prepare).toBeDisabled();
    await expect(rail.getByRole("region", { name: "Aperçu de l’action HubSpot", exact: true })).toHaveCount(0);
    await page.getByRole("region", { name: "Proposition de l’IA", exact: true }).getByRole("button", { name: "Valider le dossier / process", exact: true }).click();
    await page.waitForURL(/\?review=saved$/, { timeout: 30_000 });
    await expect(page.getByRole("region", { name: "Proposition de l’IA", exact: true })).toContainText("Process validé par ugo@limova.ai");
    await expect(prepare).toBeEnabled();
    await expect(selected).toBeChecked();
    await expect(newTicket).not.toBeChecked();
    // Selecting a target never queues an action. Fresh CRM checks are tested
    // with synthetic responses in the isolated DB combination suite.
    await expect(rail.locator('input[name="ticketId"]')).toHaveCount(0);
    await page.reload();
    await expect(prepare).toBeEnabled();
    await expect(rail).toContainText("Écritures HubSpot désactivées");
  });
}

test("la liste distingue thème, souci et action sans exposer une erreur technique comme résumé", async ({ page }, testInfo) => {
  // The current inbox classifies the latest message by its local opening state.
  // Open both fixtures explicitly so this scenario also works when run alone.
  for (const threadId of [SAV53_THREADS.singlePlain, SAV53_THREADS.failed]) {
    const path = `/studio/sav/${threadId}`;
    const opened = page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname === path && Boolean(response.request().headers()["next-action"]));
    await page.goto(path);
    const response = await opened;
    await response.finished();
    expect(response.ok()).toBe(true);
  }
  await page.goto("/studio/sav?view=to_validate&q=example.invalid");
  const tabs = page.getByRole("navigation", { name: "Vues SAV", exact: true });
  await expect(tabs.getByRole("link", { name: /^À valider/ })).toHaveAttribute("aria-current", "page");
  const ledger = page.getByRole("region", { name: "Dossiers SAV", exact: true });
  const row = ledger.getByRole("button", { name: "Ouvrir l’email : Problème technique : Produit fictif · Export", exact: true }).filter({ has: page.getByText("singlePlain@example.invalid", { exact: true }) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("L’export du document échoue malgré une nouvelle tentative.");
  await expect(row).toContainText("Relire et valider le dossier");
  await expect(row).toContainText("Dossier à valider");
  await expect(row).toContainText("Action ticket à confirmer");
  await expect(row).not.toContainText("Re: Re:");
  const failed = ledger.getByRole("button", { name: "Ouvrir l’email : Assistance téléphonie fictive", exact: true });
  await expect(failed).toContainText("Aucun résumé fiable disponible. Le message doit être relu.");
  await expect(failed).toContainText("Qualifier la demande manuellement");
  await expect(failed).toContainText("Vérification nécessaire");
  await expect(failed).not.toContainText("SAV_AI_TIMEOUT");
  await expect(failed.locator('[title="SAV_AI_TIMEOUT"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("sav53-liste-resumes.png"), fullPage: true });
});

test("le transfert partenariat exige un aperçu, un destinataire fixe et une confirmation distincte bloquée en recette", async ({ page }, testInfo) => {
  const external: string[] = [];
  page.on("request", request => { if (/googleapis|gmail|hubspot/i.test(request.url())) external.push(request.url()); });
  await page.goto(`/studio/sav/${SAV53_THREADS.partnership}`);
  const transfer = page.getByRole("region", { name: "Transfert partenariat", exact: true });
  await expect(transfer).toBeVisible();
  await expect(transfer.getByRole("button", { name: "Confirmer l’envoi à Nathan", exact: true })).toHaveCount(0);
  const [prepared] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/studio/sav/${SAV53_THREADS.partnership}`),
    transfer.getByRole("button", { name: "Préparer le transfert à Nathan", exact: true }).click(),
  ]);
  await prepared.finished();
  expect(prepared.status()).toBe(200);
  await expect(transfer.getByRole("heading", { name: "Aperçu de l’email à envoyer", exact: true })).toBeVisible();
  await expect(transfer).toContainText("nathan@limova.ai");
  await expect(transfer).toContainText(SAV53_PARTNERSHIP);
  await expect(transfer.getByRole("button", { name: "Confirmer l’envoi à Nathan", exact: true })).toBeDisabled();
  await expect(transfer.locator('input[name="to"],input[name="recipient"],textarea[name="to"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("sav53-partenariat-apercu.png"), fullPage: true });
  await transfer.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(transfer.getByRole("heading", { name: "Aperçu de l’email à envoyer", exact: true })).toHaveCount(0);
  expect(external).toEqual([]);
});

test("une demande de support ne montre aucun CTA de transfert partenariat", async ({ page }) => {
  await page.goto(`/studio/sav/${SAV53_THREADS.singlePlain}`);
  await expect(page.getByRole("region", { name: "Transfert partenariat", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Préparer le transfert à Nathan", exact: true })).toHaveCount(0);
});
