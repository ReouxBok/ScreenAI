import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
import { ACCESS_SKILL_TEST_PROVIDER_ENV } from "../../../../../test/sav-access-skill-double";
import {
  savActions, savCaseEffectExecutions, savCaseEvents, savCases, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savMailboxes, savMessages, savSyncState, savThreads, staffUsers,
} from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { encryptSavPayload, decryptSavPayload } from "../../crypto";
import { savRetrievalCardSizeFixOn } from "../../request-retrieval";
import { accessSkillWireAnswer } from "../access-skill/access-skill-wire";
import { emptyCaseBody, SAV_CASE_CONTRACT_REVISION } from "../case-types";
import type { SmartKnowledgePort } from "./smart-agent";
import type { SmartItemRow } from "./smart-ledger";
import type { SmartEmbedPort } from "./smart-model";
import { smartPromptSha256 } from "./smart-prompt";
import { readSmartReplayConfig, readSmartReplaySentReplies, runSmartReplayPass, selectSmartReplayCandidates, smartReplayPrefix, type SmartReplayStored } from "./smart-shadow-replay";
import { readSmartReplayReport } from "./smart-shadow-replay-report";
import { SMART_CONFORME, SMART_TEST_CARD, smartGoodDecision, smartReading } from "./smart-test-doubles";

/*
 * Agent SAV intelligent (26/11): the replay's OWN switches (`SAV_V2_SMART_SHADOW_REPLAY_FLAGS`, `_THREADS`) on the real store (PGlite), the model
 * doubled at the network boundary, FICTIONAL mails (@exemple.invalid). Proves: no flag = the previous replay; a closed list (forward, images,
 * live search, unknown refused); card_size_fix scoped to the turn; commercial_split through a local env only; no_repeat with the replies sent
 * BEFORE the mail only; the thread filter; the flags stored and shown in the report; 0 effect.
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "";
const AT = new Date("2026-11-25T10:00:00.000Z"), RUN = "v20-flags-test";
const FROM = "2026-11-24T00:00:00Z", UNTIL = "2026-11-25T10:00:00Z";
const ENV = (extra: Record<string, string> = {}) => ({ ...ACCESS_SKILL_TEST_PROVIDER_ENV, SAV_V2_SMART_SHADOW_REPLAY: RUN, SAV_V2_SMART_SHADOW_REPLAY_FROM: FROM,
  SAV_V2_SMART_SHADOW_REPLAY_UNTIL: UNTIL, ...extra });
const SENT_BEFORE = "Bonjour, pour recevoir le code de connexion, vérifiez vos courriers indésirables puis demandez un nouveau code depuis la page de connexion Limova.";
const SENT_AFTER = "Réponse envoyée APRÈS la réception du mail rejoué : ne doit jamais être donnée au rejeu.";

type Kind = "understand" | "decide" | "verify" | "embed";
function network() {
  const calls: Array<{ kind: Kind; system: string; payload: Record<string, unknown> | null }> = [];
  const fn = async (url: string, init: RequestInit) => {
    if (!url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/")) throw Error(`UNEXPECTED_HOST ${url}`);
    const body = JSON.parse(String(init.body));
    if (url.endsWith(":batchEmbedContents")) {
      calls.push({ kind: "embed", system: "", payload: null });
      return Response.json({ embeddings: body.requests.map(() => ({ values: Array(768).fill(0.01) })) });
    }
    const system: string = body.systemInstruction.parts[0].text, payload = JSON.parse(body.contents[0].parts[0].text);
    const kind: Kind = system.startsWith("Tu lis un mail") ? "understand" : system.startsWith("RELECTURE") ? "verify" : "decide";
    calls.push({ kind, system, payload });
    const output = kind === "understand" ? smartReading() : kind === "verify" ? SMART_CONFORME : { thinking: "", action: "final", calls: [], decision: smartGoodDecision() };
    return Response.json(accessSkillWireAnswer(output, { inputTokens: 1_000, outputTokens: 200 }));
  };
  return { fn, calls };
}
/** The knowledge double records, at each search, whether SAV_RETRIEVAL_CARD_SIZE_FIX reads `on` inside the turn. */
const sizeFixSeen: boolean[] = [];
const knowledge = (embed: SmartEmbedPort): SmartKnowledgePort => async () => {
  sizeFixSeen.push(savRetrievalCardSizeFixOn());
  const embedded = await embed(["connexion code non reçu"]);
  return embedded.status === "ok" ? { status: "ok", sources: [SMART_TEST_CARD], codes: [] } : { status: "unavailable", sources: [], codes: [embedded.problem] };
};
const replay = (env: Record<string, string>, net: ReturnType<typeof network>, log: (event: string, fields: unknown) => void = () => undefined) =>
  runSmartReplayPass({ env: () => env, now: () => AT, network: net.fn, knowledge, log });

async function v1Mail(options: { receivedAt?: Date } = {}) {
  const threadId = randomUUID(), messageId = randomUUID(), receivedAt = options.receivedAt ?? new Date(AT.getTime() - 3_600_000);
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `t-${threadId}`, subject: "Connexion", customerEmail: "client@exemple.invalid" });
  const message = (text: string, at: Date, id = randomUUID()) => f.db.insert(savMessages).values({ id, threadId, mailboxId, direction: "inbound",
    fromEmail: "client@exemple.invalid", toEmails: [], subject: "Connexion", bodyCiphertext: encryptSavPayload({ text }), receivedAt: at, gmailMessageId: `gm-${id}` });
  await message("Message précédent du client.", new Date(receivedAt.getTime() - 86_400_000));
  await message("Bonjour,\nJ'ai suivi vos conseils mais je ne reçois toujours pas le code.\nMerci", receivedAt, messageId);
  await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion: 1, policyId, policyHash: "fixture", state: "confirmed",
    ticketId: String(Math.floor(Math.random() * 1e9)), payloadCiphertext: encryptSavPayload({ plan: { decision: { classification: "support", requests: [{ id: "r0", kind: "support" }] } } }) });
  return { messageId, threadId, receivedAt };
}
/** A V2 case on the thread with confirmed reply mails (fictional), as the case store keeps them. */
async function caseWithReplies(threadId: string, replies: ReadonlyArray<{ text: string; at: Date }>) {
  const [row] = await f.db.insert(savCases).values({ ticketId: String(Math.floor(Math.random() * 1e9)), threadIds: [threadId], owner: "human", phase: "human_owned", sensitivity: "none",
    contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload(emptyCaseBody()) }).returning();
  for (const reply of replies) {
    const [execution] = await f.db.insert(savCaseEffectExecutions).values({ caseId: row!.id, replyKey: `reply:${randomUUID()}`, threadId, policyId, policyHash: "fixture", state: "confirmed",
      payloadCiphertext: encryptSavPayload({ proposal: { text: reply.text } }) }).returning();
    await f.db.insert(savIntakeEffects).values({ businessKey: `reply-send:${randomUUID()}`, executionId: execution!.id, kind: "reply_send", permission: "send_case_reply", state: "confirmed",
      intentHash: "fixture", intentCiphertext: encryptSavPayload({}), dispatchedAt: reply.at, confirmedAt: reply.at });
  }
  return row!.id;
}
async function effects() {
  const count = async (table: typeof savCases | typeof savCaseEvents | typeof savCaseEffectExecutions | typeof savIntakeEffects | typeof savActions) => (await f.db.select().from(table)).length;
  return { cases: await count(savCases), events: await count(savCaseEvents), caseEffects: await count(savCaseEffectExecutions), intakeEffects: await count(savIntakeEffects),
    actions: await count(savActions), messages: (await f.db.select().from(savMessages)).length };
}
async function storedRow(runId: string, messageId: string) {
  const [row] = await f.db.select({ cursor: savSyncState.cursor }).from(savSyncState).where(like(savSyncState.key, `${smartReplayPrefix(runId)}:item:mail:${messageId}`));
  return decryptSavPayload<SmartItemRow<SmartReplayStored>>(row!.cursor!)!.result!;
}
let fetches: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-replay-fixture-key-32-chars!!!!!");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-replay-flags-admin", email: "replay-admin@exemple.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@exemple.invalid" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-replay-fixture-key-32-chars!!!!!");
  fetches = vi.fn(async () => { throw Error("GLOBAL_NETWORK_FORBIDDEN"); });
  vi.stubGlobal("fetch", fetches);
  state.db = f.db; sizeFixSeen.length = 0;
  await f.db.delete(savSyncState).where(like(savSyncState.key, "sav-v2-smart-shadow%"));
  await f.db.delete(savIntakeExecutions);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("interrupteurs du rejeu : liste fermée", () => {
  it("absents ou vides : aucun interrupteur, aucun filtre de fil", () => {
    expect(readSmartReplayConfig(ENV())).toMatchObject({ mode: "replay", flags: [], threads: null });
    expect(readSmartReplayConfig(ENV({ SAV_V2_SMART_SHADOW_REPLAY_FLAGS: "", SAV_V2_SMART_SHADOW_REPLAY_THREADS: "" }))).toMatchObject({ mode: "replay", flags: [], threads: null });
    expect(readSmartReplayConfig(ENV({ SAV_V2_SMART_SHADOW_REPLAY_FLAGS: " no_repeat , card_size_fix,commercial_split,no_repeat" })))
      .toMatchObject({ mode: "replay", flags: ["card_size_fix", "commercial_split", "no_repeat"] });
  });
  it("forward, images, live_search, inconnu ou élément vide : run refusé `flags_invalid`, rien lu ni payé", async () => {
    state.db = null;
    const net = network();
    for (const value of ["forward", "images", "live_search", "inconnu", "commercial_forward", "no_repeat,forward", "card_size_fix,", "NO_REPEAT", "no_repeat,,card_size_fix"]) {
      expect(readSmartReplayConfig(ENV({ SAV_V2_SMART_SHADOW_REPLAY_FLAGS: value }))).toEqual({ mode: "refused", reason: "flags_invalid" });
      expect(await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY_FLAGS: value }), net)).toEqual({ skipped: "refused", reason: "flags_invalid" });
    }
    for (const value of ["pas-un-uuid", `${randomUUID()},`, randomUUID().toUpperCase()]) {
      expect(await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY_THREADS: value }), net)).toEqual({ skipped: "refused", reason: "threads_invalid" });
    }
    expect(net.calls).toEqual([]);
    expect(fetches).not.toHaveBeenCalled();
  });
});

describe("_FLAGS vide : le rejeu de main, à l'identique", () => {
  it("mêmes appels et mêmes charges au modèle, même ligne stockée (sans champ flags), même journal", async () => {
    const { messageId } = await v1Mail();
    const absent = network(), empty = network(), logsAbsent: unknown[] = [], logsEmpty: unknown[] = [];
    await replay(ENV(), absent, (event, fields) => logsAbsent.push([event, fields]));
    await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY: "v20-flags-empty", SAV_V2_SMART_SHADOW_REPLAY_FLAGS: "", SAV_V2_SMART_SHADOW_REPLAY_THREADS: "" }), empty,
      (event, fields) => logsEmpty.push([event, fields]));
    expect(empty.calls).toEqual(absent.calls);
    expect(sizeFixSeen).toEqual([false, false]);
    const a = await storedRow(RUN, messageId), b = await storedRow("v20-flags-empty", messageId);
    expect({ ...b, runId: RUN, startedAt: a.startedAt, durationMs: a.durationMs }).toEqual(a);
    expect(Object.keys(a)).not.toContain("flags");
    expect(Object.keys(a)).not.toContain("sentRepliesBefore");
    expect(JSON.stringify(logsEmpty).replace("v20-flags-empty", RUN)).toBe(JSON.stringify(logsAbsent));
    for (const [, fields] of logsAbsent as Array<[string, Record<string, unknown>]>) expect(fields).not.toHaveProperty("flags");
  });
});

describe("card_size_fix : la surcharge ne vaut que pour le tour du rejeu", () => {
  it("allumé dans le tour, éteint hors du tour et sans flag ; process.env jamais écrit", async () => {
    await v1Mail(); await v1Mail();
    const before = process.env.SAV_RETRIEVAL_CARD_SIZE_FIX;
    await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY_FLAGS: "card_size_fix", SAV_V2_SMART_SHADOW_REPLAY_BATCH: "1" }), network());
    expect(sizeFixSeen).toEqual([true]);
    expect(savRetrievalCardSizeFixOn()).toBe(false);
    await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY: "v20-flags-off" }), network());
    expect(sizeFixSeen.slice(1)).toEqual([false, false]);
    expect(process.env.SAV_RETRIEVAL_CARD_SIZE_FIX).toBe(before);
  });
});

describe("commercial_split : un env local au rejeu", () => {
  it("empreinte du jeu commercial dans la ligne, prompt de lecture commercial, process.env intact", async () => {
    const { messageId } = await v1Mail();
    const net = network(), off = network();
    await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY_FLAGS: "commercial_split" }), net);
    await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY: "v20-flags-off" }), off);
    const on = await storedRow(RUN, messageId), plain = await storedRow("v20-flags-off", messageId);
    expect(on.promptSha256).toBe(smartPromptSha256({ commercialSplit: true }));
    expect(plain.promptSha256).toBe(smartPromptSha256({}));
    expect(on.promptSha256).not.toBe(plain.promptSha256);
    expect(on.flags).toEqual(["commercial_split"]);
    expect(net.calls.find(call => call.kind === "understand")!.system).not.toBe(off.calls.find(call => call.kind === "understand")!.system);
    expect(process.env.SAV_V2_SMART_COMMERCIAL_SPLIT).toBeUndefined();
  });
});

describe("no_repeat : seules les réponses envoyées AVANT le mail", () => {
  it("lecture seule : la réponse antérieure est donnée, la postérieure jamais", async () => {
    const { threadId, receivedAt } = await v1Mail();
    await caseWithReplies(threadId, [{ text: SENT_BEFORE, at: new Date(receivedAt.getTime() - 3_600_000) }, { text: SENT_AFTER, at: new Date(receivedAt.getTime() + 60_000) }]);
    expect((await readSmartReplaySentReplies(threadId, receivedAt)).map(row => row.text)).toEqual([SENT_BEFORE]);
    expect(await readSmartReplaySentReplies(randomUUID(), receivedAt)).toEqual([]);
  });
  it("2e tour (le client répond à notre réponse) : alreadySent reçu par lecture, décision et relecture ; 0 effet ; ligne marquée", async () => {
    const { messageId, threadId, receivedAt } = await v1Mail();
    await caseWithReplies(threadId, [{ text: SENT_BEFORE, at: new Date(receivedAt.getTime() - 3_600_000) }, { text: SENT_AFTER, at: new Date(receivedAt.getTime() + 60_000) }]);
    const before = await effects(), net = network();
    expect(await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY_FLAGS: "no_repeat" }), net)).toMatchObject({ ran: 1, outcomes: { reply: 1 } });
    const models = net.calls.filter(call => call.kind !== "embed");
    expect(models.map(call => call.kind)).toEqual(["understand", "decide", "verify"]);
    for (const call of models) {
      expect(call.payload).toHaveProperty("alreadySent");
      expect(JSON.stringify(call.payload!.alreadySent)).toContain("vérifiez vos courriers indésirables");
      expect(JSON.stringify(call.payload)).not.toContain("APRÈS la réception");
    }
    expect(models[0]!.system).toContain("DÉJÀ ENVOYÉ (alreadySent)");
    expect(await effects()).toEqual(before);
    expect(fetches).not.toHaveBeenCalled();
    expect(await storedRow(RUN, messageId)).toMatchObject({ flags: ["no_repeat"], sentRepliesBefore: 1 });
    // Without the flag, the same mail gives no alreadySent at all.
    const off = network();
    await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY: "v20-flags-off" }), off);
    for (const call of off.calls.filter(row => row.kind !== "embed")) expect(call.payload).not.toHaveProperty("alreadySent");
  });
});

describe("_THREADS : restreint les candidats", () => {
  it("seuls les mails des fils listés sont sélectionnés et rejoués", async () => {
    const kept = await v1Mail(), other = await v1Mail();
    const all = await selectSmartReplayCandidates({ runId: RUN, from: new Date(FROM), until: new Date(UNTIL), limit: 50 });
    expect(new Set(all.map(row => row.messageId))).toEqual(new Set([kept.messageId, other.messageId]));
    const only = await selectSmartReplayCandidates({ runId: RUN, from: new Date(FROM), until: new Date(UNTIL), limit: 50, threads: [kept.threadId] });
    expect(only.map(row => row.messageId)).toEqual([kept.messageId]);
    const net = network();
    expect(await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY_THREADS: kept.threadId }), net)).toMatchObject({ ran: 1, runMails: 1 });
    expect(await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY_THREADS: kept.threadId }), net)).toMatchObject({ ran: 0, stoppedBy: "no_mail" });
  });
});

describe("rapport : un run allumé se distingue d'un run éteint", () => {
  it("révisions et lignes v20 portent les flags ; un run éteint n'en porte aucun", async () => {
    const { messageId } = await v1Mail();
    await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY_FLAGS: "no_repeat,card_size_fix" }), network());
    await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY: "v20-flags-off" }), network());
    const on = await readSmartReplayReport({ replayId: RUN }), off = await readSmartReplayReport({ replayId: "v20-flags-off" });
    expect(on.summary.revisions).toHaveLength(1);
    expect(on.summary.revisions[0]).toMatch(/:flags=card_size_fix\+no_repeat$/);
    expect(on.cases.find(row => row.messageId === messageId)!.v20).toMatchObject({ flags: ["card_size_fix", "no_repeat"], sentRepliesBefore: 0 });
    expect(off.summary.revisions[0]).not.toContain("flags");
    expect(off.cases[0]!.v20).not.toHaveProperty("flags");
  });
});
