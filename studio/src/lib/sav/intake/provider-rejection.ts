import { createHash } from "node:crypto";

const LIMIT = 16 * 1024, DEADLINE_MS = 100;
const fieldRoots = ["generationConfig.responseSchema", "generationConfig.responseMimeType", "generationConfig.maxOutputTokens", "generationConfig.thinkingConfig", "contents", "systemInstruction"] as const;
export type ProviderRejectionDiagnostic = {
  status: "INVALID_ARGUMENT" | "FAILED_PRECONDITION" | "UNKNOWN";
  reason: "schema_complexity" | "invalid_field" | "unknown";
  fields: (typeof fieldRoots)[number][];
  bodyRead: "complete" | "too_large" | "invalid_json" | "timeout" | "cancelled" | "unreadable" | "absent";
  bytesRead: number;
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Comparison diagnostics only. No provider strings leave this boundary, including
 * messages, paths, descriptions or unknown enum values. This is informational,
 * never a reason to retry, admit evidence or rewrite a previous settlement. */
export async function readProviderRejection(response: Response, signal: AbortSignal): Promise<ProviderRejectionDiagnostic> {
  const diagnostic: ProviderRejectionDiagnostic = { status: "UNKNOWN", reason: "unknown", fields: [], bodyRead: "absent", bytesRead: 0 };
  if (!response.body) return diagnostic;
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let reads = 0;
  let stop!: (reason: "timeout" | "cancelled") => void;
  const stopped = new Promise<"timeout" | "cancelled">(resolve => { stop = resolve; });
  const aborted = () => stop("cancelled");
  signal.addEventListener("abort", aborted, { once: true });
  const timer = setTimeout(() => stop("timeout"), DEADLINE_MS);
  if (signal.aborted) aborted();
  try {
    while (true) {
      // Also bound empty/tiny chunks: an infinite microtask stream must not
      // starve the timer or grow the chunk array without consuming bytes.
      if (++reads > 256) { diagnostic.bodyRead = "too_large"; return diagnostic; }
      const part = await Promise.race([reader.read(), stopped]);
      if (typeof part === "string") { diagnostic.bodyRead = part; return diagnostic; }
      if (part.done) break;
      diagnostic.bytesRead = Math.min(LIMIT + 1, diagnostic.bytesRead + part.value.byteLength);
      if (diagnostic.bytesRead > LIMIT) { diagnostic.bodyRead = "too_large"; return diagnostic; }
      chunks.push(part.value);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { diagnostic.bodyRead = "invalid_json"; return diagnostic; }
    diagnostic.bodyRead = "complete";
    const error = record(body) && record(body.error) ? body.error : undefined;
    if (!error) return diagnostic;
    if (error.status === "INVALID_ARGUMENT" || error.status === "FAILED_PRECONDITION") diagnostic.status = error.status;
    // Match known structural descriptions locally; never retain the description.
    if (typeof error.message === "string" && /(?:too many states|too many branches|schema[^.\n]*(?:complex|nesting|nested|depth))/i.test(error.message)) diagnostic.reason = "schema_complexity";
    if (Array.isArray(error.details)) for (const detail of error.details.slice(0, 8)) {
      if (!record(detail) || !Array.isArray(detail.fieldViolations)) continue;
      for (const violation of detail.fieldViolations.slice(0, 8)) {
        if (!record(violation) || typeof violation.field !== "string") continue;
        const field = violation.field;
        const root = fieldRoots.find(root => [root, root.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)].some(alias => field === alias || field.startsWith(`${alias}.`) || field.startsWith(`${alias}[`)));
        if (root && !diagnostic.fields.includes(root)) diagnostic.fields.push(root);
      }
    }
    if (diagnostic.reason === "unknown" && diagnostic.fields.length) diagnostic.reason = "invalid_field";
    return diagnostic;
  } catch { diagnostic.bodyRead = signal.aborted ? "cancelled" : "unreadable"; return diagnostic; }
  finally {
    clearTimeout(timer); signal.removeEventListener("abort", aborted);
    // A hostile/unfinished stream must not extend the diagnostic's time budget.
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A pending read is cancelled above. */ }
  }
}

/** Structural facts about the exact outgoing schema; never enum values, source
 * IDs, prompt text or raw schema. The hash binds diagnostics to that schema. */
export function providerSchemaDiagnostic(schema: unknown) {
  const bytes = JSON.stringify(schema ?? null) ?? "null";
  let nodes = 0, maxDepth = 0, enumValues = 0, arrays = 0, boundedArrays = 0;
  const visit = (value: unknown, depth: number) => {
    if (!record(value)) return;
    nodes++; maxDepth = Math.max(maxDepth, depth);
    if (Array.isArray(value.enum)) enumValues += value.enum.length;
    if (value.type === "ARRAY") { arrays++; if (value.minItems !== undefined || value.maxItems !== undefined) boundedArrays++; }
    if (record(value.properties)) for (const child of Object.values(value.properties)) visit(child, depth + 1);
    visit(value.items, depth + 1);
  };
  visit(schema, 1);
  return { hash: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.byteLength(bytes), nodes, maxDepth, enumValues, arrays, boundedArrays };
}
