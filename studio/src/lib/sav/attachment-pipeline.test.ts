import { afterEach, expect, it, vi } from "vitest";
import { analyzeStoredSavMessage } from "./service";
import { attachmentMessageId, observedAttachment } from "../../../test/sav-attachments";
const calls = vi.hoisted(() => ({ context: vi.fn(), read: vi.fn(), analyze: vi.fn() }));
vi.mock("./dossier-context", () => ({ collectSavDossierContext: calls.context }));
vi.mock("./attachment-store", () => ({ acquireSavAttachmentRead: calls.read }));
vi.mock("./intelligence", () => ({ analyzeSavMessage: calls.analyze }));
afterEach(() => vi.resetAllMocks());
it("acquires the observation after authorized context and before the final understanding pipeline", async () => {
  const read = observedAttachment(), context = { version: 1, messageId: attachmentMessageId };
  calls.context.mockResolvedValue(context); calls.read.mockResolvedValue(read); calls.analyze.mockResolvedValue({ fixture: true });
  await analyzeStoredSavMessage({ from: "fixture@example.invalid", subject: "Capture", body: "Aidez-moi." }, { messageId: attachmentMessageId });
  expect(calls.context.mock.invocationCallOrder[0]).toBeLessThan(calls.read.mock.invocationCallOrder[0]);
  expect(calls.read.mock.invocationCallOrder[0]).toBeLessThan(calls.analyze.mock.invocationCallOrder[0]);
  expect(calls.analyze).toHaveBeenCalledWith(expect.objectContaining({ attachmentRead: read, dossierContext: context }), { messageId: attachmentMessageId });
});
it("does not introduce image reading into an isolated pilot", async () => {
  calls.context.mockResolvedValue({ version: 1, messageId: attachmentMessageId }); calls.analyze.mockResolvedValue({ fixture: true });
  await analyzeStoredSavMessage({ from: "fixture@example.invalid", subject: "Capture", body: "Aidez-moi." }, { messageId: attachmentMessageId, pilotBatchId: "synthetic-batch" });
  expect(calls.read).not.toHaveBeenCalled(); expect(calls.analyze.mock.calls[0][0].attachmentRead).toBeNull();
});

it("passes inventory limitations to analysis even when no image observation is available", async () => {
  calls.context.mockResolvedValue({ version: 1, messageId: attachmentMessageId }); calls.read.mockResolvedValue(null); calls.analyze.mockResolvedValue({ fixture: true });
  const attachmentInventory = { complete: false, limits: ["reference_limit"] as ["reference_limit"] };
  await analyzeStoredSavMessage({ from: "fixture@example.invalid", subject: "Capture", body: "Aidez-moi.", attachmentInventory }, { messageId: attachmentMessageId });
  expect(calls.analyze.mock.calls[0][0]).toMatchObject({ attachmentInventory, attachmentRead: null });
});
