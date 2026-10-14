import type { Locator, Page } from "@playwright/test";

// App Router action clicks may resolve before their streamed response finishes.
// Wait for that operation, including repeated redirects to the current URL,
// before starting the unchanged business assertions.
export async function submitServerAction(page: Page, button: Locator) {
  const origin = new URL(page.url()).origin;
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).origin === origin
      && Boolean(response.request().headers()["next-action"]), { timeout: 30_000 }),
    button.click(),
  ]);
  await response.finished();
}
