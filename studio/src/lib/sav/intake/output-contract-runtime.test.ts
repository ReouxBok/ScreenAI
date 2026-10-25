import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savIntakeModelCalls, savActions, savIntakeExecutions } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimeConfig } from "./runtime-contract";
import { enqueueSavIntakeMessage, readSavIntakeBudget, readSavIntakeCurrent } from "./runtime-store";
import { analyseSavIntakeRuntime } from "./runtime";
import { SAV_VISUAL_TRUNCATED_NOTE } from "./output-normalization";

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string, messageId: string, config: IntakeRuntimeConfig, environment: Record<string, string | undefined>;
let bytes: Buffer;
const canary = "FAKE_VISUAL_SECRET_1234567890ABCDEFGH";
function env(mailbox: string) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: "synthetic-intake-runtime-encryption-key", SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
type ImageAnswer = Record<string, unknown>;
const readableImage = (over: ImageAnswer = {}) => ({ index: 0, readability: "readable", text: "Erreur E42", uncertainties: [], regions: [{ text: "Erreur E42", box: null }], ...over });
/** Synthetic Gemini behind the real transport, dispatcher, sanitizer and ledger. */
function provider(images: (attempt: number) => ImageAnswer[], crm: (attempt: number) => Response | Promise<Response> = () => Response.json({ total: 0, results: [] })) {
  const gemini: { system: string }[] = []; let crmCalls = 0;
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      const body = JSON.parse(String(init?.body)), data = JSON.parse(body.contents[0].parts[0].text);
      gemini.push({ system: body.systemInstruction.parts[0].text });
      const answer = { messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId, quoteId: data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id }],
        ticketSummary: { title: "Erreur E42", description: "Le client signale une erreur visible sur la capture.", requestIds: ["r1"] }, images: images(gemini.length) };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 1220, candidatesTokenCount: 200, thoughtsTokenCount: 0, totalTokenCount: 1420 } });
    }
    crmCalls++; return crm(crmCalls);
  });
  return { network, gemini };
}
const deps = (network: typeof fetch) => ({ env: () => environment, network, downloadAttachments: async () => bytes });
const current = () => readSavIntakeCurrent(threadId, config);
const ledger = () => f.db.select().from(savIntakeModelCalls);

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; bytes = await (await import("../../../../test/sav-attachments")).syntheticImage(); }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-intake-runtime-encryption-key");
  await f.client.exec("TRUNCATE sav.intake_effect_journal, sav.intake_effects, sav.intake_occupations, sav.intake_executions, sav.intake_execution_policies, sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid" }).returning(); threadId = thread.id;
  const { attachmentMetadata } = await import("../../../../test/sav-attachments");
  const gmailMessageId = randomUUID(), metadata = attachmentMetadata(bytes.length);
  metadata.reference = { ...metadata.reference!, mailboxEmail: "support@example.invalid", gmailMessageId, gmailThreadId: thread.gmailThreadId };
  // "voir la capture": the image is explicitly needed, so it can never be accessory.
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "synthetic@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Erreur", gmailMessageId, bodyCiphertext: encryptSavPayload({ text: "Ça ne fonctionne pas, voir la capture jointe.", headers: {}, attachments: [metadata], attachmentInventory: { complete: true, limits: [] } }),
    receivedAt: new Date(), createdAt: new Date(), analysisStatus: "pending" }).returning();
  messageId = m.id; environment = env(mailboxId); config = savIntakeRuntimeConfig(environment)!;
});
afterEach(() => vi.unstubAllEnvs());

it("an over-long OCR is kept as a masked partial prefix in one settled call, and blocks any action without evidence", async () => {
  const p = provider(() => [readableImage({ text: `token: ${canary}\n` + "Ligne de log ".repeat(500), regions: Array.from({ length: 10 }, () => ({ text: "zone", box: [0, 0, 2000, 2000] })) })]);
  const id = await enqueueSavIntakeMessage(messageId, config);
  await analyseSavIntakeRuntime(id!, config, deps(p.network));
  expect(p.gemini).toHaveLength(1);
  const rows = await ledger();
  expect(rows).toHaveLength(1); expect(rows[0].state).toBe("settled"); expect(rows[0].resultCiphertext).toBeTruthy();
  expect(JSON.stringify(decryptSavPayload(rows[0].resultCiphertext!))).not.toContain(canary);
  const run = await current(), observation = run!.payload.attachments!.read.observations[0];
  expect(observation).toMatchObject({ status: "partial", reason: "partial_content" });
  expect(observation.text.length).toBeLessThanOrEqual(4000); expect(observation.regions).toHaveLength(8);
  expect(observation.regions.every(r => r.box === null)).toBe(true);
  expect(observation.uncertainties[0]).toBe(SAV_VISUAL_TRUNCATED_NOTE);
  // A required image that is only partial never becomes evidence for an action.
  expect(run!.payload.plan?.decision.disposition).toMatchObject({ kind: "collect_context", reasons: expect.arrayContaining(["classification_incomplete"]) });
  expect(run!.payload.plan?.decision.evidence.some(e => e.source === "current_attachment")).toBe(false);
  expect(run!.payload.traces).toEqual(expect.arrayContaining([expect.objectContaining({ phase: "understanding", accepted: true,
    normalization: expect.objectContaining({ partialImages: 1, truncatedImageTexts: 1, droppedRegions: 2, invalidBoxes: 8 }) })]));
  expect(JSON.stringify(run!.payload)).not.toContain(canary);
  expect(await f.db.select().from(savActions)).toHaveLength(0); expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(0);
});

it("a structural visual error is repaired by exactly one distinct, budgeted call (PR176 second attempt), then bounded", async () => {
  const p = provider(n => n === 1 ? [readableImage(), readableImage({ index: 1 })] : [readableImage()]);
  const id = await enqueueSavIntakeMessage(messageId, config);
  await analyseSavIntakeRuntime(id!, config, deps(p.network));
  // Attempt 1 is rejected locally (one image, two observations); attempt 2 carries the repair instruction.
  expect(p.gemini).toHaveLength(2);
  expect(p.gemini[0].system).not.toContain("FORMAT REPAIR"); expect(p.gemini[1].system).toContain("FORMAT REPAIR");
  const run = await current();
  expect(run!.payload.reason).not.toBe("SAV_INTAKE_MODEL_OUTPUT_REJECTED");
  expect(run!.payload.attachments!.read.observations[0].status).toBe("analyzed");
  expect((await ledger()).map(r => r.state)).toEqual(["settled", "settled"]);
  expect((await readSavIntakeBudget(config)).callCount).toBe(2);
  // Two attempts are the bound: no third call, no reset.
  await analyseSavIntakeRuntime(id!, config, deps(p.network));
  expect(p.gemini).toHaveLength(2);
});

it("a visual output that stays structurally invalid ends in an explicit, diagnosed wait without any effect", async () => {
  const p = provider(() => [readableImage(), readableImage({ index: 1 })]);
  const id = await enqueueSavIntakeMessage(messageId, config);
  await analyseSavIntakeRuntime(id!, config, deps(p.network));
  await analyseSavIntakeRuntime(id!, config, deps(p.network));
  expect(p.gemini).toHaveLength(2);
  const run = await current();
  expect(run!.payload.reason).toBe("SAV_INTAKE_MODEL_OUTPUT_REJECTED");
  expect(run!.payload.attachments!.read.observations[0]).toMatchObject({ status: "not_read", reason: "validation_failed" });
  expect(run!.payload.traces).toEqual(expect.arrayContaining([expect.objectContaining({ accepted: false,
    validationFailure: { reason: "visual_structure_invalid", path: "images", stage: "decode" } })]));
  expect(await f.db.select().from(savActions)).toHaveLength(0); expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(0);
});

it("after an interruption later in the attempt, the normalized model result is reused from the ledger, never re-billed", async () => {
  const p = provider(() => [readableImage({ text: "Ligne de log ".repeat(500) })], n => n === 1 ? Promise.reject(Error("CRM_DOWN")) : Response.json({ total: 0, results: [] }));
  const id = await enqueueSavIntakeMessage(messageId, config);
  await analyseSavIntakeRuntime(id!, config, deps(p.network));
  await analyseSavIntakeRuntime(id!, config, deps(p.network));
  expect(p.gemini).toHaveLength(1);
  expect(await ledger()).toHaveLength(1);
  expect((await current())!.payload.attachments!.read.observations[0].status).toBe("partial");
  expect(await f.db.select().from(savActions)).toHaveLength(0);
});

it("the source message is never rewritten by normalization", async () => {
  const [before] = await f.db.select().from(savMessages).where(eq(savMessages.id, messageId));
  const p = provider(() => [readableImage({ text: "x ".repeat(3000) })]);
  await analyseSavIntakeRuntime((await enqueueSavIntakeMessage(messageId, config))!, config, deps(p.network));
  expect((await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0].bodyCiphertext).toBe(before.bodyCiphertext);
});
