/*
 * Agent SAV intelligent, lot E (20/11): the switch of the new agent and the bounds of its shadow mode. Pure: reads only the values given.
 *
 * `SAV_V2_SMART_AGENT=shadow` is the ONLY value that runs anything. Absent, empty or any other value (`on`, `auto`, `SHADOW`...): off, nothing
 * read, computed or paid. There is deliberately no value that sends: the new agent has no path to a customer, a ticket or Slack.
 * Every bound has a default and a ceiling; a malformed value refuses the run (nothing read, computed or paid), it is never guessed.
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_SMART_AGENT_ENV = "SAV_V2_SMART_AGENT";
export const SAV_SMART_SHADOW_CAP_ENV = "SAV_V2_SMART_SHADOW_MAX_MICRO_USD_PER_DAY";
export const SAV_SMART_SHADOW_MAILS_ENV = "SAV_V2_SMART_SHADOW_MAX_MAILS_PER_DAY";
export const SAV_SMART_SHADOW_BATCH_ENV = "SAV_V2_SMART_SHADOW_BATCH";
export const SAV_SMART_SHADOW_SINCE_ENV = "SAV_V2_SMART_SHADOW_SINCE";
/** Ugo (D4): 10 EUR per day at most, read as 10 000 000 µUSD like the Access self-test; the default and the ceiling. */
export const SAV_SMART_SHADOW_MAX_CAP_MICRO_USD = 10_000_000;
export const SAV_SMART_SHADOW_DEFAULT_MAILS = 20, SAV_SMART_SHADOW_MAX_MAILS = 200;
export const SAV_SMART_SHADOW_DEFAULT_BATCH = 3, SAV_SMART_SHADOW_MAX_BATCH = 10;
/** Mails older than this are never taken, whatever `SINCE` says: the shadow reads new mails, not the history. */
export const SAV_SMART_SHADOW_LOOKBACK_MS = 24 * 3_600_000;

export type SmartShadowConfig =
  | Readonly<{ mode: "off" }>
  | Readonly<{ mode: "refused"; reason: "cap_invalid" | "mails_invalid" | "batch_invalid" | "since_invalid" }>
  | Readonly<{ mode: "shadow"; capMicroUsdPerDay: number; maxMailsPerDay: number; batch: number; since: Date | null }>;

const INTEGER = /^[0-9]{1,12}$/;
function integer(env: Env, name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = INTEGER.test(raw) ? Number(raw) : NaN;
  return value >= min && value <= max ? value : null;
}

export const smartAgentShadowOn = (env: Env) => env[SAV_SMART_AGENT_ENV] === "shadow";

/*
 * Ugo, 25/11: « quelle offre me convient ? » and « une démo ? » are commercial (pre-sales) questions, not a sensitive subscription topic. With
 * `SAV_V2_SMART_COMMERCIAL_SPLIT=on` (exactly), the reading may mark such a need `commercial` (the model's judgement, never a word list): it is not
 * searched nor answered, it is handed to the team with « Demande commerciale (choix d'offre / démo) → Sacha » in the note, and the other needs are
 * handled as usual. Paying, buying, changing, renewing or cancelling a subscription, invoices, refunds and billing stay sensitive (whole mail to the
 * team). Absent, empty or any other value: off, the prompts, the reading and every result are the ones of today.
 */
export const SAV_SMART_COMMERCIAL_SPLIT_ENV = "SAV_V2_SMART_COMMERCIAL_SPLIT";
/** The prompt set and the turn's port for the switch: `{ commercialSplit: true }` when on, `{}` when off (spread as is: off adds nothing). */
export const smartCommercialSet = (env: Env): Readonly<{ commercialSplit?: true }> => env[SAV_SMART_COMMERCIAL_SPLIT_ENV] === "on" ? { commercialSplit: true } : {};

export function readSmartShadowConfig(env: Env): SmartShadowConfig {
  if (!smartAgentShadowOn(env)) return { mode: "off" };
  const capMicroUsdPerDay = integer(env, SAV_SMART_SHADOW_CAP_ENV, SAV_SMART_SHADOW_MAX_CAP_MICRO_USD, 1, SAV_SMART_SHADOW_MAX_CAP_MICRO_USD);
  if (capMicroUsdPerDay === null) return { mode: "refused", reason: "cap_invalid" };
  const maxMailsPerDay = integer(env, SAV_SMART_SHADOW_MAILS_ENV, SAV_SMART_SHADOW_DEFAULT_MAILS, 1, SAV_SMART_SHADOW_MAX_MAILS);
  if (maxMailsPerDay === null) return { mode: "refused", reason: "mails_invalid" };
  const batch = integer(env, SAV_SMART_SHADOW_BATCH_ENV, SAV_SMART_SHADOW_DEFAULT_BATCH, 1, SAV_SMART_SHADOW_MAX_BATCH);
  if (batch === null) return { mode: "refused", reason: "batch_invalid" };
  const rawSince = env[SAV_SMART_SHADOW_SINCE_ENV];
  let since: Date | null = null;
  if (rawSince !== undefined && rawSince !== "") {
    since = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(rawSince) ? new Date(rawSince) : null;
    if (!since || !Number.isFinite(since.getTime())) return { mode: "refused", reason: "since_invalid" };
  }
  return { mode: "shadow", capMicroUsdPerDay, maxMailsPerDay, batch, since };
}
