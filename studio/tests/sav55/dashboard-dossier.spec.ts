import { expect, test } from "@playwright/test";
import { SAV55_SUBJECTS, SAV55_THREADS } from "../../test/sav55-e2e-fixture";
import { SAV53_BODY, SAV53_CURRENT, SAV53_THREADS } from "../../test/sav53-e2e-fixture";

test.beforeEach(async ({ page, baseURL }) => {
  await page.route("**/*", route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
});
test("les quatre vues comptent les mêmes dossiers que leurs listes compactes", async ({ page }, testInfo) => {
  for (const [view, subjects] of [
    ["to_process", [SAV55_SUBJECTS.unopened, SAV55_SUBJECTS.unreadReturn]],
    ["to_validate", [SAV55_SUBJECTS.review, SAV55_SUBJECTS.ticketPending]],
    ["learning", [SAV55_SUBJECTS.qualification, SAV55_SUBJECTS.candidate]],
    ["completed", [SAV55_SUBJECTS.noTicket, SAV55_SUBJECTS.ticketConfirmed]],
  ] as const) {
    await page.goto(`/studio/sav?view=${view}&q=SAV55`);
    const rows = page.getByRole("region", { name: "Dossiers SAV", exact: true });
    await expect(rows.getByRole("button", { name: /^Ouvrir l’email/ })).toHaveCount(2);
    for (const subject of subjects) await expect(rows.getByRole("button", { name: `Ouvrir l’email : ${subject}`, exact: true })).toBeVisible();
    const tabs = page.getByRole("navigation", { name: "Vues SAV", exact: true });
    for (const label of ["À traiter", "À valider", "Suivi HubSpot", "Terminés"]) await expect(tabs.getByRole("link", { name: new RegExp(`^${label}\\s*2`) })).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath("sav55-dashboard.png"), fullPage: true });
});
test("ouverture directe et retour conservent le contexte sans classer Gmail", async ({ page }) => {
  const external: string[] = [];
  page.on("request", request => { if (/googleapis|hubspot/.test(request.url())) external.push(request.url()); });
  const returnTo = `/studio/sav?view=to_validate&q=SAV55&page=1&sort=oldest#dossier-${SAV55_THREADS.review}`;
  await page.goto(`/studio/sav/${SAV55_THREADS.review}?returnTo=${encodeURIComponent(returnTo)}`);
  await expect(page.getByRole("link", { name: "← Retour aux dossiers", exact: true })).toHaveAttribute("href", returnTo);
  // Existing POST redirects omit this parameter; the remembered local context survives.
  await page.goto(`/studio/sav/${SAV55_THREADS.review}?review=saved`);
  await expect(page.getByRole("link", { name: "← Retour aux dossiers", exact: true })).toHaveAttribute("href", returnTo);
  await page.getByRole("link", { name: "← Retour aux dossiers", exact: true }).click();
  await expect(page).toHaveURL(/view=to_validate.*q=SAV55.*sort=oldest/);
  expect(external).toEqual([]);
});
test("sur ordinateur, le dernier email reste replié et l’historique complet défile", async ({ page }, testInfo) => {
  await page.goto(`/studio/sav/${SAV53_THREADS.conversation}`);
  const mail = page.getByRole("region", { name: "Dernier email reçu", exact: true });
  await expect(mail.locator("pre")).toHaveText(SAV53_CURRENT);
  await mail.getByRole("button", { name: /^Afficher toute la conversation/ }).click();
  await expect(mail.locator("pre").first()).toHaveText(SAV53_BODY);
  await expect(mail.locator("article")).toHaveCount(3);
  const scrollable = await mail.evaluate(region => [...region.querySelectorAll("*")].some(element => { const style = getComputedStyle(element); return ["auto", "scroll"].includes(style.overflowY) && style.maxHeight !== "none"; }));
  expect(scrollable).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("sav55-dossier-historique.png"), fullPage: true });
});
test("recherche sans résultat et liste restent lisibles sur ordinateur", async ({ page }) => {
  await page.goto("/studio/sav?view=completed&q=inexistant-synthetique-55");
  await expect(page.getByRole("heading", { name: "Aucun dossier ne correspond à cette recherche", exact: true })).toBeVisible();
  await page.goto("/studio/sav?view=completed&q=SAV55");
  await expect(page.getByRole("button", { name: `Ouvrir l’email : ${SAV55_SUBJECTS.noTicket}`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("un accès direct enregistre le dernier entrant et le fait passer à valider", async ({ page }) => {
  const path = `/studio/sav/${SAV55_THREADS.unopened}`;
  const recorded = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === path);
  await page.goto(path);
  const response = await recorded;
  await response.finished(); expect(response.ok()).toBe(true);
  await page.goto("/studio/sav?view=to_validate&q=SAV55");
  await expect(page.getByRole("button", { name: `Ouvrir l’email : ${SAV55_SUBJECTS.unopened}`, exact: true })).toBeVisible();
  await page.goto("/studio/sav?view=to_process&q=SAV55");
  await expect(page.getByRole("region", { name: "Dossiers SAV", exact: true }).getByRole("button", { name: /^Ouvrir l’email/ })).toHaveCount(1);
});
