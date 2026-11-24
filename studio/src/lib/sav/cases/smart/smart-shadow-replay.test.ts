import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
import { ACCESS_SKILL_TEST_PROVIDER_ENV } from "../../../../../test/sav-access-skill-double";
import {
  savActions, savCaseEffectExecutions, savCaseEvents, savCases, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savMailboxes, savMessages, savSyncState, savThreads, staffUsers,
} from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../../crypto";
import { accessSkillWireAnswer } from "../access-skill/access-skill-wire";
import type { SmartKnowledgePort } from "./smart-agent";
import { readSmartLedger } from "./smart-ledger";
import type { SmartEmbedPort } from "./smart-model";
import { runSmartShadowPass, SAV_SMART_SHADOW_PREFIX, selectSmartShadowCandidates } from "./smart-shadow";
import { readSmartReplayConfig, runSmartReplayPass, SAV_SMART_REPLAY_BASE, SAV_SMART_REPLAY_ID, selectSmartReplayCandidates, smartReplayPrefix } from "./smart-shadow-replay";
import { readSmartReplayReport, smartReplayTexts } from "./smart-shadow-replay-report";
import { SMART_CONFORME, SMART_TEST_CARD, smartGoodDecision, smartReading } from "./smart-test-doubles";

/*
 * Agent SAV intelligent (25/11): the bounded REPLAY of the shadow on the real store (PGlite), the model doubled at the network boundary, FICTIONAL
 * mails. Proves: off = 0 read and the reconcile pass does not load it; same selection as the shadow; 0 effect and the shadow's rows untouched;
 * each mail once per run; the run's money and mail caps; distinct keys; the report (v19 next to v20, with the texts).
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "";
const AT = new Date("2026-11-25T10:00:00.000Z"), RUN = "v20-replay-test";
const FROM = "2026-11-24T00:00:00Z", UNTIL = "2026-11-25T10:00:00Z";
const ENV = (extra: Record<string, string> = {}) => ({ ...ACCESS_SKILL_TEST_PROVIDER_ENV, SAV_V2_SMART_SHADOW_REPLAY: RUN, SAV_V2_SMART_SHADOW_REPLAY_FROM: FROM,
  SAV_V2_SMART_SHADOW_REPLAY_UNTIL: UNTIL, ...extra });
const TEAM_REPLY = "Réponse de l'équipe écrite APRÈS le mail : ne doit jamais être lue.";

type Kind = "understand" | "decide" | "verify" | "embed";
function network(options: { onCall?: (kind: Kind) => void } = {}) {
  const calls: Array<{ kind: Kind; payload: unknown }> = [];
  const fn = async (url: string, init: RequestInit) => {
    if (!url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/")) throw Error(`UNEXPECTED_HOST ${url}`);
    const body = JSON.parse(String(init.body));
    if (url.endsWith(":batchEmbedContents")) {
      calls.push({ kind: "embed", payload: null }); options.onCall?.("embed");
      return Response.json({ embeddings: body.requests.map(() => ({ values: Array(768).fill(0.01) })) });
    }
    const system: string = body.systemInstruction.parts[0].text, payload = JSON.parse(body.contents[0].parts[0].text);
    const kind: Kind = system.startsWith("Tu lis un mail") ? "understand" : system.startsWith("RELECTURE") ? "verify" : "decide";
    calls.push({ kind, payload }); options.onCall?.(kind);
    const output = kind === "understand" ? smartReading() : kind === "verify" ? SMART_CONFORME : { thinking: "", action: "final", calls: [], decision: smartGoodDecision() };
    return Response.json(accessSkillWireAnswer(output, { inputTokens: 1_000, outputTokens: 200 }));
  };
  return { fn, calls };
}
const knowledge = (embed: SmartEmbedPort): SmartKnowledgePort => async () => {
  const embedded = await embed(["connexion code non reçu"]);
  return embedded.status === "ok" ? { status: "ok", sources: [SMART_TEST_CARD], codes: [] } : { status: "unavailable", sources: [], codes: [embedded.problem] };
};
const replay = (env: Record<string, string>, net: ReturnType<typeof network>, extra: Partial<Parameters<typeof runSmartReplayPass>[0]> = {}) =>
  runSmartReplayPass({ env: () => env, now: () => AT, network: net.fn, knowledge, log: () => undefined, ...extra });

async function v1Mail(options: { receivedAt?: Date; kinds?: string[]; executionThread?: "same" | "other"; state?: "confirmed" | "running" } = {}) {
  const threadId = randomUUID(), messageId = randomUUID(), receivedAt = options.receivedAt ?? new Date(AT.getTime() - 3_600_000);
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `t-${threadId}`, subject: "Connexion", customerEmail: "client@exemple.invalid" });
  const message = (direction: "inbound" | "outbound", text: string, at: Date, id = randomUUID()) => f.db.insert(savMessages).values({ id, threadId, mailboxId, direction,
    fromEmail: direction === "inbound" ? "client@exemple.invalid" : "support@exemple.invalid", toEmails: [], subject: "Connexion", bodyCiphertext: encryptSavPayload({ text }), receivedAt: at, gmailMessageId: `gm-${id}` });
  await message("inbound", "Message précédent du client.", new Date(receivedAt.getTime() - 86_400_000));
  await message("inbound", "Bonjour,\nJe n'arrive pas à me connecter, j'ai demandé un nouveau code mais rien.\nMerci", receivedAt, messageId);
  await message("outbound", TEAM_REPLY, new Date(receivedAt.getTime() + 600_000));
  let executionThread = threadId;
  if (options.executionThread === "other") {
    executionThread = randomUUID();
    await f.db.insert(savThreads).values({ id: executionThread, mailboxId, gmailThreadId: `t-${executionThread}`, subject: "Autre", customerEmail: "autre@exemple.invalid" });
  }
  const kinds = options.kinds ?? ["support"];
  await f.db.insert(savIntakeExecutions).values({ messageId, threadId: executionThread, runVersion: 1, policyId, policyHash: "fixture", state: options.state ?? "confirmed",
    ticketId: String(Math.floor(Math.random() * 1e9)), payloadCiphertext: encryptSavPayload({ plan: { decision: { classification: kinds[0], requests: kinds.map((kind, index) => ({ id: `r${index}`, kind })) } } }) });
  return messageId;
}
async function effects() {
  const count = async (table: typeof savCases | typeof savCaseEvents | typeof savCaseEffectExecutions | typeof savIntakeEffects | typeof savActions) => (await f.db.select().from(table)).length;
  return { cases: await count(savCases), events: await count(savCaseEvents), caseEffects: await count(savCaseEffectExecutions), intakeEffects: await count(savIntakeEffects),
    actions: await count(savActions), messages: (await f.db.select().from(savMessages)).length };
}
/** The smart shadow's and the replay's rows (the schema markers of the fixture store are left out). */
const keys = async () => (await f.db.select({ key: savSyncState.key, status: savSyncState.status, cursor: savSyncState.cursor }).from(savSyncState)
  .where(like(savSyncState.key, "sav-v2-smart-shadow%"))).sort((a, b) => a.key.localeCompare(b.key));
let fetches: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-replay-fixture-key-32-chars!!!!!");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-replay-admin", email: "replay-admin@exemple.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@exemple.invalid" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-replay-fixture-key-32-chars!!!!!");
  fetches = vi.fn(async () => { throw Error("GLOBAL_NETWORK_FORBIDDEN"); });
  vi.stubGlobal("fetch", fetches);
  state.db = f.db;
  await f.db.delete(savSyncState).where(like(savSyncState.key, "sav-v2-smart-shadow%"));
  await f.db.delete(savIntakeExecutions);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("interrupteur", () => {
  it("identifiant absent ou invalide : 0 lecture (aucune base), 0 appel", async () => {
    state.db = null;
    const net = network();
    for (const value of [undefined, "", "abc", "V20-REPLAY", "v20_replay_x", "v20 replay", "a".repeat(41), "v20-replay\n"]) {
      const env: Record<string, string> = { ...ENV() };
      if (value === undefined) delete env.SAV_V2_SMART_SHADOW_REPLAY; else env.SAV_V2_SMART_SHADOW_REPLAY = value;
      expect(await replay(env, net)).toEqual({ skipped: "off" });
    }
    expect(net.calls).toEqual([]);
    expect(fetches).not.toHaveBeenCalled();
  });
  it("fenêtre et bornes invalides refusées sans rien lire ; plafonds absolus 10 000 000 µUSD, 100 mails, lot de 20", async () => {
    state.db = null;
    const cases: Array<[Record<string, string>, string]> = [
      [{ SAV_V2_SMART_SHADOW_REPLAY_FROM: "" }, "window_invalid"], [{ SAV_V2_SMART_SHADOW_REPLAY_UNTIL: "maintenant" }, "window_invalid"],
      [{ SAV_V2_SMART_SHADOW_REPLAY_UNTIL: FROM }, "window_invalid"], [{ SAV_V2_SMART_SHADOW_REPLAY_UNTIL: "2026-12-01T00:00:01Z" }, "window_invalid"],
      [{ SAV_V2_SMART_SHADOW_REPLAY_MAX_MICRO_USD: "10000001" }, "cap_invalid"], [{ SAV_V2_SMART_SHADOW_REPLAY_MAX_MAILS: "101" }, "mails_invalid"],
      [{ SAV_V2_SMART_SHADOW_REPLAY_MAX_MAILS: "0" }, "mails_invalid"], [{ SAV_V2_SMART_SHADOW_REPLAY_BATCH: "21" }, "batch_invalid"],
    ];
    for (const [extra, reason] of cases) expect(await replay(ENV(extra), network())).toEqual({ skipped: "refused", reason });
    expect(readSmartReplayConfig(ENV())).toMatchObject({ mode: "replay", runId: RUN, capMicroUsd: 10_000_000, maxMails: 60, batch: 10 });
    expect(readSmartReplayConfig(ENV({ SAV_V2_SMART_SHADOW_REPLAY_UNTIL: "2026-12-01T00:00:00Z" }))).toMatchObject({ mode: "replay" });
  });
  it("la passe de rapprochement ne charge le module que sur un identifiant valide (même motif), après le shadow, et n'expose rien sinon", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../reconcile-pass.ts"), "utf8");
    const guard = `/${SAV_SMART_REPLAY_ID.source}/.test(process.env.SAV_V2_SMART_SHADOW_REPLAY ?? "") ? await runStep("v2_smart_shadow_replay"`;
    expect(source).toContain(guard);
    expect(source.indexOf(guard)).toBeGreaterThan(source.indexOf('await runStep("v2_smart_shadow"'));
    expect(source).toContain('if (Date.now() + 90_000 > derivedDeadline) return { skipped: "deadline" };\n    const { runSmartReplayPass }');
    expect(source).toContain("...(smartShadowReplay ? { smartShadowReplay } : {})");
    expect(source.match(/smart-shadow-replay/g)).toHaveLength(1);
  });
});

describe("sélection : celle du shadow, sur la fenêtre de réception", () => {
  it("mêmes mails que le shadow (mail V1 fini, entrant, avec ticket), bornés à [FROM, UNTIL) et sans la limite de 24 h", async () => {
    const recent = await v1Mail(), team = await v1Mail({ kinds: ["finance"] }), other = await v1Mail({ executionThread: "other" });
    await v1Mail({ state: "running" });
    const old = await v1Mail({ receivedAt: new Date("2026-11-24T02:00:00.000Z") });
    await v1Mail({ receivedAt: new Date("2026-11-23T23:59:59.000Z") });
    await v1Mail({ receivedAt: new Date("2026-11-25T10:00:00.000Z") });
    const replayIds = (await selectSmartReplayCandidates({ runId: RUN, from: new Date(FROM), until: new Date(UNTIL), limit: 50 })).map(row => row.messageId);
    const shadowIds = (await selectSmartShadowCandidates({ since: new Date(FROM), limit: 50 })).map(row => row.messageId);
    expect(new Set(replayIds)).toEqual(new Set([old, recent, team, other]));
    expect(replayIds[0]).toBe(old);
    // The shadow, given the same lower bound, takes the same mails in the same order, plus the one received at UNTIL (outside the half-open window).
    expect(shadowIds.slice(0, replayIds.length)).toEqual(replayIds);
    expect(shadowIds).toHaveLength(replayIds.length + 1);
  });
});

describe("rejeu : 0 effet, shadow intact, une seule fois par mail", () => {
  it("un mail support : rejoué une fois, 0 dossier, 0 effet, 0 envoi, la réponse de l'équipe jamais lue ; clés distinctes ; le shadow et son registre intacts", async () => {
    const id = await v1Mail(), before = await effects(), net = network();
    await f.db.insert(savSyncState).values({ key: `${SAV_SMART_SHADOW_PREFIX}:item:mail:${id}`, status: "done", startedAt: new Date("2026-11-25T09:30:00.000Z"),
      cursor: encryptSavPayload({ version: 1, scope: "2026-11-25", reservedMicroUsd: 10, costMicroUsd: 4, result: null }) });
    const shadowBefore = (await keys()).filter(row => row.key.startsWith(`${SAV_SMART_SHADOW_PREFIX}:`));
    const first = await replay(ENV(), net);
    expect(first).toMatchObject({ ran: 1, outcomes: { reply: 1 }, runMails: 1 });
    expect(await replay(ENV(), net)).toMatchObject({ ran: 0, stoppedBy: "no_mail", runMails: 1 });
    expect(net.calls.map(call => call.kind)).toEqual(["understand", "embed", "decide", "verify"]);
    expect(await effects()).toEqual(before);
    expect(fetches).not.toHaveBeenCalled();
    const sent = JSON.stringify(net.calls.map(call => call.payload));
    expect(sent).toContain("Message précédent du client.");
    expect(sent).not.toContain("APRÈS le mail");
    const all = await keys();
    expect(all.filter(row => row.key.startsWith(`${SAV_SMART_SHADOW_PREFIX}:`))).toEqual(shadowBefore);
    expect(all.filter(row => !row.key.startsWith(`${SAV_SMART_SHADOW_PREFIX}:`)).map(row => row.key)).toEqual([`${smartReplayPrefix(RUN)}:item:mail:${id}`, `${smartReplayPrefix(RUN)}:ledger:${RUN}`]);
    expect(await readSmartLedger(SAV_SMART_SHADOW_PREFIX, "2026-11-25")).toMatchObject({ items: 0, settledMicroUsd: 0 });
    expect(await readSmartLedger(smartReplayPrefix(RUN), RUN)).toMatchObject({ items: 1, open: {}, settledMicroUsd: 4 });
  });
  it("un autre identifiant de run rejoue le même mail avec son propre registre", async () => {
    await v1Mail();
    const net = network();
    await replay(ENV(), net);
    expect(await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY: "v20-replay-other" }), net)).toMatchObject({ ran: 1, runMails: 1 });
    expect(net.calls.filter(call => call.kind === "understand")).toHaveLength(2);
    expect(await readSmartLedger(smartReplayPrefix(RUN), RUN)).toMatchObject({ items: 1 });
  });
  it("porte V1 : un mail « finance » ne coûte rien, compté une fois, sous le préfixe du run", async () => {
    const id = await v1Mail({ kinds: ["finance"] }), net = network();
    expect(await replay(ENV(), net)).toMatchObject({ ran: 0, discardedByV1: { finance: 1 }, runMails: 0, spentRunMicroUsd: 0 });
    expect(await replay(ENV(), net)).toMatchObject({ ran: 0, stoppedBy: "no_mail", discardedByV1: {} });
    expect(net.calls).toEqual([]);
    expect((await keys()).map(row => row.key)).toEqual([`${smartReplayPrefix(RUN)}:gate:mail:${id}`]);
  });
  it("à court de temps pendant un mail : « interrupted », définitif, jamais rejoué", async () => {
    await v1Mail();
    let t = 1_000_000;
    expect(await replay(ENV(), network(), { clock: () => t, deadlineMs: t + 89_000 })).toEqual({ skipped: "deadline" });
    const net = network({ onCall: kind => { if (kind === "understand") t += 95_000; } });
    expect(await replay(ENV(), net, { clock: () => t, deadlineMs: t + 100_000 })).toMatchObject({ ran: 1, stoppedBy: "deadline", outcomes: { interrupted: 1 } });
    t += 1_000_000;
    expect(await replay(ENV(), net, { clock: () => t, deadlineMs: t + 200_000 })).toMatchObject({ ran: 0, stoppedBy: "no_mail" });
    expect(net.calls.map(call => call.kind)).toEqual(["understand"]);
  });
  it("fenêtre partie à la rétention (plus de 29 jours) : arrêt avant toute sélection", async () => {
    await v1Mail();
    const net = network();
    expect(await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY_FROM: "2026-10-26T00:00:00Z", SAV_V2_SMART_SHADOW_REPLAY_UNTIL: "2026-10-27T00:00:00Z" }), net)).toEqual({ skipped: "window_expired" });
    expect(net.calls).toEqual([]);
  });
});

describe("plafonds du run", () => {
  it("argent : le pire cas d'un mail ne tient pas, arrêt avant tout appel", async () => {
    await v1Mail();
    const net = network();
    expect(await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY_MAX_MICRO_USD: "5" }), net)).toMatchObject({ ran: 0, stoppedBy: "money_cap" });
    expect(net.calls).toEqual([]);
  });
  it("mails : plafond atteint, la passe suivante ne lit plus aucun mail ; lot par passe respecté", async () => {
    await v1Mail(); await v1Mail(); await v1Mail();
    const net = network();
    expect(await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY_BATCH: "1" }), net)).toMatchObject({ ran: 1, stoppedBy: "batch" });
    expect(await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY_MAX_MAILS: "2" }), net)).toMatchObject({ ran: 1, stoppedBy: "item_cap", runMails: 2 });
    const later = await replay(ENV({ SAV_V2_SMART_SHADOW_REPLAY_MAX_MAILS: "2" }), net);
    expect(later).toMatchObject({ ran: 0, stoppedBy: "item_cap", runMails: 2 });
    expect(net.calls.filter(call => call.kind === "understand")).toHaveLength(2);
  });
});

describe("rapport du rejeu", () => {
  it("v19 (shadow normal) à côté de v20 (rejeu), transitions, et les textes : réponse proposée et note", async () => {
    const id = await v1Mail({ receivedAt: new Date(AT.getTime() - 7_200_000) }), absent = await v1Mail();
    await runSmartShadowPass({ env: () => ({ ...ENV(), SAV_V2_SMART_AGENT: "shadow", SAV_V2_SMART_SHADOW_BATCH: "1" }), now: () => AT, network: network().fn, knowledge, log: () => undefined });
    await replay(ENV(), network());
    const report = await readSmartReplayReport({ replayId: RUN });
    expect(report.run).toMatchObject({ mailsClaimed: 2, openReservations: 0 });
    expect(report.summary).toMatchObject({ mails: 2, outcomesV20: { reply: 2 }, outcomesV19: { reply: 1, absent: 1 }, transitions: { "reply->reply": 1, "absent->reply": 1 } });
    const line = report.cases.find(row => row.messageId === id)!, other = report.cases.find(row => row.messageId === absent)!;
    expect(line.v19).toMatchObject({ status: "done", outcome: "reply" });
    expect(line.v20).toMatchObject({ outcome: "reply", texts: { replyRefused: null, teamNote: null } });
    expect(line.v20.texts.replyProposed).toContain("Charly");
    expect(other.v19).toEqual({ status: "absent", v1GateReason: null });
    expect(line.threadId).toEqual(expect.any(String));
    expect(await readSmartReplayReport({ replayId: RUN, limit: 1 })).toMatchObject({ casesTotal: 2, nextOffset: 1 });
    expect(await readSmartReplayReport({ replayId: "v20-replay-unknown" })).toMatchObject({ summary: { mails: 0 }, cases: [], run: { mailsClaimed: 0 } });
  });
  it("textes : une réponse refusée (transfert) est rendue à part, jamais comme réponse proposée", () => {
    const row = { turn: { replyWithFooter: null, decision: { reply: "Brouillon refusé" }, teamNoteText: "Note pour l'équipe" } } as never;
    expect(smartReplayTexts(row)).toEqual({ replyProposed: null, replyRefused: "Brouillon refusé", teamNote: "Note pour l'équipe" });
  });
  it("aucune clé du rejeu ne tombe sous le préfixe du shadow (ni sous sa rétention)", () => {
    expect(`${SAV_SMART_REPLAY_BASE}:x`.startsWith(`${SAV_SMART_SHADOW_PREFIX}:`)).toBe(false);
    expect(smartReplayPrefix(RUN).startsWith(`${SAV_SMART_SHADOW_PREFIX}:`)).toBe(false);
  });
});
