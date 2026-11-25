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
import { SAV_SMART_COMMERCIAL_PROMPT_SHA256, SAV_SMART_PROMPT_SHA256 } from "./smart-prompt";
import { aggregateSmartShadow, readSmartShadowGates, readSmartShadowRows, runSmartShadowPass, SAV_SMART_SHADOW_PREFIX, smartShadowItem, smartV1Gate, type SmartShadowStored } from "./smart-shadow";
import { SMART_CONFORME, SMART_TEST_CARD, smartGoodDecision, smartReading } from "./smart-test-doubles";

/*
 * Agent SAV intelligent, lot E (20/11): the shadow pass on the real store (PGlite), the model doubled at the network boundary (the only host
 * allowed), FICTIONAL mails. Proves: off = 0 read; on = 0 effect, one payment per mail across two passes (also overlapping), the caps, the time.
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "";
const AT = new Date("2026-11-20T10:00:00.000Z"), DAY = "2026-11-20";
const ENV = (extra: Record<string, string> = {}) => ({ ...ACCESS_SKILL_TEST_PROVIDER_ENV, SAV_V2_SMART_AGENT: "shadow", ...extra });
const TEAM_REPLY = "Réponse de l'équipe écrite APRÈS le mail : ne doit jamais être lue.";

type Kind = "understand" | "decide" | "verify" | "embed";
function network(options: { onCall?: (kind: Kind) => void; decide?: unknown } = {}) {
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
    const output = kind === "understand" ? smartReading() : kind === "verify" ? SMART_CONFORME : { thinking: "", action: "final", calls: [], decision: options.decide ?? smartGoodDecision() };
    return Response.json(accessSkillWireAnswer(output, { inputTokens: 1_000, outputTokens: 200 }));
  };
  return { fn, calls };
}
/** The knowledge port of the test: it pays its one embedding through the shadow's port, then returns the fictional card. */
const knowledge = (embed: SmartEmbedPort): SmartKnowledgePort => async () => {
  const embedded = await embed(["connexion code non reçu"]);
  return embedded.status === "ok" ? { status: "ok", sources: [SMART_TEST_CARD], codes: [] } : { status: "unavailable", sources: [], codes: [embedded.problem] };
};
const pass = (env: Record<string, string>, net: ReturnType<typeof network>, extra: Partial<Parameters<typeof runSmartShadowPass>[0]> = {}) =>
  runSmartShadowPass({ env: () => env, now: () => AT, network: net.fn, knowledge, log: () => undefined, ...extra });

async function v1Mail(options: { body?: string; executionThread?: "same" | "other"; receivedAt?: Date; kinds?: string[]; classification?: string; payload?: unknown } = {}) {
  const threadId = randomUUID(), messageId = randomUUID(), receivedAt = options.receivedAt ?? new Date(AT.getTime() - 3_600_000);
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `t-${threadId}`, subject: "Connexion", customerEmail: "client@exemple.invalid" });
  const message = (direction: "inbound" | "outbound", text: string, at: Date, id = randomUUID()) => f.db.insert(savMessages).values({ id, threadId, mailboxId, direction,
    fromEmail: direction === "inbound" ? "client@exemple.invalid" : "support@exemple.invalid", toEmails: [], subject: "Connexion", bodyCiphertext: encryptSavPayload({ text }), receivedAt: at, gmailMessageId: `gm-${id}` });
  await message("inbound", "Message précédent du client.", new Date(receivedAt.getTime() - 86_400_000));
  await message("inbound", options.body ?? "Bonjour,\nJe n'arrive pas à me connecter, j'ai demandé un nouveau code mais rien.\nMerci", receivedAt, messageId);
  await message("outbound", TEAM_REPLY, new Date(receivedAt.getTime() + 600_000));
  let executionThread = threadId;
  if (options.executionThread === "other") {
    executionThread = randomUUID();
    await f.db.insert(savThreads).values({ id: executionThread, mailboxId, gmailThreadId: `t-${executionThread}`, subject: "Autre", customerEmail: "autre@exemple.invalid" });
  }
  await f.db.insert(savIntakeExecutions).values({ messageId, threadId: executionThread, runVersion: 1, policyId, policyHash: "fixture", state: "confirmed", ticketId: String(Math.floor(Math.random() * 1e9)),
    payloadCiphertext: encryptSavPayload(options.payload ?? { plan: { decision: { classification: options.classification ?? options.kinds?.[0] ?? "support", requests: (options.kinds ?? ["support"]).map((kind, index) => ({ id: `r${index}`, kind })) } } }) });
  return messageId;
}
async function effects() {
  const count = async (table: typeof savCases | typeof savCaseEvents | typeof savCaseEffectExecutions | typeof savIntakeEffects | typeof savActions) => (await f.db.select().from(table)).length;
  return { cases: await count(savCases), events: await count(savCaseEvents), caseEffects: await count(savCaseEffectExecutions), intakeEffects: await count(savIntakeEffects),
    actions: await count(savActions), messages: (await f.db.select().from(savMessages)).length };
}
async function clearShadow() { await f.db.delete(savSyncState).where(like(savSyncState.key, `${SAV_SMART_SHADOW_PREFIX}:%`)); await f.db.delete(savIntakeExecutions); }
let fetches: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-shadow-fixture-key-32-chars!!!!");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-smart-admin", email: "smart-admin@exemple.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@exemple.invalid" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-shadow-fixture-key-32-chars!!!!");
  fetches = vi.fn(async () => { throw Error("GLOBAL_NETWORK_FORBIDDEN"); });
  vi.stubGlobal("fetch", fetches);
  state.db = f.db;
  await clearShadow();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("interrupteur", () => {
  it("absent ou toute autre valeur que « shadow » : 0 lecture (aucune base), 0 calcul, 0 paiement", async () => {
    const net = network();
    state.db = null;
    for (const value of [undefined, "", "off", "on", "auto", "SHADOW", "shadow "]) {
      const env = { ...ACCESS_SKILL_TEST_PROVIDER_ENV, ...(value === undefined ? {} : { SAV_V2_SMART_AGENT: value }) };
      expect(await runSmartShadowPass({ env: () => env, now: () => AT, network: net.fn, knowledge })).toEqual({ skipped: "off" });
    }
    expect(net.calls).toEqual([]);
    expect(fetches).not.toHaveBeenCalled();
  });
  it("valeurs invalides refusées sans rien lire ; plafond jamais au-dessus de 10 000 000 µUSD par jour", async () => {
    state.db = null;
    for (const [name, value, reason] of [["SAV_V2_SMART_SHADOW_MAX_MICRO_USD_PER_DAY", "10000001", "cap_invalid"], ["SAV_V2_SMART_SHADOW_MAX_MAILS_PER_DAY", "0", "mails_invalid"],
      ["SAV_V2_SMART_SHADOW_BATCH", "11", "batch_invalid"], ["SAV_V2_SMART_SHADOW_SINCE", "hier", "since_invalid"]] as const)
      expect(await pass(ENV({ [name]: value }), network())).toEqual({ skipped: "refused", reason });
  });
  it("le pas de rapprochement ne charge le module que sur « shadow », et n'expose rien sinon", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../reconcile-pass.ts"), "utf8");
    expect(source).toContain('process.env.SAV_V2_SMART_AGENT === "shadow" ? await runStep("v2_smart_shadow"');
    expect(source).toContain('if (Date.now() + 90_000 > derivedDeadline) return { skipped: "deadline" };\n    const { runSmartShadowPass }');
    expect(source).toContain("...(smartShadow ? { smartShadow } : {})");
  });
});

describe("allumé : 0 effet, un seul paiement par mail", () => {
  it("deux passes sur le même mail : 1 seul paiement, 0 dossier, 0 effet, 0 envoi ; la réponse de l'équipe postérieure n'est jamais lue", async () => {
    const id = await v1Mail(), before = await effects(), net = network();
    const first = await pass(ENV(), net);
    expect(first).toMatchObject({ ran: 1, outcomes: { reply: 1 } });
    const second = await pass(ENV(), net);
    expect(second).toMatchObject({ ran: 0, stoppedBy: "no_mail" });
    expect(net.calls.map(call => call.kind)).toEqual(["understand", "embed", "decide", "verify"]);
    expect(await effects()).toEqual(before);
    expect(fetches).not.toHaveBeenCalled();
    const sent = JSON.stringify(net.calls.map(call => call.payload));
    expect(sent).toContain("Message précédent du client.");
    expect(sent).not.toContain("APRÈS le mail");
    const ledger = await readSmartLedger(SAV_SMART_SHADOW_PREFIX, DAY);
    expect(ledger).toMatchObject({ items: 1, open: {} });
    expect(ledger.settledMicroUsd).toBe(4);
    const [row] = await readSmartShadowRows();
    expect(row).toMatchObject({ messageId: id, costMicroUsd: 4, turn: { outcome: "reply" } });
    expect(row!.turn.replyWithFooter).toContain("Charly");
  });
  it("deux passes qui se chevauchent : un seul paie le mail", async () => {
    await v1Mail();
    const net = network();
    const [a, b] = await Promise.all([pass(ENV(), net), pass(ENV(), net)]);
    expect([a, b].map(result => "ran" in result ? result.ran : -1).sort()).toEqual([0, 1]);
    expect(net.calls.filter(call => call.kind === "understand")).toHaveLength(1);
    expect((await readSmartLedger(SAV_SMART_SHADOW_PREFIX, DAY)).items).toBe(1);
  });
  it("un mail lu sur un autre fil que celui de V1 n'est ni payé ni réservé", async () => {
    await v1Mail({ executionThread: "other" });
    const net = network(), result = await pass(ENV(), net);
    expect(result).toMatchObject({ ran: 0, skippedMails: { thread_mismatch: 1 } });
    expect(net.calls).toEqual([]);
    expect((await readSmartLedger(SAV_SMART_SHADOW_PREFIX, DAY)).items).toBe(0);
  });
  it("un mail plus vieux que 24 h n'est pas pris", async () => {
    await v1Mail({ receivedAt: new Date(AT.getTime() - 25 * 3_600_000) });
    expect(await pass(ENV(), network())).toMatchObject({ ran: 0, stoppedBy: "no_mail" });
  });
  it("mail trop long pour être lu en entier : arrêté par le filet (arrêt technique, N2), 0 appel payé, ligne rangée « team_sensitive »", async () => {
    await v1Mail({ body: `Bonjour, souci de connexion.\n${"détail ".repeat(1_200)}` });
    const net = network(), result = await pass(ENV(), net);
    expect(result).toMatchObject({ ran: 1, outcomes: { team_sensitive: 1 } });
    expect(net.calls).toEqual([]);
    const [row] = await readSmartShadowRows();
    expect(row).toMatchObject({ costMicroUsd: 0, turn: { outcome: "team_sensitive", sensitiveStop: "net" } });
  });
});

describe("porte V1 (SAV-116) : seul le « support » de V1 va au modèle", () => {
  it("porte pure : support seul passe ; finance et résiliation l'emportent ; sinon la raison est le premier type non support ; illisible = unknown", () => {
    const gate = (classification: string, ...kinds: string[]) => smartV1Gate({ classification, requests: kinds.map(kind => ({ kind })) });
    expect(gate("support", "support")).toEqual({ gate: "support" });
    expect(gate("mixed", "support", "other")).toEqual({ gate: "support" });
    expect(gate("mixed", "support", "cancellation")).toEqual({ gate: "team", reason: "cancellation" });
    expect(gate("mixed", "finance", "cancellation")).toEqual({ gate: "team", reason: "cancellation" });
    expect(gate("finance", "support")).toEqual({ gate: "team", reason: "finance" });
    expect(gate("finance", "finance")).toEqual({ gate: "team", reason: "finance" });
    for (const reason of ["partnership", "commercial", "investor", "other", "unknown"]) expect(gate(reason, reason)).toEqual({ gate: "team", reason });
    expect(gate("acknowledgement", "acknowledgement")).toEqual({ gate: "team", reason: "acknowledgement" });
    expect(gate("support")).toEqual({ gate: "support" });
    expect(gate("mixed")).toEqual({ gate: "team", reason: "unknown" });
    expect(smartV1Gate({})).toEqual({ gate: "team", reason: "unknown" });
    expect(smartV1Gate(null)).toEqual({ gate: "team", reason: "unknown" });
    expect(gate("support", "n'importe quoi")).toEqual({ gate: "team", reason: "unknown" });
  });
  it("mail support : le modèle est appelé, la ligne porte v1Gate « support » et le temps d'un tour", async () => {
    await v1Mail({ kinds: ["support"] });
    const net = network(), result = await pass(ENV(), net);
    expect(result).toMatchObject({ ran: 1, discardedByV1: {} });
    expect(net.calls.length).toBeGreaterThan(0);
    const [row] = await readSmartShadowRows();
    expect(row).toMatchObject({ v1Gate: "support" });
    expect(typeof row!.durationMs).toBe("number");
  });
  it("SAV_V2_SMART_COMMERCIAL_SPLIT : éteint, l'empreinte de la v21 ; « on », les prompts commerciaux et leur empreinte figée", async () => {
    await v1Mail({ kinds: ["support"] });
    const systems: string[] = [], off = network();
    await pass(ENV(), { calls: off.calls, fn: async (url, init) => { systems.push(JSON.parse(String(init.body)).systemInstruction?.parts[0].text ?? ""); return off.fn(url, init); } });
    expect((await readSmartShadowRows())[0]!.promptSha256).toBe(SAV_SMART_PROMPT_SHA256);
    expect(systems.filter(text => text.includes("QUESTION COMMERCIALE"))).toHaveLength(0);
    await clearShadow();
    await v1Mail({ kinds: ["support"] });
    const on = network();
    systems.length = 0;
    await pass(ENV({ SAV_V2_SMART_COMMERCIAL_SPLIT: "on" }), { calls: on.calls, fn: async (url, init) => { systems.push(JSON.parse(String(init.body)).systemInstruction?.parts[0].text ?? ""); return on.fn(url, init); } });
    expect((await readSmartShadowRows())[0]!.promptSha256).toBe(SAV_SMART_COMMERCIAL_PROMPT_SHA256);
    expect(systems.filter(text => text.includes("QUESTION COMMERCIALE"))).toHaveLength(1);
  });
  it("résiliation + support : team/cancellation, aucun appel, ni quota ni argent ; compté une seule fois sur deux passes", async () => {
    await v1Mail({ kinds: ["support", "cancellation"], classification: "mixed" });
    const net = network(), first = await pass(ENV(), net);
    expect(first).toMatchObject({ ran: 0, discardedByV1: { cancellation: 1 } });
    expect(await pass(ENV(), net)).toMatchObject({ ran: 0, stoppedBy: "no_mail", discardedByV1: {} });
    expect(net.calls).toEqual([]);
    expect(await readSmartLedger(SAV_SMART_SHADOW_PREFIX, DAY)).toMatchObject({ items: 0, settledMicroUsd: 0, open: {} });
    expect(await readSmartShadowRows()).toEqual([]);
    expect(await readSmartShadowGates()).toMatchObject([{ gate: "team", reason: "cancellation" }]);
  });
  it("finance seule : team/finance ; décision illisible : team/unknown", async () => {
    await v1Mail({ kinds: ["finance"] });
    await v1Mail({ payload: {} });
    const net = network();
    expect(await pass(ENV(), net)).toMatchObject({ ran: 0, discardedByV1: { finance: 1, unknown: 1 } });
    expect(net.calls).toEqual([]);
  });
  it("le quota de mails par jour ne compte que les mails envoyés au modèle : 3 mails écartés ne le consomment pas", async () => {
    await v1Mail({ kinds: ["finance"] }); await v1Mail({ kinds: ["partnership"] }); await v1Mail({ kinds: ["commercial"] }); await v1Mail({ kinds: ["support"] });
    const net = network(), result = await pass(ENV({ SAV_V2_SMART_SHADOW_MAX_MAILS_PER_DAY: "1" }), net);
    expect(result).toMatchObject({ ran: 1, discardedByV1: { finance: 1, partnership: 1, commercial: 1 } });
    expect((await readSmartLedger(SAV_SMART_SHADOW_PREFIX, DAY)).items).toBe(1);
  });
  it("une ligne ancienne (sans v1Gate) reste lisible : lue comme « unknown », comptée à part, sans casser l'agrégat", async () => {
    await v1Mail({ kinds: ["support"] });
    await pass(ENV(), network());
    const [recent] = await readSmartShadowRows();
    const old: Omit<SmartShadowStored, "v1Gate"> = Object.fromEntries(Object.entries(recent!).filter(([key]) => key !== "v1Gate")) as Omit<SmartShadowStored, "v1Gate">;
    const report = aggregateSmartShadow([old, recent!]);
    expect(report.unknownGate).toEqual({ mails: 1 });
    expect(report.support.mails).toBe(1);
    expect(aggregateSmartShadow([old])).toMatchObject({ support: { mails: 0 }, unknownGate: { mails: 1 } });
  });
  it("agrégat en deux blocs : support (réponses, transferts, coût, p50/p95) et écartés par V1 (nombre par raison)", async () => {
    await v1Mail({ kinds: ["support"] }); await v1Mail({ kinds: ["support"] });
    await v1Mail({ kinds: ["finance"] }); await v1Mail({ kinds: ["finance"] }); await v1Mail({ kinds: ["partnership"] });
    await pass(ENV(), network());
    const report = aggregateSmartShadow(await readSmartShadowRows(), await readSmartShadowGates());
    expect(report).toMatchObject({ support: { mails: 2, outcomes: { reply: 2 } }, discardedByV1: { mails: 3, byReason: { finance: 2, partnership: 1 } }, unknownGate: { mails: 0 } });
    expect(report.support.durationMs).toMatchObject({ count: 2 });
    expect(report.support.durationMs).toHaveProperty("p95");
    expect(report.support.costMicroUsd).toMatchObject({ count: 2, median: expect.any(Number) });
    expect(JSON.stringify(report)).not.toContain(smartShadowItem(""));
  });
});

describe("plafonds et temps", () => {
  it("plafond d'argent : le pire cas d'un mail ne tient pas, arrêt avant tout appel", async () => {
    await v1Mail();
    const net = network(), result = await pass(ENV({ SAV_V2_SMART_SHADOW_MAX_MICRO_USD_PER_DAY: "5" }), net);
    expect(result).toMatchObject({ ran: 0, stoppedBy: "money_cap" });
    expect(net.calls).toEqual([]);
  });
  it("plafond de mails par jour : le deuxième mail attend le lendemain", async () => {
    await v1Mail(); await v1Mail();
    const net = network();
    expect(await pass(ENV({ SAV_V2_SMART_SHADOW_MAX_MAILS_PER_DAY: "1" }), net)).toMatchObject({ ran: 1, stoppedBy: "item_cap" });
    expect(await pass(ENV({ SAV_V2_SMART_SHADOW_MAX_MAILS_PER_DAY: "1" }), net)).toMatchObject({ ran: 0, stoppedBy: "item_cap" });
    expect(net.calls.filter(call => call.kind === "understand")).toHaveLength(1);
  });
  it("moins de 90 s dans la passe : rien ; à court de temps pendant un mail : arrêt propre, dépense réglée, jamais rejoué", async () => {
    await v1Mail();
    let t = 1_000_000;
    expect(await pass(ENV(), network(), { clock: () => t, deadlineMs: t + 89_000 })).toEqual({ skipped: "deadline" });
    const net = network({ onCall: kind => { if (kind === "understand") t += 95_000; } });
    const result = await pass(ENV(), net, { clock: () => t, deadlineMs: t + 100_000 });
    expect(result).toMatchObject({ ran: 1, stoppedBy: "deadline", outcomes: { interrupted: 1 } });
    expect(net.calls.map(call => call.kind)).toEqual(["understand"]);
    const ledger = await readSmartLedger(SAV_SMART_SHADOW_PREFIX, DAY);
    expect(ledger).toMatchObject({ items: 1, open: {}, settledMicroUsd: 1 });
    t += 1_000_000;
    expect(await pass(ENV(), net, { clock: () => t, deadlineMs: t + 200_000 })).toMatchObject({ ran: 0, stoppedBy: "no_mail" });
  });
});

describe("rapport", () => {
  it("agrégats : décisions, refus par motif, sensibles arrêtés, coût, durée, octets, fiches manquantes", async () => {
    await v1Mail(); await v1Mail({ body: `Bonjour, je veux résilier.\n${"détail ".repeat(1_200)}` });
    await pass(ENV(), network({ decide: smartGoodDecision({ reply: "Bonjour,\n\nInscrivez-vous chez Yonos.\n\nBelle journée.", facts: [] }) }));
    const report = aggregateSmartShadow(await readSmartShadowRows()).support;
    expect(report).toMatchObject({ mails: 2, outcomes: { handoff: 1, team_sensitive: 1 }, sensitiveStopped: { net: 1, understand: 0 }, corrected: 1, refusedAfterCorrection: 1 });
    expect(report.serverRefusals.other_platform_recommended).toBe(2);
    expect(report.bytesByStage.decide?.count).toBe(1);
    expect(report).toMatchObject({ tools: { calls: 0, mailsWithTools: 0, decidePasses: { 1: 1 } }, progressHandoffs: 0, withTeamNote: 1 });
    expect(report.costMicroUsd.total).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/Yonos|résilier/);
  });
});

/** The real store, except its transactions: they fail with this Postgres error (a lock held too long, a SQL failure), or record their statements. */
function storeWith(options: { failWith?: string; statements?: string[] }) {
  const db = f.db as unknown as Record<string | symbol, unknown>;
  return new Proxy(db, { get(target, prop) {
    if (prop === "transaction") return async (fn: (tx: unknown) => Promise<unknown>) => {
      if (options.failWith) throw Object.assign(new Error("synthetic failure, message never logged"), { code: options.failWith });
      return f.db.transaction(tx => fn(new Proxy(tx as unknown as Record<string | symbol, unknown>, { get(txTarget, txProp) {
        const value = Reflect.get(txTarget, txProp, txTarget);
        if (txProp === "execute") return (query: unknown) => { options.statements?.push(JSON.stringify(query)); return (value as (q: unknown) => unknown).call(txTarget, query); };
        return typeof value === "function" ? value.bind(txTarget) : value;
      } })));
    };
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

describe("pannes contenues : le cron de prod ne passe jamais en erreur à cause de l'ombre", () => {
  it("erreur SQL à la réservation : résultat codé, rien n'est levé, 0 appel payé, aucun message dans le journal", async () => {
    await v1Mail();
    const logs: unknown[] = [], net = network();
    state.db = storeWith({ failWith: "XX000" });
    const result = await pass(ENV(), net, { log: (event, fields) => logs.push([event, fields]) });
    expect(result).toEqual({ skipped: "error_contained", code: "sql_XX000" });
    expect(net.calls).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain("synthetic failure");
  });
  it("verrou tenu trop longtemps (lock_timeout, 55P03) : sortie propre et codée", async () => {
    await v1Mail();
    state.db = storeWith({ failWith: "55P03" });
    expect(await pass(ENV(), network())).toEqual({ skipped: "error_contained", code: "sql_55P03" });
  });
  it("chaque transaction du registre borne ses attentes : lock_timeout et statement_timeout courts (réserver, régler, relire le registre)", async () => {
    await v1Mail();
    const statements: string[] = [];
    state.db = storeWith({ statements });
    expect(await pass(ENV(), network())).toMatchObject({ ran: 1 });
    expect(statements.filter(text => text.includes("set local lock_timeout = '3000ms'"))).toHaveLength(3);
    expect(statements.filter(text => text.includes("set local statement_timeout = '5000ms'"))).toHaveLength(3);
  });
});
