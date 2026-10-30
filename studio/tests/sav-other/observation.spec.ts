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
  const dossier = page.locator(`[id="dossier-${SAV_OTHER_THREAD(1)}"]`);
  await expect(dossier).toContainText("Également dans À traiter");
  await dossier.click();
  // The first client navigation compiles this dossier route in the dev server,
  // which takes longer with Next.js 16.4 on CI runners.
  await expect(page).toHaveURL(new RegExp(path), { timeout: 60_000 });
  await expect(page).not.toHaveURL(/filing=|context=|refreshId=/);
  const auditResponse = await audit;
  expect(auditResponse.ok()).toBe(true);
  // HTTP headers are only a transport check. The same dossier must change from
  // unopened to À valider after return; RSC end-of-stream is not a commit receipt.
  expect(posts.every(url => new URL(url).pathname === path)).toBe(true);
  const back = page.getByRole("link", { name: "← Retour aux dossiers", exact: true });
  await expect(back).toHaveAttribute("href", `/studio/sav?view=other&q=AUTRE88&page=1&sort=oldest#dossier-${SAV_OTHER_THREAD(1)}`);
  await back.click();
  // URL commitment may display loading.tsx before the real list is rendered.
  // Keep the existing navigation budget; the row/status assertion stays at5s.
  await Promise.all([
    expect(page).toHaveURL(/view=other.*sort=oldest/, { timeout: 30_000 }),
    page.getByRole("region", { name: "Dossiers SAV", exact: true }).waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  await expect(dossier).toContainText("Également dans À valider");
});
