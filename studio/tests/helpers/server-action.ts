import type { Locator, Page, Request, Route } from "@playwright/test";

// App Router action clicks may resolve before their streamed response finishes.
// Wait for that operation, including repeated redirects to the current URL,
// before starting the unchanged business assertions. Cold local workflow compilation
// can exceed30s on the resource-constrained sequential qualification host.
//
// With Next.js 16.4 and `withWorkflow`, the development server ends the action
// stream but Chromium never reports the response as finished. The action is
// therefore fetched in full by Playwright, then handed to the page at once.
export async function submitServerAction(page: Page, button: Locator, matchBody?: RegExp, beforeFulfill?: () => Promise<void>) {
  const origin = new URL(page.url()).origin;
  // Bound forms expose their server action ID in the SSR transport field.
  // The dossier-open side effect also posts next-action; it must not satisfy this wait.
  const actionId = await button.evaluate(element => {
    const button = element as HTMLButtonElement;
    // A type=button callback invokes its own action, not the enclosing form action.
    const form = button.type === "button" ? null : button.form;
    const field = form?.querySelector<HTMLInputElement>('input[name^="$ACTION_ID_"]');
    return field?.name.slice("$ACTION_ID_".length) ?? null;
  });
  if (!actionId && !matchBody) throw new Error("SERVER_ACTION_TARGET_NOT_IDENTIFIABLE");
  const matches = (request: Request) => request.method() === "POST"
    && new URL(request.url()).origin === origin
    && Boolean(request.headers()["next-action"])
    && (!actionId || request.headers()["next-action"] === actionId)
    && (!matchBody || matchBody.test(request.postData() ?? ""));
  const action = await fetchServerActionInFull(page, matches, beforeFulfill);
  try {
    await Promise.all([action.settled(), button.click()]);
  } finally {
    await action.dispose();
  }
}

// Fetches the next matching server action in full before the page receives it,
// so `settled()` resolves once the action has really returned.
export async function fetchServerActionInFull(page: Page, matches: (request: Request) => boolean, beforeFulfill?: () => Promise<void>) {
  let settle!: () => void;
  let fail!: (error: unknown) => void;
  const settled = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
  let handled = false;
  const handler = async (route: Route) => {
    if (handled || !matches(route.request())) return route.fallback();
    handled = true;
    try {
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 90_000 });
      // Pass the bytes explicitly. The RSC content type has no charset and the
      // response shortcut can recode UTF-8 as latin1, corrupting length-prefixed
      // Flight chunks (the import succeeds but React never receives its result).
      const body = await response.body();
      // APIResponse.body() is already decompressed. Its wire headers must not
      // describe gzip/chunked bytes that we no longer send. Explicit UTF-8 also
      // prevents Chromium interception from recoding Flight's byte-length chunks.
      const headers = { ...response.headers() };
      delete headers["content-encoding"];
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      if (/^text\/x-component(?:;|$)/i.test(headers["content-type"] ?? "")) {
        headers["content-type"] = "text/x-component; charset=utf-8";
      }
      await beforeFulfill?.();
      await route.fulfill({ response, headers, body });
      settle();
    } catch (error) {
      fail(error);
    }
  };
  // Server Actions POST to the invoking page. Leave rendering assets outside
  // this short-lived interception: they can still be loading at disposal.
  const url = new URL(page.url());
  const actionPath = `${url.origin}${url.pathname}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const actionUrl = new RegExp(`^${actionPath}(?:\\?.*)?$`);
  await page.route(actionUrl, handler);
  return {
    settled: () => settled,
    dispose: () => page.unroute(actionUrl, handler),
  };
}
