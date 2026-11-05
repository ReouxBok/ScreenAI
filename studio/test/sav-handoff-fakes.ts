// Synthetic Slack for the handoff notice tests: an in-memory channel behind a function-shaped network. Nothing here opens a socket or names a real workspace.
export type SlackCall = { url: URL; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };
export function fakeSlack() {
  const state = { calls: [] as SlackCall[], messages: [] as Array<{ text: string; ts: string; user: string }>, seq: 1_780_000_000,
    mode: "ok" as "ok" | "refuse" | "lose" | "lose_before" | "http500" | "garbage" | "ratelimit" | "other_error" | "wrong_channel", refusal: "channel_not_found", hasMore: false, historyBroken: false };
  const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    const call: SlackCall = { url, method, headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null };
    state.calls.push(call);
    if (url.hostname !== "slack.com") throw Error("HOST_FORBIDDEN");
    if (url.pathname === "/api/chat.postMessage") {
      const text = String(call.body?.text);
      if (state.mode === "lose_before") throw Error("SOCKET_CLOSED_BEFORE_SEND");
      if (state.mode === "refuse") return reply(200, { ok: false, error: state.refusal });
      if (state.mode === "other_error") return reply(200, { ok: false, error: "internal_error" });
      if (state.mode === "ratelimit") return reply(429, { ok: false, error: "ratelimited" });
      if (state.mode === "http500") return reply(500, "oops");
      if (state.mode === "garbage") return new Response("<html>", { status: 200 });
      const ts = `${state.seq++}.000100`;
      state.messages.push({ text, ts, user: "UBOTSYN" });
      if (state.mode === "lose") throw Error("SOCKET_CLOSED_AFTER_SEND");
      return reply(200, { ok: true, ts, channel: state.mode === "wrong_channel" ? "CSOMEOTHER01" : call.body?.channel });
    }
    if (url.pathname === "/api/auth.test") return reply(200, { ok: true, user_id: "UBOTSYN" });
    if (url.pathname === "/api/conversations.history") {
      if (state.historyBroken) return reply(200, { ok: false, error: "internal_error" });
      return reply(200, { ok: true, messages: state.messages, has_more: state.hasMore });
    }
    throw Error(`SLACK_METHOD_FORBIDDEN:${url.pathname}`);
  }) as typeof fetch;
  return { state, network };
}
