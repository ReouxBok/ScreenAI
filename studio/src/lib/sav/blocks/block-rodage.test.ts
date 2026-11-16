import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savCases, savCaseEvents, savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { emptyCaseBody, SAV_CASE_ADMISSION_REVISION, SAV_CASE_CONTRACT_REVISION, type CaseAdmissionRecord } from "../cases/case-types";
import { caseInvestigationObservationRecord } from "../cases/investigation-record";
import { type CaseInvestigationProgress } from "../cases/investigation-runner";
const state = vi.hoisted(() => ({ authorized: true, db: null as unknown, calls: 0, writes: [] as unknown[] }));
vi.mock("@/db", () => ({ requireDb: () => { state.calls++; return state.db; } }));
vi.mock("../intake/execution-policy", () => ({ executionAdministrator: async () => {
  if (!state.authorized) throw Error("UNAUTHORIZED");
  return { email: "synthetic-admin@example.invalid" };
} }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw Error(`REDIRECT:${url}`); } }));
import { exportRodageMarkdown, projectRodageCase, readRodageReport, rodageGoNoGo, rodageKey, rodageWindowSchema, saveRodageVerdict, type RodageCase, type RodageReport } from "./block-rodage";
import Page from "@/app/studio/sav/blocs/rodage/page";
import { saveRodageVerdictAction } from "@/app/studio/sav/blocs/rodage/actions";

const caseId = "10000000-0000-4000-8000-000000000001", eventId = "20000000-0000-4000-8000-000000000001";
const from = "2026-11-16T08:00:00.000Z", to = "2026-11-16T20:00:00.000Z";
const window = { blockId: "access", from, to };
const raw = "TEXTE CLIENT SYNTHÉTIQUE À NE PAS EXPORTER";
const proposal = { caseVersion: 1, understanding: { requests: [{ id: "r0", summary: raw, family: "access", status: "open" }], newFacts: [] }, nextAction: { kind: "answer", requestIds: ["r0"], steps: [{ text: "Étape synthétique", knowledge: { knowledgeId: caseId, contentVersionId: eventId }, newFactIds: [] }], expectedResult: "Résultat synthétique" }, reply: { text: `Réponse synthétique avec citation ${raw}`, citations: [{ knowledgeId: caseId, contentVersionId: eventId }], impossibilityClaims: [], accountAdvice: "none" } };
const progress = (): CaseInvestigationProgress => ({ modelCalls: 1, attempts: [{ call: 1, result: "validated", outcome: "accepted", kinds: [], codes: [] }], waiting: null, proposal: { output: proposal, proposedOn: 1 }, last: null, closure: null, recordedOn: null });
const record = () => caseInvestigationObservationRecord("in:synthetic", progress(), null);
const admission = (): CaseAdmissionRecord => ({ revision: SAV_CASE_ADMISSION_REVISION, target: "agent", reasons: ["admitted"], nextStep: "none", families: ["access"], sensitivity: "none", policyRevision: "synthetic-policy", decidedAt: from, version: 1, inputVersion: 1,
  qualification: { requests: [{ requestId: "r0", family: "access", provenance: { kind: "qualified_rule", ruleId: "synthetic-rule", revision: "v1", at: from, blockId: "access" } }], identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] } });
const journal = () => [{ id: eventId, kind: "observation_recorded", caseVersion: 2, direction: "internal", occurredAt: new Date("2026-11-16T10:00:00Z"), detail: { applied: true, record: record() } }];
const item = (): RodageCase => projectRodageCase(caseId, admission(), journal(), "access")!;
const report = (count = 10): RodageReport => ({ ...window, incomplete: false, cases: Array.from({ length: count }, () => item()) });
const good = (c: RodageCase) => { c.verdict = { blockId: "access", caseId: c.caseId, draftId: c.draftId!, revision: "sav-block-rodage.v1", actor: "synthetic-admin@example.invalid", at: from, verdict: "bon", category: null, reason: "" }; return c; };
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
beforeAll(async () => {
  fixture = await createSavTestDb();
  state.db = new Proxy(fixture.db, { get(target, key) {
    if (key === "transaction") return (fn: (tx: unknown) => Promise<unknown>) => target.transaction(tx => fn(new Proxy(tx, { get(t, method) {
      if (["update", "delete"].includes(String(method))) throw Error("FORBIDDEN_WRITE");
      if (method === "insert") return (table: unknown) => { if (table !== savSyncState && table !== auditLogs) throw Error("FORBIDDEN_TABLE"); state.writes.push(table); return t.insert(table as typeof savSyncState); };
      const value = Reflect.get(t, method); return typeof value === "function" ? value.bind(t) : value;
    } })));
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
}, 60_000);
afterAll(async () => { await fixture?.client.close(); });
beforeEach(async () => {
  state.authorized = true; state.calls = 0; state.writes = [];
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-rodage-encryption-key-only");
  await fixture.db.delete(savSyncState); await fixture.db.delete(auditLogs);
});
async function seed() {
  await fixture.db.insert(savCases).values({ id: caseId, ticketId: "98920001", owner: "agent", phase: "queued", sensitivity: "none", contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload(emptyCaseBody()), admissionCiphertext: encryptSavPayload(admission()), admissionTarget: "agent", admissionDecidedAt: new Date(from), createdAt: new Date(from), updatedAt: new Date(from) }).onConflictDoNothing();
  await fixture.db.insert(savCaseEvents).values({ id: eventId, caseId, kind: "observation_recorded", dedupeKey: "observation:synthetic", caseVersion: 2, direction: "internal", occurredAt: journal()[0].occurredAt, payloadCiphertext: encryptSavPayload({ detail: journal()[0].detail }) }).onConflictDoNothing();
}
it("GO at exactly ten drafts and 90%; fewer drafts, missing judgments, defects and truncation fail closed", () => {
  let r = report(9); r.cases.forEach(good); expect(rodageGoNoGo(r).result).toBe("pas assez de volume");
  r = report(); r.cases.slice(0, 9).forEach(good); expect(rodageGoNoGo(r)).toMatchObject({ result: "prêt pour auto", drafts: 10, good: 9, goodRatio: 0.9 });
  r.cases[0].verdict = null; expect(rodageGoNoGo(r).result).toBe("corriger puis recommencer");
  r.cases.forEach(good); r.cases[0].sensitiveMissed = true; expect(rodageGoNoGo(r).result).toBe("corriger puis recommencer");
  r.cases[0].sensitiveMissed = false; r.cases[0].verdict!.verdict = "hors périmètre";
  expect(rodageGoNoGo(r)).toMatchObject({ result: "corriger puis recommencer", outOfBlock: 1 });
  r.cases.forEach(good); r.incomplete = true; expect(rodageGoNoGo(r).result).toBe("corriger puis recommencer");
});
it("all correction categories are counted; sensitive and out-of-block defects veto GO even at 90%", () => {
  for (const category of ["mauvaise fiche", "mauvais ton", "mauvaise question", "hors bloc", "sensible raté"] as const) {
    const r = report(); r.cases.forEach(good); Object.assign(r.cases[0].verdict!, { verdict: "à corriger", category, reason: "Raison synthétique" });
    expect(rodageGoNoGo(r).result).toBe(["hors bloc", "sensible raté"].includes(category) ? "corriger puis recommencer" : "prêt pour auto");
  }
});
it("bounds the window to 24 hours and rejects invalid, reversed and empty dates", () => {
  expect(rodageWindowSchema.parse({ ...window, to: "2026-11-17T08:00:00.000Z" })).toBeTruthy();
  for (const invalid of [{ ...window, to: from }, { ...window, from: to, to: from }, { ...window, to: "2026-11-17T08:00:00.001Z" }, { ...window, from: "invalid" }]) expect(rodageWindowSchema.safeParse(invalid).success).toBe(false);
});
it("guards page, action, reader and writer before database access", async () => {
  state.authorized = false;
  for (const run of [() => Page({ searchParams: Promise.resolve({}) }), () => saveRodageVerdictAction(new FormData()), () => readRodageReport(window), () => saveRodageVerdict({}, window)]) await expect(run()).rejects.toThrow("UNAUTHORIZED");
  expect(state.calls).toBe(0); expect(state.writes).toEqual([]);
});
it("projects the proposed action, cited versions and subsequent human/customer activity, without raw request text", () => {
  const events = [...journal(), { ...journal()[0], id: "human", kind: "outbound_observed", direction: "human_outbound", caseVersion: 3 }, { ...journal()[0], id: "client", kind: "inbound_confirmed", direction: "customer_inbound", caseVersion: 4 }];
  const c = projectRodageCase(caseId, admission(), events, "access")!;
  expect(c).toMatchObject({ action: "répondre", afterwards: ["un humain a répondu", "le client a répondu"], citations: proposal.reply.citations });
  expect(c.summary).not.toContain(raw); expect(c.responseText).toContain(raw);
  expect(projectRodageCase(caseId, admission(), events, "another-block")).toBeNull();
});
it("exports only structural summaries and categories, omitting raw client text, reply, rejection detail and human reason", () => {
  const r = report(1); good(r.cases[0]); r.cases[0].summary = raw; r.cases[0].verdict!.reason = raw;
  const markdown = exportRodageMarkdown(r);
  expect(markdown).not.toContain(raw); expect(markdown).toContain(caseId); expect(markdown).toContain(eventId); expect(markdown).toContain("brouillon proposé");
});
it("encrypts verdicts, audits them, and writes only sync_state and auditLogs; dossier and journal remain byte-identical", async () => {
  await seed();
  const before = await fixture.db.select().from(savCases), events = await fixture.db.select().from(savCaseEvents);
  const r = await readRodageReport(window); expect(r.cases).toHaveLength(1); expect(state.writes).toEqual([]);
  await saveRodageVerdict({ blockId: "access", caseId, draftId: r.cases[0].draftId, verdict: "à corriger", category: "mauvaise fiche", reason: raw }, window);
  expect(state.writes).toEqual([savSyncState, auditLogs]);
  const [stored] = await fixture.db.select().from(savSyncState).where(eq(savSyncState.key, rodageKey("access", caseId)));
  expect(stored.cursor).not.toContain(raw); expect(decryptSavPayload(stored.cursor!)).toMatchObject({ verdicts: [expect.objectContaining({ verdict: "à corriger", reason: raw })] });
  const [audit] = await fixture.db.select().from(auditLogs); expect(audit).toMatchObject({ action: "sav_block_rodage_verdict", actorEmail: "synthetic-admin@example.invalid", technicalMetadata: { category: "mauvaise fiche" } });
  expect(JSON.stringify(audit)).not.toContain(raw); expect((await readRodageReport(window)).cases[0].verdict?.reason).toBe(raw);
  expect(await fixture.db.select().from(savCases)).toEqual(before); expect(await fixture.db.select().from(savCaseEvents)).toEqual(events);
});
it("refuses stale/fabricated drafts, another block and corrections without reasons without writing", async () => {
  await seed();
  for (const input of [{ blockId: "access", caseId, draftId: "0".repeat(64), verdict: "bon", category: null, reason: "" }, { blockId: "another-block", caseId, draftId: item().draftId, verdict: "bon", category: null, reason: "" }, { blockId: "access", caseId, draftId: item().draftId, verdict: "à corriger", category: "mauvaise fiche", reason: "" }]) await expect(saveRodageVerdict(input, window)).rejects.toThrow();
  expect(state.writes).toEqual([]);
});
it("reads no events outside the window and never reuses a verdict for a different draft", async () => {
  await seed();
  const r = await readRodageReport({ ...window, to: "2026-11-16T09:00:00.000Z" }); expect(r.cases).toEqual([]);
  await fixture.db.insert(savSyncState).values({ key: rodageKey("access", caseId), cursor: encryptSavPayload({ revision: "sav-block-rodage.v1", blockId: "access", caseId, verdicts: [{ ...good(item()).verdict!, draftId: "0".repeat(64) }] }) });
  expect((await readRodageReport(window)).cases[0].verdict).toBeNull();
});
it("uses server actions and the admin boundary, with no activation or API transport", () => {
  const page = readFileSync(new URL("../../../app/studio/sav/blocs/rodage/page.tsx", import.meta.url), "utf8");
  expect(page).toContain("await rodageAdministrator()"); expect(page).toContain("action={saveRodageVerdictAction}");
  expect(page).not.toMatch(/use client|fetch\(|\/api\/|setSavBlockSwitch/);
});
it("ignores foreign observations without hiding a draft; unreadable investigation records veto GO", () => {
  const foreign = { ...journal()[0], id: "foreign", caseVersion: 3, detail: { applied: true, record: { kind: "another-tool" } } };
  expect(projectRodageCase(caseId, admission(), [...journal(), foreign], "access")?.draftId).toBe(item().draftId);
  const broken = { ...journal()[0], caseVersion: 4, detail: { record: { kind: "sav-case-investigation.v1" } } };
  const r = report(); r.cases.forEach(good); r.cases.push(projectRodageCase(caseId, admission(), [broken], "access")!);
  expect(rodageGoNoGo(r).result).toBe("corriger puis recommencer");
});
it("reviews every distinct draft of one case, deduplicates resumptions and preserves earlier encrypted judgments", async () => {
  await seed();
  const first = (await readRodageReport(window)).cases[0];
  await saveRodageVerdict({ blockId: "access", caseId, draftId: first.draftId, verdict: "bon", category: null, reason: "" }, window);
  const secondProgress = progress(); secondProgress.proposal = { output: { ...proposal, reply: { ...proposal.reply, text: "Deuxième réponse synthétique" } }, proposedOn: 3 };
  const secondRecord = caseInvestigationObservationRecord("in:synthetic", secondProgress, null);
  for (const version of [3, 4]) await fixture.db.insert(savCaseEvents).values({ caseId, kind: "observation_recorded", dedupeKey: `observation:synthetic-${version}`, caseVersion: version, direction: "internal", occurredAt: new Date("2026-11-16T11:00:00Z"), payloadCiphertext: encryptSavPayload({ detail: { record: secondRecord } }) });
  const r = await readRodageReport(window);
  expect(r.cases).toHaveLength(2); expect(rodageGoNoGo(r)).toMatchObject({ admitted: 1, drafts: 2, good: 1 });
  const second = r.cases.find(c => c.draftId !== first.draftId)!;
  await saveRodageVerdict({ blockId: "access", caseId, draftId: second.draftId, verdict: "à corriger", category: "mauvais ton", reason: "Raison synthétique" }, window);
  expect((await readRodageReport(window)).cases.map(c => c.verdict?.verdict)).toEqual(["bon", "à corriger"]);
  const [stored] = await fixture.db.select().from(savSyncState); expect(decryptSavPayload<{ verdicts: unknown[] }>(stored.cursor!).verdicts).toHaveLength(2);
});

it("never issues GO for a window whose admission was overwritten afterwards", async () => {
  await seed();
  await fixture.db.update(savCases).set({ admissionDecidedAt: new Date("2026-11-17T08:00:00Z") }).where(eq(savCases.id, caseId));
  const r = await readRodageReport(window); expect(r.incomplete).toBe(true);
  expect(rodageGoNoGo(r).result).toBe("corriger puis recommencer");
});
