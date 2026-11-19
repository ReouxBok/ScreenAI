import "server-only";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../../crypto";
import { SAV_V2_MODEL_ENV } from "../investigation-v2-providers";
import { readOrComputeAccessSkill, prepareV2SkillCall, spendGatedV2SkillCall, type AccessSkillDeps, type AccessSkillPurpose } from "../access-skill/access-skill-judge";
import { accessSkillTextsOf, type AccessSkillCall } from "../access-skill/access-skill-rule";
import { accessSkillInputHash } from "../access-skill/access-skill-wire";
import { renderEntryConfirmPrompt } from "../../skills/entry-block";
import { decideEntry, entryCatalogIds, runEntryReadings, type EntryCatalog, type EntryReadings, type EntryVerdict } from "../../skills/entry-decision";
import { entryPackageSha256 } from "../../skills/entry-package";
import { entryRouterAccessLine, entryRouterLineOf, renderEntryRouterPrompt } from "../../skills/entry-router";
import { entryWireBody, type EntrySkillInput } from "../../skills/entry-wire";

/*
 * Chantier « 3 blocs » (19/11): the two-stage entry's readings of ONE mail, computed once and stored, then read again by every later caller (creation,
 * relay, re-evaluation), exactly like the Access skill (`access-skill-judge.ts`):
 *   - one row per (purpose, mail, package) in `sav.sync_state` (no migration), claimed `pending` before any spend: a second caller never pays again,
 *     a row left `pending` stays unavailable (the mail stays with the team; never a second spend on an uncertain outcome);
 *   - the router, each elected non-Access block's confirmation and the shared counter-read are stored there, encrypted; Access's own readings stay in
 *     ITS row (`sav-v2-access-skill.v1:...`, same key, same input as the SAV-97 path, so both paths share one paid reading);
 *   - every call goes through V2's Gemini transport and V2's `model` budget (reserved before, settled after, no retry);
 *   - the verdict is always recomputed from the stored readings by the pure rule (`entry-decision.ts`).
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_ENTRY_SKILL_STORE_PREFIX = "sav-v2-entry-skill.v1";
export const SAV_ENTRY_SKILL_SHADOW_PREFIX = "sav-v2-entry-skill-shadow.v1";
export type EntrySkillStored = Readonly<{
  version: 1; packageSha256: string; catalog: readonly string[]; inputHash: string; model: string; startedAt: string; completedAt: string;
  router: AccessSkillCall | null; judges: Readonly<Record<string, AccessSkillCall>>; counter: AccessSkillCall | null;
  /** Whether Access was elected and its own (separately stored) reading was asked for. */
  accessAsked: boolean;
}>;
export type EntrySkillReading =
  | Readonly<{ status: "ready"; verdict: EntryVerdict; computed: boolean; packageSha256: string }>
  | Readonly<{ status: "unavailable"; reason: "absent" | "in_flight" | "input_changed" | "unreadable" | "store_failed" }>;

export const entrySkillStoreKey = (purpose: AccessSkillPurpose, messageId: string, packageSha256: string) => `${SAV_ENTRY_SKILL_STORE_PREFIX}:${purpose}:${messageId}:${packageSha256.slice(0, 16)}`;
export const entrySkillShadowKey = (purpose: AccessSkillPurpose, messageId: string, packageSha256: string) => `${SAV_ENTRY_SKILL_SHADOW_PREFIX}:${purpose}:${messageId}:${packageSha256.slice(0, 16)}`;

/** The system prompt of one entry call (router or a block's confirmation). */
export function entryCallPrompt(catalog: EntryCatalog, kind: "router" | "judge", blockId?: string): string {
  if (kind === "router") return renderEntryRouterPrompt([...(catalog.access ? [entryRouterAccessLine()] : []), ...catalog.blocks.map(entryRouterLineOf)]);
  const block = catalog.blocks.find(row => row.blockId === blockId);
  if (!block) throw Error("SAV_ENTRY_SKILL_BLOCK_UNKNOWN");
  return renderEntryConfirmPrompt(block);
}

/** Prepares one entry call on V2's transport, without any budget (the production reading adds V2's `model` budget; the self-test its own ledger). */
export function prepareEntryCall(deps: AccessSkillDeps, catalog: EntryCatalog, input: EntrySkillInput, call: Readonly<{ kind: "router" }> | Readonly<{ kind: "judge"; blockId: string }> | Readonly<{ kind: "counter" }>) {
  const prompt = call.kind === "counter" ? "" : entryCallPrompt(catalog, call.kind, call.kind === "judge" ? call.blockId : undefined);
  return prepareV2SkillCall(deps, maxOutputTokens => entryWireBody(call.kind === "judge" ? "confirm" : call.kind, prompt, input, maxOutputTokens));
}

const verdictOf = (stored: EntrySkillStored, input: EntrySkillInput, catalog: EntryCatalog, access: EntryReadings["access"]) =>
  decideEntry({ texts: accessSkillTextsOf(input), requestIds: input.requests.map(row => row.requestId), catalog,
    readings: { router: stored.router, judges: stored.judges, counter: stored.counter, access } });

async function accessReadingsOf(deps: AccessSkillDeps, purpose: AccessSkillPurpose, messageId: string, input: EntrySkillInput, compute: boolean): Promise<EntryReadings["access"]> {
  const reading = await readOrComputeAccessSkill(deps, { purpose, messageId, input, compute });
  return reading.status === "ready" ? { judge: reading.stored.judge, counter: reading.stored.counter } : { judge: null, counter: null };
}

async function readStored(deps: AccessSkillDeps, key: string, request: Readonly<{ purpose: AccessSkillPurpose; messageId: string; input: EntrySkillInput; catalog: EntryCatalog }>,
  packageSha256: string, inputHash: string): Promise<EntrySkillReading | null> {
  const [row] = await requireDb().select().from(savSyncState).where(eq(savSyncState.key, key));
  if (!row) return null;
  if (row.status !== "done") return { status: "unavailable", reason: "in_flight" };
  let stored: EntrySkillStored;
  try { stored = decryptSavPayload<EntrySkillStored>(row.cursor ?? ""); } catch { return { status: "unavailable", reason: "unreadable" }; }
  if (stored?.version !== 1 || stored.packageSha256 !== packageSha256) return { status: "unavailable", reason: "unreadable" };
  if (stored.inputHash !== inputHash) return { status: "unavailable", reason: "input_changed" };
  // Access's reading is read where SAV-97 stored it, never paid again here.
  const access = stored.accessAsked ? await accessReadingsOf(deps, request.purpose, request.messageId, request.input, false) : null;
  return { status: "ready", verdict: verdictOf(stored, request.input, request.catalog, access), computed: false, packageSha256 };
}

/**
 * The entry's reading of one mail: the stored one, or (only when `compute`) computed now and stored. `compute: false` never pays: absent stays absent.
 */
export async function readOrComputeEntrySkills(deps: AccessSkillDeps, request: Readonly<{ purpose: AccessSkillPurpose; messageId: string; input: EntrySkillInput; catalog: EntryCatalog; compute: boolean }>): Promise<EntrySkillReading> {
  const model = deps.env()[SAV_V2_MODEL_ENV] ?? "", packageSha256 = entryPackageSha256(request.catalog, model);
  const key = entrySkillStoreKey(request.purpose, request.messageId, packageSha256), inputHash = accessSkillInputHash(request.input);
  try {
    const existing = await readStored(deps, key, request, packageSha256, inputHash);
    if (existing) return existing;
    if (!request.compute) return { status: "unavailable", reason: "absent" };
    const startedAt = deps.now().toISOString();
    const claimed = await requireDb().insert(savSyncState).values({ key, status: "pending", cursor: null, startedAt: new Date(startedAt) }).onConflictDoNothing().returning({ key: savSyncState.key });
    if (!claimed.length) return (await readStored(deps, key, request, packageSha256, inputHash)) ?? { status: "unavailable", reason: "in_flight" };
    const callKey = (suffix: string) => `entry-skill:${request.purpose}:${request.messageId}:${packageSha256.slice(0, 16)}:${suffix}`;
    let accessAsked = false, access: EntryReadings["access"] = null;
    const readings = await runEntryReadings({ texts: accessSkillTextsOf(request.input), requestIds: request.input.requests.map(row => row.requestId), catalog: request.catalog },
      call => spendGatedV2SkillCall(deps, prepareEntryCall(deps, request.catalog, request.input, call), callKey(call.kind === "judge" ? `judge:${call.blockId}` : call.kind)),
      async () => { accessAsked = true; access = await accessReadingsOf(deps, request.purpose, request.messageId, request.input, true); return access!; });
    const stored: EntrySkillStored = { version: 1, packageSha256, catalog: entryCatalogIds(request.catalog), inputHash, model, startedAt, completedAt: deps.now().toISOString(),
      router: readings.router, judges: readings.judges, counter: readings.counter, accessAsked };
    const [written] = await requireDb().update(savSyncState).set({ status: "done", cursor: encryptSavPayload(stored), completedAt: new Date(stored.completedAt), updatedAt: new Date() })
      .where(and(eq(savSyncState.key, key), eq(savSyncState.status, "pending"))).returning({ key: savSyncState.key });
    if (!written) return { status: "unavailable", reason: "store_failed" };
    return { status: "ready", verdict: verdictOf(stored, request.input, request.catalog, access), computed: true, packageSha256 };
  } catch {
    return { status: "unavailable", reason: "store_failed" };
  }
}

/** Closed codes only (never a customer's or a model's text): what the entry concluded, for the logs and the shadow comparison. */
export function entrySkillLogFields(reading: EntrySkillReading) {
  if (reading.status !== "ready") return { entry: "unavailable", reason: reading.reason };
  const verdict = reading.verdict, packageSha = reading.packageSha256.slice(0, 16);
  return verdict.outcome === "admit"
    ? { entry: "admit", routes: Object.values(verdict.requests).map(row => "blockId" in row ? row.blockId : `team_part:${row.teamPart}`).join(","), computed: reading.computed, packageSha }
    : { entry: "team", reasons: verdict.reasons.join(","), detail: verdict.detail.join(","), kernel: verdict.kernel.join(","), computed: reading.computed, packageSha };
}

/** The shadow comparison of one mail, stored once (closed codes): what really decided, what the entry would have decided, whether they disagree. */
export async function recordEntrySkillShadow(input: Readonly<{ purpose: AccessSkillPurpose; messageId: string; packageSha256: string; actual: string; shadow: string; now: Date }>) {
  const disagree = input.actual !== input.shadow;
  await requireDb().insert(savSyncState).values({ key: entrySkillShadowKey(input.purpose, input.messageId, input.packageSha256), status: "done",
    cursor: encryptSavPayload({ version: 1, actual: input.actual, shadow: input.shadow, disagree, at: input.now.toISOString() }), startedAt: input.now, completedAt: input.now }).onConflictDoNothing();
  return disagree;
}
