/** Images on the single-call reader through the real runtime, transport and ledger:
 * a reading or understanding defect never yields an automatic decision. */
import { randomUUID } from "node:crypto";
import { encodeSimpleWireFixture } from "./simple-wire.fixture";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savActions, savIntakeExecutions } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimeConfig } from "./runtime-contract";
import { enqueueSavIntakeMessage, readSavIntakeCurrent } from "./runtime-store";
import { analyseSavIntakeRuntime } from "./runtime";

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string, messageId: string, config: IntakeRuntimeConfig, environment: Record<string, string | undefined>;
let bytes: Buffer;
function env(mailbox: string) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: "synthetic-intake-runtime-encryption-key", SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]", SAV_INTAKE_PIPELINE: "simple",
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
type ImageAnswer = Record<string, unknown>;
const image = (over: ImageAnswer = {}) => ({ index: 0, readability: "readable", text: "Erreur E42 au démarrage", uncertainties: [], regions: [{ text: "Erreur E42", box: null }], ...over });
/** Synthetic Gemini answering the simple contract, behind the real transport and dispatcher. */
function provider(images: () => ImageAnswer[], requirement: "required" | "accessory" | "unknown" | null) {
  let calls = 0;
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      calls++;
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
      const answer = { messageId, nature: "request", requests: [{ id: "r1", kind: "support", summary: "Erreur visible sur la capture.", sourceIds: ["current", data.images[0].sourceId] }],
        ticketTitle: "Erreur E42 au démarrage", ticketDescription: "Le client signale une erreur visible sur sa capture.",
        identity: { kind: "unknown", contactIds: [], why: "Aucune fiche." }, tickets: [], missing: [], rationale: "Erreur applicative.",
        images: images(), imageRequirements: requirement ? [{ sourceId: data.images[0].sourceId, role: requirement }] : [] };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(encodeSimpleWireFixture(answer, data.outputReferences)) }] } }], usageMetadata: { promptTokenCount: 1220, candidatesTokenCount: 200, thoughtsTokenCount: 0, totalTokenCount: 1420 } });
    }
    if (String(url).startsWith("https://api.hubapi.com/")) return Response.json({ total: 0, results: [] });
    throw Error("EXTERNAL_NETWORK_FORBIDDEN");
  });
  return { network, calls: () => calls };
}
const deps = (network: typeof fetch) => ({ env: () => environment, network, downloadAttachments: async () => bytes });
async function stored(text: string) {
  const { attachmentMetadata } = await import("../../../../test/sav-attachments");
  const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid" }).returning(); threadId = thread.id;
  const gmailMessageId = randomUUID(), metadata = attachmentMetadata(bytes.length);
  metadata.reference = { ...metadata.reference!, mailboxEmail: "support@example.invalid", gmailMessageId, gmailThreadId: thread.gmailThreadId };
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "synthetic@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Erreur", gmailMessageId, bodyCiphertext: encryptSavPayload({ text, headers: {}, attachments: [metadata], attachmentInventory: { complete: true, limits: [] } }),
    receivedAt: new Date(), createdAt: new Date(), analysisStatus: "pending" }).returning();
  messageId = m.id;
}
async function analyse(p: ReturnType<typeof provider>) {
  const id = (await enqueueSavIntakeMessage(messageId, config))!;
  await analyseSavIntakeRuntime(id, config, deps(p.network));
  return (await readSavIntakeCurrent(threadId, config))!;
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; bytes = await (await import("../../../../test/sav-attachments")).syntheticImage(); }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-intake-runtime-encryption-key");
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  environment = env(mailboxId); config = savIntakeRuntimeConfig(environment)!;
});
afterEach(() => vi.unstubAllEnvs());

describe("images on the single-call reader", () => {
  it("the image is sent with the single call, read and kept as an analysed observation", async () => {
    await stored("Ça ne fonctionne pas, voir la capture jointe.");
    const p = provider(() => [image()], "required");
    const run = await analyse(p);
    expect(p.calls()).toBe(1);
    expect(run.payload.attachments!.read.observations[0]).toMatchObject({ status: "analyzed" });
    expect(run.payload.plan?.decision.evidence.some(e => e.source === "current_attachment")).toBe(true);
  });
  it.each([
    ["unreadable", () => [image({ readability: "unreadable", text: "", regions: [] })], "required"],
    ["partial", () => [image({ readability: "partial", uncertainties: ["Bas de l'écran coupé."] })], "required"],
    ["without any declared role", () => [image({ readability: "unreadable", text: "", regions: [] })], null],
  ] as const)("a needed image that is %s never yields an automatic decision", async (_, images, requirement) => {
    await stored("Ça ne fonctionne pas, voir la capture jointe.");
    const run = await analyse(provider(images, requirement));
    expect(run.payload.plan?.decision.disposition).toMatchObject({ kind: "collect_context", reasons: expect.arrayContaining(["classification_incomplete"]) });
    expect(run.payload.plan?.steps).toEqual([]);
    expect(run.payload.plan?.decision.evidence.some(e => e.source === "current_attachment")).toBe(false);
    expect(await f.db.select().from(savActions)).toHaveLength(0); expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(0);
  });
  it("an image answer that does not match the images sent is rejected without a second visual call in the attempt", async () => {
    await stored("Ça ne fonctionne pas, voir la capture jointe.");
    const p = provider(() => [image(), image({ index: 1 })], "required");
    const run = await analyse(p);
    expect(p.calls()).toBe(1);
    expect(run.payload.plan?.steps ?? []).toEqual([]);
    expect(run.payload.attachments!.read.observations[0].status).not.toBe("analyzed");
  });
  it("an image marked accessory while the customer points to it is never treated as accessory", async () => {
    await stored("Ça ne fonctionne pas, voir la capture jointe.");
    const run = await analyse(provider(() => [image({ readability: "unreadable", text: "", regions: [] })], "accessory"));
    expect(run.payload.plan?.decision.disposition).toMatchObject({ kind: "collect_context" });
    expect(run.payload.plan?.steps).toEqual([]);
  });
});
