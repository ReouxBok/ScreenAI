import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SAV83_THREAD, SAV83_UNREAD_THREAD } from "../../test/sav83-e2e-fixture";
test("shows acquired observations and limits; reload and prefetch do not read images", async ({ page, request }) => {
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "3183" ? route.continue() : route.abort();
  });
  await page.setExtraHTTPHeaders({ "x-studio-test-user": "ugo@limova.ai" });
  const url = `/studio/sav/${SAV83_THREAD}`;
  await page.goto(url);
  await page.getByText("Au moins 5 pièce(s) jointe(s) — lecture et limites", { exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Inventaire incomplet" })).toBeVisible();
  const states = page.getByRole("list", { name: "État des pièces jointes", exact: true });
  await expect(states).toContainText("Analysée"); await expect(states).toContainText("Erreur E42. Version 7.2.");
  await expect(states).toContainText("Lecture partielle"); await expect(states).toContainText("La zone inférieure est floue.");
  await expect(states).toContainText("Format non pris en charge"); await expect(states).toContainText("Non lue");
  await expect(states).toContainText("Illisible"); await expect(states).toContainText("Le code d’erreur est illisible.");
  expect(await page.content()).not.toContain("00000083-0000-4000-8000-000000000003");
  if (process.env.STUDIO_E2E_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.STUDIO_E2E_SCREENSHOT_DIR}/attachments.png`, fullPage: true });
  await page.reload();
  const prefetch = await request.get(url, { headers: { "x-studio-test-user": "ugo@limova.ai", purpose: "prefetch", "next-router-prefetch": "1" } });
  expect(prefetch.ok()).toBe(true);
  const networkLog = readFileSync(path.resolve(".e2e-sav83-network.log"), "utf8");
  expect(networkLog).not.toMatch(/generativelanguage|\/attachments\/|gmail\.googleapis/);
});
test("does not acquire a new image reading on opening or prefetching an unprocessed message", async ({ page, request }) => {
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "3183" ? route.continue() : route.abort();
  });
  await page.setExtraHTTPHeaders({ "x-studio-test-user": "ugo@limova.ai" });
  const url = `/studio/sav/${SAV83_UNREAD_THREAD}`;
  const prefetch = await request.get(url, { headers: { "x-studio-test-user": "ugo@limova.ai", purpose: "prefetch", "next-router-prefetch": "1" } });
  expect(prefetch.ok()).toBe(true);
  await page.goto(url);
  await page.getByText("1 pièce(s) jointe(s) — lecture et limites", { exact: true }).click();
  await expect(page.getByRole("list", { name: "État des pièces jointes", exact: true })).toContainText("Aucune observation visuelle acquise");
  await page.reload();
  await page.getByText("1 pièce(s) jointe(s) — lecture et limites", { exact: true }).click();
  await expect(page.getByRole("list", { name: "État des pièces jointes", exact: true })).toContainText("Aucune observation visuelle acquise");
  expect(readFileSync(path.resolve(".e2e-sav83-network.log"), "utf8")).not.toMatch(/generativelanguage|\/attachments\/|gmail\.googleapis/);
});
