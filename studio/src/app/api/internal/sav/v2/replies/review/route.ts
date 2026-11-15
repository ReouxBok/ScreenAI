import { z } from "zod";
import { requireApiStaff } from "@/lib/auth";
import { executionAdministrator } from "@/lib/sav/intake/execution-policy";
import { CASE_REPLY_REVIEW_TEXT_MAX, caseReplyReviewEnabled, reviewCaseReply } from "@/lib/sav/cases/case-reply-review";
import { caseReplyReviewDeps } from "@/lib/sav/cases/case-reply-review-binding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
/** The request's own budget for an immediate send, inside maxDuration (120 s); the send needs 60 s of it left, else the catch-up sends. */
const IMMEDIATE_BUDGET_MS = 105_000;
const MAX_BYTES = 32 * 1024;
const request = z.object({
  action: z.enum(["approve", "correct", "decline", "requeue"]), token: z.string().min(1).max(200),
  text: z.string().max(CASE_REPLY_REVIEW_TEXT_MAX * 2).optional(), reason: z.string().max(1000).optional(),
}).strict();

/**
 * SAV-92: a Studio administrator approves, corrects or declines ONE proposed V2 reply, bound to the version token their screen showed.
 * Administrators only (the SAV admin check), same origin and JSON only, bounded body, no GET mutation, no batch. The decision, the queue and the send are pole C's.
 */
export async function POST(incoming: Request) {
  const startedAt = Date.now();
  // Off unless SAV_V2_REPLY_REVIEW=on (review item 4): the route does not exist, before any auth or body read.
  if (!caseReplyReviewEnabled(process.env)) return Response.json({ error: "not_found" }, { status: 404, headers });
  try { await requireApiStaff("admin"); } catch { return Response.json({ error: "forbidden" }, { status: 403, headers }); }
  let staff;
  try { staff = await executionAdministrator(); } catch { return Response.json({ error: "forbidden" }, { status: 403, headers }); }
  if (incoming.headers.get("origin") !== new URL(incoming.url).origin || incoming.headers.get("content-type")?.split(";")[0] !== "application/json")
    return Response.json({ error: "invalid_request" }, { status: 400, headers });
  let input;
  try {
    const reader = incoming.body?.getReader();
    if (!reader) return Response.json({ error: "invalid_request" }, { status: 400, headers });
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); return Response.json({ error: "too_large" }, { status: 413, headers }); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    input = request.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!input.success) return Response.json({ error: "invalid_request" }, { status: 400, headers });
  } catch { return Response.json({ error: "invalid_request" }, { status: 400, headers }); }
  try {
    const result = await reviewCaseReply(input.data, { staffUserId: staff.id, email: staff.email }, caseReplyReviewDeps({ env: process.env, callerDeadlineMs: startedAt + IMMEDIATE_BUDGET_MS }));
    return Response.json(result, { status: result.ok ? 200 : 409, headers });
  } catch {
    // An interrupted request is not proof of non-effect: never retried automatically, no provider or customer text exposed.
    return Response.json({ ok: false, code: "review_unconfirmed" }, { status: 409, headers });
  }
}
