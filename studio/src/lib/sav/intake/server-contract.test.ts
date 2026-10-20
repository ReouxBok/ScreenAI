import { describe, it, expect } from "vitest";
import { evaluationBatch, evaluationEnvironment } from "../../../../test/sav-intake-evaluation";
import { evaluationBatchSchema, evaluationConfig, evaluationHash, readEvaluationBody, assertEvaluationOrigin, EVALUATION_MAX_BYTES } from "./server-contract";
describe("closed three-case server evaluation contract", () => {
  it("accepts only the configured production model, commit, origin and short time window", () => {
    expect(evaluationConfig(evaluationEnvironment()).model).toBe("gemini-3.6-flash");
  });
  it.each(["SAV_INTAKE_EVAL_ENABLED", "VERCEL_ENV", "SAV_AI_MODEL", "SAV_INTAKE_EVAL_CODE_SHA", "VERCEL_GIT_COMMIT_SHA", "SAV_INTAKE_EVAL_MANIFEST_SHA256"])("fails closed for missing %s", key => {
    expect(() => evaluationConfig({ ...evaluationEnvironment(), [key]: "" })).toThrow();
  });
  it.each([-1, 86_400_001])("rejects expiry offset %d", offset => {
    const now = new Date(); expect(() => evaluationConfig({ ...evaluationEnvironment(), SAV_INTAKE_EVAL_EXPIRES_AT: new Date(now.getTime() + offset).toISOString() }, now)).toThrow();
  });
  it("rejects HTTP origins, URL paths and another served commit", () => {
    for (const origin of ["http://studio.example.invalid", "https://studio.example.invalid/path"]) expect(() => evaluationConfig({ ...evaluationEnvironment(), SAV_INTAKE_EVAL_ORIGIN: origin })).toThrow();
    expect(() => evaluationConfig({ ...evaluationEnvironment(), VERCEL_GIT_COMMIT_SHA: "b".repeat(40) })).toThrow();
  });
  it("rejects extra keys, case substitution/duplicates and non-three batches", () => {
    const batch = evaluationBatch();
    for (const input of [{ ...batch, prompt: "arbitrary" }, { ...batch, cases: batch.cases.slice(0, 2) }, { ...batch, cases: [batch.cases[0], batch.cases[0], batch.cases[2]] }]) expect(() => evaluationBatchSchema.parse(input)).toThrow();
    expect(evaluationHash(JSON.stringify(batch))).not.toBe(evaluationHash(JSON.stringify({ ...batch, cases: batch.cases.toReversed() })));
  });
  it("checks POST origin and permits only a same-origin GET without Origin", () => {
    const c = evaluationConfig(evaluationEnvironment()), url = c.origin + "/api/internal/sav/intake-evaluation";
    expect(() => assertEvaluationOrigin(new Request(url, { method: "POST" }), c)).toThrow();
    expect(() => assertEvaluationOrigin(new Request(url, { headers: { "sec-fetch-site": "cross-site" } }), c)).toThrow();
    expect(() => assertEvaluationOrigin(new Request(url, { headers: { "sec-fetch-site": "same-origin" } }), c)).not.toThrow();
  });
  it("reads exact UTF8 bytes without canonicalizing the sealed manifest", async () => {
    const text = JSON.stringify(evaluationBatch());
    expect(await readEvaluationBody(new Request("https://example.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: text }))).toBe(text);
  });
  it("bounds a chunked body independently of Content-Length", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(EVALUATION_MAX_BYTES)); c.enqueue(new Uint8Array(1)); c.close(); } });
    const request = new Request("https://example.invalid", { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body: stream, duplex: "half" } as RequestInit);
    await expect(readEvaluationBody(request)).rejects.toThrow("SAV_EVAL_BODY_REJECTED");
  });
  it("rejects encoding, malformed UTF8 and wrong media type", async () => {
    const sets: Record<string, string>[] = [{ "content-type": "text/plain" }, { "content-type": "application/json", "content-encoding": "gzip" }];
    for (const headers of sets) await expect(readEvaluationBody(new Request("https://example.invalid", { method: "POST", headers, body: "{}" }))).rejects.toThrow();
    await expect(readEvaluationBody(new Request("https://example.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([255]) }))).rejects.toThrow();
  });
});
