import { z } from "zod";

const selectionSchema = z.object({ sourcePolicyId: z.uuid(), executionIds: z.array(z.uuid()).min(1).max(100)
  .refine(ids => new Set(ids).size === ids.length) }).strict();
const previewSchema = selectionSchema.extend({ hash: z.string().regex(/^[a-f0-9]{64}$/), targetPolicyId: z.uuid() }).strict();
const receiptSchema = z.object({ id: z.uuid(), executionIds: z.array(z.uuid()).min(1).max(100) }).strict();
export type ContinuitySelection = z.infer<typeof selectionSchema>;
export type ContinuityPreview = z.infer<typeof previewSchema>;
export class ContinuityClientError extends Error {
  constructor(public readonly uncertain: boolean, message = "SAV_INTAKE_CONTINUITY_REQUEST_FAILED") { super(message); }
}
export function continuitySelection(source: string, ids: string): ContinuitySelection {
  return selectionSchema.parse({ sourcePolicyId: source.trim(), executionIds: ids.trim().split(/[\s,]+/).filter(Boolean) });
}
const sameIds = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const endpoint = "/api/internal/sav/intake/continuity";
async function request(fetcher: typeof fetch, url: string, init: RequestInit, commit: boolean): Promise<unknown> {
  let response: Response;
  try { response = await fetcher(url, { credentials: "same-origin", cache: "no-store", redirect: "error", ...init }); }
  catch { throw new ContinuityClientError(commit); }
  if (!response.ok) {
    // A proxy/server failure may happen after a transaction committed. Only an
    // explicit refusal from the canonical route is known to be non-committing.
    let refusal: unknown; try { refusal = await response.json(); } catch { /* unknown outcome */ }
    const e = z.object({ error: z.string().regex(/^(?:SAV_[A-Z_]+|forbidden|invalid_origin|invalid_request)$/) }).strict().safeParse(refusal);
    // The route also wraps database errors in 409. A lost commit acknowledgement
    // can therefore look like a refusal: keep that outcome uncertain.
    const rejected = [400, 403].includes(response.status) && e.success;
    throw new ContinuityClientError(commit && !rejected, e.success ? e.data.error : undefined);
  }
  try { return await response.json(); } catch { throw new ContinuityClientError(commit); }
}
export async function continuityPreview(selection: ContinuitySelection, fetcher: typeof fetch = fetch): Promise<ContinuityPreview> {
  const input = selectionSchema.parse(selection);
  const params = new URLSearchParams({ sourcePolicyId: input.sourcePolicyId, executionIds: input.executionIds.join(",") });
  const raw = await request(fetcher, `${endpoint}?${params}`, { method: "GET" }, false);
  const result = z.object({ preview: previewSchema, requires: z.string() }).strict().parse(raw).preview;
  if (result.sourcePolicyId !== input.sourcePolicyId || result.targetPolicyId === result.sourcePolicyId || !sameIds(result.executionIds, input.executionIds))
    throw new ContinuityClientError(false);
  return result;
}
export async function continuityCommit(preview: ContinuityPreview, drained: boolean, fetcher: typeof fetch = fetch) {
  const input = previewSchema.parse(preview);
  if (drained !== true) throw new ContinuityClientError(false, "SAV_INTAKE_CONTINUITY_DRAIN_REQUIRED");
  const raw = await request(fetcher, endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePolicyId: input.sourcePolicyId, executionIds: input.executionIds, expectedHash: input.hash, oldDeploymentFencedAndDrained: true }) }, true);
  const parsed = z.object({ receipt: receiptSchema, providerActions: z.literal(0), modelCalls: z.literal(0) }).strict().safeParse(raw);
  if (!parsed.success || !sameIds(parsed.data.receipt.executionIds, input.executionIds)) throw new ContinuityClientError(true);
  return parsed.data.receipt;
}
