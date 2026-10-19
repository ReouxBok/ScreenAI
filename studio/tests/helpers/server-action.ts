import type { Locator, Page } from "@playwright/test";

// App Router action clicks may resolve before their streamed response finishes.
// Wait for that operation, including repeated redirects to the current URL,
// before starting the unchanged business assertions. Cold local workflow compilation
// can exceed30s on the resource-constrained sequential qualification host.
export async function submitServerAction(page: Page, button: Locator, matchBody?: RegExp) {
  const origin = new URL(page.url()).origin;
  // Bound forms expose their server action ID in the SSR transport field.
  // The dossier-open side effect also posts next-action; it must not satisfy this wait.
  const actionId = await button.evaluate(element => {
    const form = (element as HTMLButtonElement).form;
    const field = form?.querySelector<HTMLInputElement>('input[name^="$ACTION_ID_"]');
    return field?.name.slice("$ACTION_ID_".length) ?? null;
  });
  if (!actionId && !matchBody) throw new Error("SERVER_ACTION_TARGET_NOT_IDENTIFIABLE");
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).origin === origin
      && Boolean(response.request().headers()["next-action"])
      && (!actionId || response.request().headers()["next-action"] === actionId)
      && (!matchBody || matchBody.test(response.request().postData() ?? "")), { timeout: 90_000 }),
    button.click(),
  ]);
  await response.finished();
}
