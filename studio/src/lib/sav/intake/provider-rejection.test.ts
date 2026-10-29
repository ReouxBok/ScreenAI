import { afterEach, expect, it, vi } from "vitest";
import { providerSchemaDiagnostic, readProviderRejection } from "./provider-rejection";
afterEach(() => vi.useRealTimers());
const signal = () => new AbortController().signal;
it("projects only known status, structural reason and static field roots, never echoed PII or property names", async () => {
  const privateText = "secret@example.test <html>customer-key</html>";
  const response = Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message: `Schema has too many states: ${privateText}`,
    details: [{ fieldViolations: [{ field: `generationConfig.responseSchema.properties.${privateText}`, description: privateText },
      { field: privateText }, { field: "generationConfig.responseSchema" }, { field: "generation_config.response_schema.properties.private" }] }] } });
  const d = await readProviderRejection(response, signal());
  expect(d).toMatchObject({ status: "INVALID_ARGUMENT", reason: "schema_complexity", fields: ["generationConfig.responseSchema"], bodyRead: "complete" });
  expect(JSON.stringify(d)).not.toContain(privateText);
  expect(JSON.stringify(d)).not.toContain("customer-key");
});
it.each(["<html>secret@example.test</html>", '{"secret@example.test"', "null"]) ("retains no external text from an invalid/non-error body %s", async text => {
  const d = await readProviderRejection(new Response(text), signal());
  expect(d.status).toBe("UNKNOWN"); expect(d.reason).toBe("unknown"); expect(d.fields).toEqual([]);
  expect(JSON.stringify(d)).not.toContain(text);
});
it("does not classify arbitrary status/message or a field with only a misleading prefix", async () => {
  expect(await readProviderRejection(Response.json({ error: { status: "PRIVATE_STATUS", message: "private details", details: [{ fieldViolations: [{ field: "generationConfig.responseSchemaSecret@example.test" }] }] } }), signal()))
    .toMatchObject({ status: "UNKNOWN", reason: "unknown", fields: [] });
});
it("recognizes an invalid static field without retaining its description", async () => {
  expect(await readProviderRejection(Response.json({ error: { status: "FAILED_PRECONDITION", details: [{ fieldViolations: [{ field: "generationConfig.thinkingConfig.thinkingLevel", description: "private" }] }] } }), signal()))
    .toMatchObject({ status: "FAILED_PRECONDITION", reason: "invalid_field", fields: ["generationConfig.thinkingConfig"] });
});
it("cancels a giant response without retaining or concatenating its payload", async () => {
  const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(1024 * 1024)); }, cancel });
  expect(await readProviderRejection(new Response(stream), signal())).toEqual({ status: "UNKNOWN", reason: "unknown", fields: [], bodyRead: "too_large", bytesRead: 16385 });
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("bounds a stream of empty chunks even when it could starve the deadline timer", async () => {
  const cancel = vi.fn(); let reads = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { reads++; c.enqueue(new Uint8Array()); }, cancel });
  expect(await readProviderRejection(new Response(stream), signal())).toMatchObject({ bodyRead: "too_large", bytesRead: 0 });
  expect(reads).toBeLessThanOrEqual(258); expect(cancel).toHaveBeenCalledTimes(1);
});
it("enforces a total 100ms deadline even if the body and cancellation never finish", async () => {
  vi.useFakeTimers(); const cancel = vi.fn(() => new Promise<void>(() => {}));
  const pending = readProviderRejection(new Response(new ReadableStream({ cancel })), signal());
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toMatchObject({ bodyRead: "timeout", bytesRead: 0 });
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("honors parent cancellation without waiting for the provider body", async () => {
  const controller = new AbortController(), pending = readProviderRejection(new Response(new ReadableStream()), controller.signal);
  controller.abort(); expect(await pending).toMatchObject({ bodyRead: "cancelled" });
});
it("reports an unreadable stream without echoing its error", async () => {
  expect(await readProviderRejection(new Response(new ReadableStream({ start(c) { c.error(Error("private key")); } })), signal())).toMatchObject({ bodyRead: "unreadable" });
});
it("records only schema structure and a hash, preserving enum privacy", () => {
  const schema = { type: "OBJECT", properties: { privateName: { type: "ARRAY", maxItems: "20", items: { type: "STRING", enum: ["secret@example.test", "private-key"] } } } };
  const d = providerSchemaDiagnostic(schema);
  expect(d).toMatchObject({ hash: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: Buffer.byteLength(JSON.stringify(schema)), nodes: 3, maxDepth: 3, enumValues: 2, arrays: 1, boundedArrays: 1 });
  expect(JSON.stringify(d)).not.toMatch(/private|secret/);
  expect(providerSchemaDiagnostic({ ...schema, properties: {} }).hash).not.toBe(d.hash);
});
