import { expect, test } from "@playwright/test";
import { SAV_OTHER_CASES, SAV_OTHER_THREAD } from "../../test/sav-other-e2e-fixture";

test.beforeEach(async ({ page, baseURL }) => {
  await page.route("**/*", route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
});
test("quatre familles en observation, mêmes candidats conservés dans le support", async ({ page }, testInfo) => {
  await page.goto("/studio/sav?view=other&q=AUTRE88&sort=oldest");
  await expect(page.getByRole("heading", { name: "Autre — observation", exact: true })).toBeVisible();
  const ledger = page.getByRole("region", { name: "Dossiers SAV", exact: true });
  await expect(ledger.getByRole("link")).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    const row = ledger.locator(`[id="dossier-${SAV_OTHER_THREAD(i + 1)}"]`);
    await expect(row).toContainText(SAV_OTHER_CASES[i].subject);
    await expect(row).toContainText("Également dans À traiter");
  }
  await expect(ledger).not.toContainText("avis synthétique 2 étoiles");
  await expect(ledger.locator(`[id="dossier-${SAV_OTHER_THREAD(6)}"]`)).toHaveCount(0);
  await expect(ledger.locator(`[id="dossier-${SAV_OTHER_THREAD(7)}"]`)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("autre-observation.png"), fullPage: true });
  await page.goto("/studio/sav?view=to_process&q=AUTRE88");
  await expect(page.getByRole("region", { name: "Dossiers SAV", exact: true }).getByRole("button", { name: /^Ouvrir l’email/ })).toHaveCount(7);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
test("ouverture et retour Autre sans filing Gmail ni refresh CRM", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", request => { if (request.method() === "POST") posts.push(request.url()); });
  await page.goto("/studio/sav?view=other&q=AUTRE88&sort=oldest");
  const path = `/studio/sav/${SAV_OTHER_THREAD(1)}`;
  const audit = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === path);
  await page.locator(`[id="dossier-${SAV_OTHER_THREAD(1)}"]`).click();
  // The first client navigation compiles this dossier route in the dev server.
  await expect(page).toHaveURL(new RegExp(path), { timeout: 30_000 });
  await expect(page).not.toHaveURL(/filing=|context=|refreshId=/);
  expect((await audit).ok()).toBe(true);
  expect(posts.every(url => new URL(url).pathname === path)).toBe(true);
  const back = page.getByRole("link", { name: "← Retour aux dossiers", exact: true });
  await expect(back).toHaveAttribute("href", `/studio/sav?view=other&q=AUTRE88&page=1&sort=oldest#dossier-${SAV_OTHER_THREAD(1)}`);
  await back.click();
  await expect(page).toHaveURL(/view=other.*sort=oldest/, { timeout: 30_000 });
  await expect(page.locator(`[id="dossier-${SAV_OTHER_THREAD(1)}"]`)).toContainText("Également dans À valider");
});
