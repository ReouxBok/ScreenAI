import { expect, it, vi } from "vitest";
import { collectSavAttachmentInventory, decodeSavAttachmentData, fetchSavAttachmentBytes, readSavAttachmentJson } from "./attachment-gmail";
import { attachmentMetadata } from "../../../test/sav-attachments";
const owner = { mailboxEmail: "contact@limova.ai", gmailMessageId: "gmail-fixture", gmailThreadId: "thread-fixture" };
it("inventories a CID image without filename, excludes remote HTML images and never persists inline bytes", () => {
  const result = collectSavAttachmentInventory({ mimeType: "multipart/related", parts: [
    { partId: "0", mimeType: "text/html", body: { data: Buffer.from('<img src="https://remote.example.invalid/a.png">').toString("base64url") } },
    { partId: "1", mimeType: "image/png", headers: [{ name: "Content-ID", value: "<screen-fixture>" }], body: { size: 3, data: "YWJj" } },
  ] }, owner);
  expect(result.attachments).toHaveLength(1); expect(result.attachments[0].reference).toMatchObject({ partId: "1", contentId: "screen-fixture", attachmentId: null, disposition: "inline" });
  expect(JSON.stringify(result)).not.toContain("YWJj"); expect(JSON.stringify(result)).not.toContain("https:");
});
it("accepts old metadata without manufacturing a recoverable part reference", () => {
  expect(collectSavAttachmentInventory({ filename: "old.png", mimeType: "image/png", body: { size: 3 } }, owner).attachments[0].reference).toBeUndefined();
});
it("preserves Gmail's explicitly empty root part ID", async () => {
  const part = { partId: "", mimeType: "image/png", body: { size: 3, data: "YWJj" } };
  const [item] = collectSavAttachmentInventory(part, owner).attachments;
  expect(item.reference?.partId).toBe("");
  expect((await fetchSavAttachmentBytes(item.reference!, 3, async () => ({ id: owner.gmailMessageId, threadId: owner.gmailThreadId, payload: part }), AbortSignal.timeout(1000))).toString()).toBe("abc");
});
it("bounds MIME depth and inventory size", () => {
  const result = collectSavAttachmentInventory({ parts: Array.from({ length: 1000 }, () => ({ filename: "f.png", mimeType: "image/png", body: { size: 3 } })) }, owner);
  expect(result.attachments).toHaveLength(100);
  expect(result.attachmentInventory).toEqual({ complete: false, limits: ["reference_limit"] });
});
it.each(["YWJj!", "a", "YWJj=====", "YW Jj"])("rejects noncanonical base64url %s before accepting bytes", data => {
  expect(() => decodeSavAttachmentData({ data, size: 3 }, 3)).toThrow();
});
it("rejects size mismatches and admits only bounded bytes", () => {
  expect(decodeSavAttachmentData({ data: "YWJj", size: 3 }, 3).toString()).toBe("abc");
  expect(() => decodeSavAttachmentData({ data: "YWJj", size: 4 }, 3)).toThrow("byte_limit");
});
it("stops a streaming response whose real size exceeds the cap even without content-length", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.enqueue(new Uint8Array(10)); }, cancel }));
  await expect(readSavAttachmentJson(response, 15)).rejects.toThrow("byte_limit"); expect(cancel).toHaveBeenCalledOnce();
  await expect(readSavAttachmentJson(new Response("{}", { headers: { "content-length": "1000" } }), 15)).rejects.toThrow("byte_limit");
});
it.each([403, 404, 429])("returns a safe HTTP %s reason without reading the external error", async status => {
  const response = new Response("private-provider-error", { status }), spy = vi.spyOn(response, "json");
  await expect(readSavAttachmentJson(response, 100)).rejects.toThrow(); expect(spy).not.toHaveBeenCalled();
});
it("binds inline content to the actual Gmail message, part and CID", async () => {
  const reference = { ...attachmentMetadata(3).reference!, attachmentId: null, contentId: "cid-fixture" };
  const read = vi.fn(async () => ({ id: owner.gmailMessageId, threadId: owner.gmailThreadId, payload: { parts: [{ partId: "1", mimeType: "image/png", headers: [{ name: "Content-ID", value: "<cid-fixture>" }], body: { size: 3, data: "YWJj" } }] } }));
  expect((await fetchSavAttachmentBytes(reference, 3, read, AbortSignal.timeout(1000))).toString()).toBe("abc");
  await expect(fetchSavAttachmentBytes({ ...reference, gmailMessageId: "wrong" }, 3, read, AbortSignal.timeout(1000))).rejects.toThrow("association_mismatch");
  await expect(fetchSavAttachmentBytes({ ...reference, partId: "2" }, 3, read, AbortSignal.timeout(1000))).rejects.toThrow("association_mismatch");
});
it("checks the manifest binding before downloading an attachment ID", async () => {
  const reference = attachmentMetadata(3).reference!;
  const read = vi.fn(async (path: string) => path.includes("/attachments/") ? { size: 3, data: "YWJj" }
    : { id: owner.gmailMessageId, threadId: owner.gmailThreadId, payload: { partId: "1", mimeType: "image/png", body: { attachmentId: reference.attachmentId!, size: 3 } } });
  expect((await fetchSavAttachmentBytes(reference, 3, read, AbortSignal.timeout(1000), "image/png")).toString()).toBe("abc");
  expect(read.mock.calls[0][0]).toContain("body(attachmentId,size)");
  expect(read.mock.calls[0][0]).not.toContain("data");
  read.mockClear();
  for (const patch of [{ partId: "9" }, { attachmentId: "other-file" }, { gmailThreadId: "other-thread" }, { contentId: "invented-cid" }]) {
    await expect(fetchSavAttachmentBytes({ ...reference, ...patch }, 3, read, AbortSignal.timeout(1000), "image/png")).rejects.toThrow("association_mismatch");
  }
  await expect(fetchSavAttachmentBytes(reference, 3, read, AbortSignal.timeout(1000), "image/jpeg")).rejects.toThrow("association_mismatch");
  expect(read.mock.calls.every(([path]) => !path.includes("/attachments/"))).toBe(true);
});

it("certifies exactly 100 references but marks the 101st as omitted without an invented total", () => {
  const parts = Array.from({ length: 101 }, (_, index) => ({ partId: String(index), filename: `capture-${index}.png`, mimeType: "image/png", body: { size: 3 } }));
  expect(collectSavAttachmentInventory({ parts: parts.slice(0, 100) }, owner).attachmentInventory).toEqual({ complete: true, limits: [] });
  const result = collectSavAttachmentInventory({ parts }, owner);
  expect(result.attachments).toHaveLength(100);
  expect(result.attachmentInventory).toEqual({ complete: false, limits: ["reference_limit"] });
  expect(JSON.stringify(result)).not.toContain("capture-100.png");
  expect(result.attachmentInventory).not.toHaveProperty("total");
});
it("reports the node bound even if no attachment has been found", () => {
  const parts = Array.from({ length: 500 }, () => ({ mimeType: "text/plain" }));
  expect(collectSavAttachmentInventory({ parts: parts.slice(0, 499) }, owner).attachmentInventory.complete).toBe(true);
  expect(collectSavAttachmentInventory({ parts }, owner)).toEqual({ attachments: [], attachmentInventory: { complete: false, limits: ["node_limit"] } });
});
it("reports a skipped deep branch while preserving a readable sibling", () => {
  let deep: import("./attachment-gmail").SavGmailMimePart = { filename: "too-deep.png", mimeType: "image/png" };
  for (let index = 0; index < 21; index++) deep = { parts: [deep] };
  const result = collectSavAttachmentInventory({ parts: [deep, { filename: "sibling.png", mimeType: "image/png" }] }, owner);
  expect(result.attachments.map(item => item.filename)).toEqual(["sibling.png"]);
  expect(result.attachmentInventory).toEqual({ complete: false, limits: ["depth_limit"] });
});
