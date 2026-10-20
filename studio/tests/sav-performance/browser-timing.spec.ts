import { expect, test } from "@playwright/test";
test("same prepared data: first list, warm pagination, click to dossier", async ({ page, baseURL }) => {
  await page.route("**/*", route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
  const first = Date.now();
  await page.goto("/studio/sav?q=Performance+synthétique");
  const pagination = page.getByRole("navigation", { name: "Pagination", exact: true });
  await expect(pagination).toContainText("Page 1 sur 40");
  const firstListMs = Date.now() - first;
  await page.evaluate(() => { (window as unknown as { timingDocument: string }).timingDocument = "same"; });
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const started = Date.now(), next = i % 2 === 0;
    await page.getByRole("link", { name: next ? "Suivante →" : "← Précédente", exact: true }).click();
    await expect(pagination).toContainText(next ? "Page 2 sur 40" : "Page 1 sur 40");
    samples.push(Date.now() - started);
  }
  expect(await page.evaluate(() => (window as unknown as { timingDocument: string }).timingDocument)).toBe("same");
  const click = Date.now();
  await page.getByRole("button", { name: /^Ouvrir l’email : Performance synthétique/ }).first().click();
  await expect(page).toHaveURL(/\/studio\/sav\/[a-f0-9-]{36}\?/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Performance synthétique");
  const clickToDossierMs = Date.now() - click;
  const sorted = [...samples].sort((a,b) => a-b);
  await test.info().attach("browser-timing", { body: JSON.stringify({ reader: process.env.STUDIO_E2E_READER,
    node: process.version, syntheticThreads: 1000, samples, firstListMs, warmP50Ms: sorted[9], warmP95Ms: sorted[18], clickToDossierMs,
    environment: "same current UI; local dev server; auth bypass; PGlite; disabled provider writes; prebuilt projection in both modes",
    firstListMeaning: "includes first list compilation; not physical cold database or production start", compareScope: "reader flag only; not old release vs new UI" }), contentType: "application/json" });
});
