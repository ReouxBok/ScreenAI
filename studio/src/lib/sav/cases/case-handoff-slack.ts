// V2 human handoff notice (local, OFF): the Slack side of the existing executor protocol. `dispatch` is the ONE write (chat.postMessage, to the configured channel
// only); `verify` is read-only (conversations.history) and never posts. The protocol around them (marker before the call, no second call from dispatched / acked /
// uncertain, verification only, five reads then a person) is `intake/executor.ts` + `intake/execution-store.ts`, not reimplemented here.
// What counts as « nothing was posted » is deliberately narrow: only an answer from Slack that names a refusal BEFORE posting. A timeout, a lost answer, a 5xx or an
// answer we do not understand may have posted: it stays uncertain and is only verified.
// The bot token comes from the injected environment and appears nowhere else (not in an intent, a ledger row, an error or a log). Nothing here reads a mail or the CRM.
import type { EffectAck, EffectIntent, ExecutorAdapters } from "../intake/execution-types";
import { handoffNoticeMarkerIn, scrubHandoffNoticeText } from "./case-handoff-notice";

const SLACK_API = "https://slack.com/api/";
const TIMEOUT_MS = 10_000;
/** Slack errors that say the message was not posted (authentication, the channel, the request itself, the rate limit): safe to plan again later. Anything else may have posted. */
export const SLACK_NOT_POSTED_ERRORS: ReadonlySet<string> = new Set([
  "invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "missing_scope", "no_permission", "access_denied", "restricted_action",
  "channel_not_found", "not_in_channel", "is_archived", "msg_too_long", "no_text", "invalid_arguments", "invalid_arg_name", "invalid_charset", "invalid_form_data",
  "invalid_post_type", "missing_post_type", "team_access_not_granted", "ratelimited", "rate_limited",
]);
/** Prefix of the typed refusal the driver recognises to take the effect back to `planned` (the proven no-send transition). */
export const SLACK_NOT_POSTED_PREFIX = "SAV_HANDOFF_SLACK_NOT_POSTED_";

export type HandoffSlackDeps = Readonly<{ network: typeof fetch; env: () => Record<string, string | undefined> }>;
const fault = (code: string): never => { throw new Error(code); };
const upper = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 60);
const token = (deps: HandoffSlackDeps) => {
  const value = deps.env().SAV_HANDOFF_SLACK_BOT_TOKEN;
  return typeof value === "string" && /^xoxb-[A-Za-z0-9-]{10,200}$/.test(value) ? value : fault("SAV_HANDOFF_SLACK_TOKEN_MISSING");
};
const stamp = (ts: unknown): ts is string => typeof ts === "string" && /^[0-9]{9,12}\.[0-9]{1,8}$/.test(ts);

async function call(deps: HandoffSlackDeps, method: string, init: Readonly<{ http: "GET" | "POST"; query?: Record<string, string>; body?: unknown }>, signal: AbortSignal) {
  const url = new URL(`${SLACK_API}${method}`);
  for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);
  const response = await deps.network(url.toString(), {
    method: init.http, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    headers: { Authorization: `Bearer ${token(deps)}`, ...(init.http === "POST" ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
    ...(init.http === "POST" ? { body: JSON.stringify(init.body) } : {}),
  });
  return response;
}
async function json(response: Response): Promise<Record<string, unknown> | null> {
  try { const value = await response.json() as unknown; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}

/** Only the adapters the notice needs; every other port of the executor is absent on purpose (the driver of a notice never reads the CRM or Gmail through them). */
export function createHandoffSlackAdapters(deps: HandoffSlackDeps): Pick<ExecutorAdapters, "dispatch" | "verify"> {
  return {
    async dispatch(intent: EffectIntent, signal: AbortSignal): Promise<EffectAck> {
      if (intent.kind !== "handoff_notify" || typeof intent.text !== "string" || !intent.text || typeof intent.channel !== "string" || typeof intent.marker !== "string" || !handoffNoticeMarkerIn(intent.text)) return fault("SAV_HANDOFF_SLACK_INTENT_INVALID");
      let response: Response;
      try {
        response = await call(deps, "chat.postMessage", { http: "POST", body: { channel: intent.channel, text: scrubHandoffNoticeText(intent.text), mrkdwn: true, unfurl_links: false, unfurl_media: false, link_names: false } }, signal);
      } catch (error) {
        // A missing token fails before any request: nothing left. A transport error may have happened after Slack accepted the message.
        if (error instanceof Error && error.message === "SAV_HANDOFF_SLACK_TOKEN_MISSING") throw error;
        return fault("SAV_HANDOFF_SLACK_RESULT_UNKNOWN");
      }
      if (response.status === 429) return fault(`${SLACK_NOT_POSTED_PREFIX}RATELIMITED`);
      const body = await json(response);
      if (!body || typeof body.ok !== "boolean") return fault("SAV_HANDOFF_SLACK_RESULT_UNKNOWN");
      if (body.ok === false) {
        const error = typeof body.error === "string" ? body.error : "";
        return fault(SLACK_NOT_POSTED_ERRORS.has(error) ? `${SLACK_NOT_POSTED_PREFIX}${upper(error)}` : "SAV_HANDOFF_SLACK_RESULT_UNKNOWN");
      }
      if (response.status !== 200 || !stamp(body.ts) || body.channel !== intent.channel) return fault("SAV_HANDOFF_SLACK_RESULT_UNKNOWN");
      return { id: body.ts, ts: body.ts, channel: intent.channel };
    },

    async verify(intent: EffectIntent, ack: EffectAck | null, dispatchedAt: Date, signal: AbortSignal) {
      if (intent.kind !== "handoff_notify" || typeof intent.channel !== "string" || typeof intent.marker !== "string") return fault("SAV_HANDOFF_SLACK_INTENT_INVALID");
      const identity = await json(await call(deps, "auth.test", { http: "GET" }, signal));
      if (!identity || identity.ok !== true || typeof identity.user_id !== "string") return fault("SAV_HANDOFF_SLACK_VERIFY_UNAVAILABLE");
      const known = typeof ack?.ts === "string" && stamp(ack.ts) ? ack.ts : null;
      const oldest = known ?? ((dispatchedAt.getTime() - 60_000) / 1000).toFixed(6);
      const history = await json(await call(deps, "conversations.history", { http: "GET", query: { channel: intent.channel, oldest, ...(known ? { latest: known } : {}), inclusive: "true", limit: "200" } }, signal));
      if (!history || history.ok !== true || !Array.isArray(history.messages)) return fault("SAV_HANDOFF_SLACK_VERIFY_UNAVAILABLE");
      const ours = (history.messages as Array<Record<string, unknown>>).filter(message => message && typeof message.text === "string" && message.text.includes(intent.marker!) && message.user === identity.user_id);
      // A window that does not fit one page proves nothing about the rest: it is read again, never taken for « absent ».
      if (!ours.length && history.has_more === true) return fault("SAV_HANDOFF_SLACK_VERIFY_INCOMPLETE");
      if (!ours.length) return { confirmed: false, attributed: false };
      const first = [...ours].sort((a, b) => Number(a.ts) - Number(b.ts))[0]!;
      if (!stamp(first.ts)) return fault("SAV_HANDOFF_SLACK_VERIFY_UNAVAILABLE");
      return { confirmed: true, attributed: true, ack: { id: first.ts, ts: first.ts, channel: intent.channel, ...(ours.length > 1 ? { posts: ours.length } : {}) } };
    },
  };
}
