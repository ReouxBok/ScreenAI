import { expect, test, type Locator, type Page } from "@playwright/test";
import { SAV53_THREADS } from "../../test/sav53-e2e-fixture";

test.beforeEach(async ({ page, baseURL }) => {
  page.setDefaultTimeout(15_000);
  await page.route("**/*", route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
});

async function submitWithoutJump(page: Page, button: Locator) {
  await button.scrollIntoViewIfNeeded();
  const marker = await button.evaluate(element => {
    const form = element.closest("form")!;
    return form.querySelector('[name="humanProcess"]') ? "humanProcess" : form.querySelector('[name="expectedDraftId"]') ? "expectedDraftId" : "sourceHash";
  });
  const [response, before] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && Boolean(response.request().headers()["next-action"]) && Boolean(response.request().postDataBuffer()?.includes(Buffer.from(marker)))),
    // Clicking can itself scroll to focus the button. Compare against the
    // viewport at submission, before the server action navigates.
    button.evaluate(element => new Promise<number>(resolve => {
      element.closest("form")!.addEventListener("submit", () => resolve(window.scrollY), { capture: true, once: true });
    })),
    button.click(),
  ]);
  expect(before).toBeGreaterThan(300);
  await response.finished();
  // Let both the router's layout effects and the restoration frame finish.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - before)).toBeLessThan(4);
}

test("same-dossier actions preserve reading position, including repeated redirects", async ({ page }) => {
  const returnTo = "/studio/sav?view=learning&q=Échec+export+PDF+fictif&sort=oldest";
  await page.goto(`/studio/sav/${SAV53_THREADS.singlePlain}?returnTo=${encodeURIComponent(returnTo)}`);
  const process = page.locator("#sav-review-form");
  await process.getByText("Aucun ticket nécessaire", { exact: true }).click();
  await expect(process.getByRole("radio", { name: "Aucun ticket nécessaire", exact: true })).toBeChecked();
  await process.getByLabel("Pourquoi ce choix").fill("Demande synthétique vérifiée, aucun ticket nécessaire.");
  await process.getByRole("checkbox", { name: /J’ai vérifié/ }).check();
  const validate = page.getByRole("button", { name: "Valider le dossier", exact: true });
  await submitWithoutJump(page, validate);
  await expect(page).toHaveURL(/review=saved/);
  await process.getByRole("checkbox", { name: /J’ai vérifié/ }).check();
  await submitWithoutJump(page, validate); // Revalidate the same dossier.

  const draft = page.getByRole("region", { name: "Suggestion de réponse", exact: true });
  await draft.getByRole("textbox", { name: "Suggestion de réponse", exact: true }).fill("Bonjour, voici une réponse humaine synthétique pour cette demande.");
  await submitWithoutJump(page, draft.getByRole("button", { name: "Enregistrer ma version", exact: true }));
  await expect(draft.getByRole("textbox", { name: "Suggestion de réponse", exact: true })).toHaveValue("Bonjour, voici une réponse humaine synthétique pour cette demande.");
  await draft.getByText("Feedback facultatif sur la suggestion", { exact: true }).click();
  await draft.getByLabel("Commentaire", { exact: true }).fill("Vérification synthétique du parcours de refus.");
  await submitWithoutJump(page, draft.getByRole("button", { name: "Signaler un problème dans la suggestion initiale", exact: true }));
  await expect(page).toHaveURL(/review=draft_reviewed/);
  await expect(draft).toContainText("Suggestion disponible");

  const beforeReload = await page.evaluate(() => window.scrollY);
  await page.reload();
  await expect(draft.getByRole("textbox", { name: "Suggestion de réponse", exact: true })).toHaveValue("Bonjour, voici une réponse humaine synthétique pour cette demande.");
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - beforeReload)).toBeLessThan(4);
  await expect(page.getByRole("region", { name: "Journal du suivi", exact: true })).toContainText("Fil Gmail suivi");
  await page.getByRole("link", { name: "← Retour aux dossiers", exact: true }).click();
  await expect(page).toHaveURL(/view=learning&q=.*sort=oldest/);
  await expect(page.getByLabel("Rechercher un dossier")).toHaveValue("Échec export PDF fictif");
  await expect(page.locator(`#dossier-${SAV53_THREADS.singlePlain}`)).toBeVisible();
});

test("intentional section links and a different dossier keep normal navigation", async ({ page }) => {
  await page.goto(`/studio/sav/${SAV53_THREADS.singleQuoted}`);
  await page.getByRole("link", { name: "Aller à l’action à valider", exact: true }).click();
  await expect(page).toHaveURL(/#sav-action$/);
  await expect.poll(() => page.evaluate(() => Math.abs(document.getElementById("sav-action")!.getBoundingClientRect().top))).toBeLessThan(50);
  await page.goto(`/studio/sav/${SAV53_THREADS.singlePlain}`);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});
