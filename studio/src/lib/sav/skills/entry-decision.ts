import { savEvidenceContains } from "../evidence-text";
import { containsPromptInjection } from "../policy";
import { accessSkillCounterReadSchema } from "../cases/access-skill/access-skill-guidelines";
import { accessSkillKernelVerdict, decideAccessSkill, runAccessSkillReadings, type AccessSkillCall, type AccessSkillTexts } from "../cases/access-skill/access-skill-rule";
import { entryConfirmJudgmentSchema, entrySkillPinned, type EntrySensitiveFamily, type EntrySkillBlock } from "./entry-block";
import { entryRouterPinned, readEntryRouterOutput } from "./entry-router";

/*
 * The PURE rule of the two-stage entry (chantier « 3 blocs », 19/11). No model, network, database or clock: it turns the stored readings of one mail
 * into a verdict, and orders the calls (`runEntryReadings`, the calls injected: the production transport behind the spend gate, the self-test's capped
 * ledger, or a scripted double). Same system limits as the Access skill (`access-skill-rule.ts`), generalised to any block:
 *   kernel phrase or truncated text → the WHOLE mail to the team, nothing paid;
 *   router (only with ≥ 2 blocks): strict output, every request once, a route `sensitive` / `unsure` or a mail it calls sensitive / unsure → the whole mail;
 *   confirmation by the full skill of each ELECTED block only (Access: its SAV-97 judge and counter-read, unchanged; another block: its own skill and the
 *   shared counter-read, Access's prompt), same checks as Access (schema, coverage, verbatim quotes, high confidence, no third party, no instruction);
 *   any confirmation that is not an admission for a reason other than « none of my requests » → the whole mail.
 * A request is admitted to a block only when the router elected it AND that block's skill confirms it AND no other elected block claims it. A request
 * routed `other`, or not confirmed, is a team part (SAV-92 `team_part`, decided downstream with the notice and the modes of several blocks).
 */

export const SAV_ENTRY_TEAM_REASONS = [
  "router_unpinned", "skill_unpinned", "kernel_phrase", "input_truncated", "router_unavailable", "router_invalid", "router_request_set_mismatch",
  "router_route_unknown", "router_sensitive", "router_unsure", "no_block_elected", "confirm_unavailable", "confirm_team", "no_block_confirmed",
] as const;
export type EntryTeamReason = typeof SAV_ENTRY_TEAM_REASONS[number];

/** One block's confirmation, by the same rule for every block. `team` with only `no_block_request`: this block takes none of the requests. */
export type EntryConfirmVerdict =
  | Readonly<{ outcome: "admit"; requests: Readonly<Record<string, "block" | "other">> }>
  | Readonly<{ outcome: "team"; reasons: readonly string[]; family: EntrySensitiveFamily | null }>;

const allTexts = (texts: AccessSkillTexts) => [texts.subject, texts.text, texts.original?.subject, texts.original?.text];
const verified = (texts: AccessSkillTexts, words: string) => allTexts(texts).some(value => typeof value === "string" && savEvidenceContains(value, words));

/** Several requests: the attribution of each quote must be provable on the request's OWN words (same rule as Access, `accessSkillAttributionProblems`). */
function attributionProblems(texts: AccessSkillTexts, requestIds: readonly string[], quotes: ReadonlyMap<string, string>): string[] {
  if (requestIds.length < 2) return [];
  const spans = texts.spans ?? {}, span = (id: string) => { const value = spans[id]; return typeof value === "string" && value.trim() ? value : null; };
  const reasons = new Set<string>();
  for (const id of requestIds) {
    const own = span(id);
    if (!own) { reasons.add("attribution_missing"); continue; }
    const others = requestIds.filter(other => other !== id).map(span).filter((value): value is string => value !== null);
    const quote = quotes.get(id);
    if (others.some(other => savEvidenceContains(own, other) || savEvidenceContains(other, own))) reasons.add("attribution_ambiguous");
    else if (quote !== undefined && !savEvidenceContains(own, quote)) reasons.add("attribution_mismatch");
    else if (quote !== undefined && others.some(other => savEvidenceContains(other, quote))) reasons.add("attribution_ambiguous");
  }
  return [...reasons];
}

/** A non-Access block's confirmation on its stored judge and the shared counter-read (`counter` absent when it was not called). */
export function decideBlockConfirm(input: Readonly<{ block: EntrySkillBlock; texts: AccessSkillTexts; requestIds: readonly string[]; judge: AccessSkillCall | null; counter: AccessSkillCall | null }>): EntryConfirmVerdict {
  const team = (reasons: string[], family: EntrySensitiveFamily | null = null): EntryConfirmVerdict => ({ outcome: "team", reasons: [...new Set(reasons)], family });
  if (!entrySkillPinned(input.block)) return team(["skill_unpinned"]);
  if (!input.judge || input.judge.status !== "ok") return team(["judgment_unavailable"]);
  const parsed = entryConfirmJudgmentSchema.safeParse(input.judge.output);
  if (!parsed.success) return team(["judgment_invalid"]);
  const judgment = parsed.data, reasons: string[] = [];
  let family: EntrySensitiveFamily | null = null;
  const ids = judgment.requests.map(row => row.requestId), expected = new Set(input.requestIds);
  if (!input.requestIds.length || ids.length !== expected.size || new Set(ids).size !== ids.length || ids.some(id => !expected.has(id))) reasons.push("request_set_mismatch");
  reasons.push(...attributionProblems(input.texts, input.requestIds, new Map(judgment.requests.map(row => [row.requestId, row.quote]))));
  if (allTexts(input.texts).some(value => typeof value === "string" && containsPromptInjection(value))) reasons.push("prompt_injection");
  if (judgment.mail.instructionLike) reasons.push("instruction_like");
  if (judgment.mail.thirdParty) reasons.push("third_party");
  if (judgment.mail.sensitive === "request") reasons.push("mail_sensitive");
  if (judgment.mail.sensitive === "unsure") reasons.push("mail_unsure");
  for (const mention of judgment.sensitiveMentions) {
    if (mention.role !== "context") { reasons.push("mention_request"); family ??= mention.family; }
    if (!verified(input.texts, mention.quote)) reasons.push("mention_unverified");
  }
  const requests: Record<string, "block" | "other"> = {};
  for (const row of judgment.requests) {
    if (row.verdict === "sensitive") { reasons.push("request_sensitive"); family ??= row.family; continue; }
    if (row.verdict === "unsure") { reasons.push("request_unsure"); continue; }
    if (row.confidence !== "high") { reasons.push("request_not_high"); continue; }
    if (!verified(input.texts, row.quote)) { reasons.push("quote_unverified"); continue; }
    requests[row.requestId] = row.verdict;
  }
  if (!Object.values(requests).includes("block")) reasons.push("no_block_request");
  if (reasons.length) return team(reasons, family);
  if (!input.counter || input.counter.status !== "ok") return team(["counter_unavailable"]);
  const counter = accessSkillCounterReadSchema.safeParse(input.counter.output);
  if (!counter.success) return team(["counter_invalid"]);
  if (counter.data.asksOrContestsSensitive === "yes") return team(["counter_yes"], counter.data.families[0] ?? null);
  if (counter.data.asksOrContestsSensitive === "unsure") return team(["counter_unsure"], counter.data.families[0] ?? null);
  return { outcome: "admit", requests };
}

/** Access's confirmation: its SAV-97 verdict, unchanged, read as a block confirmation (`access` → `block`). */
export function decideAccessConfirm(input: Readonly<{ texts: AccessSkillTexts; requestIds: readonly string[]; judge: AccessSkillCall | null; counter: AccessSkillCall | null }>): EntryConfirmVerdict {
  const verdict = decideAccessSkill(input);
  if (verdict.outcome === "admit") return { outcome: "admit", requests: Object.fromEntries(Object.entries(verdict.requests).map(([id, said]) => [id, said === "access" ? "block" : "other"])) };
  const reasons = verdict.reasons.map(reason => reason === "no_access_request" ? "no_block_request" : reason);
  return { outcome: "team", reasons, family: verdict.family };
}

const onlyNoneOfMine = (verdict: EntryConfirmVerdict) => verdict.outcome === "team" && verdict.reasons.length === 1 && verdict.reasons[0] === "no_block_request";

/** The catalog of one entry: Access (when it takes part) and the active blocks, by id. */
export type EntryCatalog = Readonly<{ access: boolean; blocks: readonly EntrySkillBlock[] }>;
export const entryCatalogIds = (catalog: EntryCatalog) => [...(catalog.access ? ["access"] : []), ...catalog.blocks.map(block => block.blockId)];

/** Everything stored about one mail's entry. `router: null` with ONE block in the catalog (no router call). */
export type EntryReadings = Readonly<{
  router: AccessSkillCall | null;
  access: Readonly<{ judge: AccessSkillCall | null; counter: AccessSkillCall | null }> | null;
  judges: Readonly<Record<string, AccessSkillCall>>;
  counter: AccessSkillCall | null;
}>;

export type EntryRequestOutcome = Readonly<{ blockId: string }> | Readonly<{ teamPart: "no_block_match" | "ambiguous_block" }>;
export type EntryVerdict =
  | Readonly<{ outcome: "admit"; requests: Readonly<Record<string, EntryRequestOutcome>> }>
  | Readonly<{ outcome: "team"; reasons: readonly EntryTeamReason[]; family: EntrySensitiveFamily | null; kernel: readonly string[];
    /** The confirmations' own closed reasons, for the logs (never a text). */
    detail: readonly string[] }>;

const teamVerdict = (reasons: EntryTeamReason[], extra: { family?: EntrySensitiveFamily | null; kernel?: readonly string[]; detail?: readonly string[] } = {}): EntryVerdict =>
  ({ outcome: "team", reasons: [...new Set(reasons)], family: extra.family ?? null, kernel: extra.kernel ?? [], detail: extra.detail ?? [] });

type Routing = Readonly<{ ok: true; routes: ReadonlyMap<string, string> }> | Readonly<{ ok: false; verdict: EntryVerdict }>;
/** Before any confirmation: pins, kernel, truncation, and the router's routes (or every request to the only block). */
function routeOf(input: Readonly<{ texts: AccessSkillTexts; requestIds: readonly string[]; catalog: EntryCatalog; router: AccessSkillCall | null }>): Routing {
  const ids = entryCatalogIds(input.catalog);
  if (ids.length >= 2 && !entryRouterPinned()) return { ok: false, verdict: teamVerdict(["router_unpinned"]) };
  if (input.catalog.blocks.some(block => !entrySkillPinned(block))) return { ok: false, verdict: teamVerdict(["skill_unpinned"]) };
  const kernel = accessSkillKernelVerdict(input.texts);
  if (kernel && kernel.outcome === "team") return { ok: false, verdict: teamVerdict(["kernel_phrase"], { family: kernel.family, kernel: kernel.kernel }) };
  if (input.texts.truncated?.length) return { ok: false, verdict: teamVerdict(["input_truncated"]) };
  if (!ids.length) return { ok: false, verdict: teamVerdict(["no_block_elected"]) };
  if (ids.length === 1) return { ok: true, routes: new Map(input.requestIds.map(id => [id, ids[0]!])) };
  if (!input.router || input.router.status !== "ok") return { ok: false, verdict: teamVerdict(["router_unavailable"]) };
  const read = readEntryRouterOutput(input.router.output, input.requestIds, ids);
  if (!read.ok) return { ok: false, verdict: teamVerdict([read.problem]) };
  const routes = [...read.routes.values()];
  if (read.mailSensitive === "yes" || routes.includes("sensitive")) return { ok: false, verdict: teamVerdict(["router_sensitive"]) };
  if (read.mailSensitive === "unsure" || routes.includes("unsure")) return { ok: false, verdict: teamVerdict(["router_unsure"]) };
  if (!routes.some(route => ids.includes(route))) return { ok: false, verdict: teamVerdict(["no_block_elected"]) };
  return { ok: true, routes: read.routes };
}
const electedOf = (routes: ReadonlyMap<string, string>, catalog: EntryCatalog) => {
  const ids = new Set(routes.values());
  return entryCatalogIds(catalog).filter(id => ids.has(id));
};

/** The verdict on one mail's stored readings. */
export function decideEntry(input: Readonly<{ texts: AccessSkillTexts; requestIds: readonly string[]; catalog: EntryCatalog; readings: EntryReadings }>): EntryVerdict {
  const routing = routeOf({ ...input, router: input.readings.router });
  if (!routing.ok) return routing.verdict;
  const confirms = new Map<string, EntryConfirmVerdict>();
  for (const blockId of electedOf(routing.routes, input.catalog)) {
    const block = input.catalog.blocks.find(row => row.blockId === blockId);
    confirms.set(blockId, blockId === "access"
      ? decideAccessConfirm({ texts: input.texts, requestIds: input.requestIds, judge: input.readings.access?.judge ?? null, counter: input.readings.access?.counter ?? null })
      : decideBlockConfirm({ block: block!, texts: input.texts, requestIds: input.requestIds, judge: input.readings.judges[blockId] ?? null, counter: input.readings.counter }));
  }
  const detail = [...confirms.entries()].flatMap(([blockId, verdict]) => verdict.outcome === "team" ? verdict.reasons.map(reason => `${blockId}:${reason}`) : []);
  for (const verdict of confirms.values()) {
    if (verdict.outcome === "team" && !onlyNoneOfMine(verdict)) {
      const unavailable = verdict.reasons.some(reason => /unavailable|invalid|unpinned/.test(reason));
      return teamVerdict([unavailable ? "confirm_unavailable" : "confirm_team"], { family: verdict.family, detail });
    }
  }
  const requests: Record<string, EntryRequestOutcome> = {};
  for (const requestId of input.requestIds) {
    const route = routing.routes.get(requestId)!, verdict = confirms.get(route);
    const claimedElsewhere = [...confirms.entries()].some(([blockId, other]) => blockId !== route && other.outcome === "admit" && other.requests[requestId] === "block");
    if (!verdict || verdict.outcome !== "admit" || verdict.requests[requestId] !== "block") requests[requestId] = { teamPart: claimedElsewhere ? "ambiguous_block" : "no_block_match" };
    else requests[requestId] = claimedElsewhere ? { teamPart: "ambiguous_block" } : { blockId: route };
  }
  if (!Object.values(requests).some(row => "blockId" in row)) return teamVerdict(["no_block_confirmed"], { detail });
  return { outcome: "admit", requests };
}

/** One injected call of the entry. `access` returns Access's own readings (its judge, then its counter-read only when it can still change its verdict). */
export type EntryCall =
  | ((kind: Readonly<{ kind: "router" }> | Readonly<{ kind: "judge"; blockId: string }> | Readonly<{ kind: "counter" }>) => Promise<AccessSkillCall>);
export type EntryAccessCall = () => Promise<Readonly<{ judge: AccessSkillCall | null; counter: AccessSkillCall | null }>>;

/**
 * The readings of one mail in the production order: kernel and truncation first (nothing paid), the router (only with ≥ 2 blocks), then each elected
 * block's confirmation, then the shared counter-read only when a non-Access confirmation can still admit. Stops paying as soon as the mail is the team's.
 */
export async function runEntryReadings(input: Readonly<{ texts: AccessSkillTexts; requestIds: readonly string[]; catalog: EntryCatalog }>, call: EntryCall, access: EntryAccessCall): Promise<EntryReadings> {
  const empty: EntryReadings = { router: null, access: null, judges: {}, counter: null };
  const ids = entryCatalogIds(input.catalog);
  if (!routeOf({ ...input, router: { status: "ok", output: { mailSensitive: "no", requests: input.requestIds.map(requestId => ({ requestId, route: ids[0] ?? "other", reason: "pre-check" })) } } }).ok) return empty;
  const router = ids.length >= 2 ? await call({ kind: "router" }) : null;
  const routing = routeOf({ ...input, router });
  if (!routing.ok) return { ...empty, router };
  const elected = electedOf(routing.routes, input.catalog), judges: Record<string, AccessSkillCall> = {};
  let accessReadings: EntryReadings["access"] = null;
  for (const blockId of elected) {
    if (blockId === "access") accessReadings = await access();
    else judges[blockId] = await call({ kind: "judge", blockId });
  }
  const precheckCounter: AccessSkillCall = { status: "ok", output: { asksOrContestsSensitive: "no", families: [], quote: null, reason: "pre-check" } };
  const needsCounter = elected.filter(id => id !== "access").some(blockId => decideBlockConfirm({ block: input.catalog.blocks.find(row => row.blockId === blockId)!,
    texts: input.texts, requestIds: input.requestIds, judge: judges[blockId] ?? null, counter: precheckCounter }).outcome === "admit");
  const counter = needsCounter ? await call({ kind: "counter" }) : null;
  return { router, access: accessReadings, judges, counter };
}

/** Access's readings in the evaluation and self-test (no store): exactly `runAccessSkillReadings`. */
export const entryAccessReadingsWith = (texts: AccessSkillTexts, requestIds: readonly string[], call: (kind: "judge" | "counter") => Promise<AccessSkillCall>): EntryAccessCall =>
  () => runAccessSkillReadings({ texts, requestIds }, call);
