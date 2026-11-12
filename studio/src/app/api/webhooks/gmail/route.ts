import { after } from "next/server";
import { ZodError } from "zod";
import { acceptGmailWebhook, processGmailReceipt, verifyGmailWebhookRequest } from "@/lib/sav/gmail";
import { watchSavReconcilePulse } from "@/lib/sav/monitor-watchdog";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  if (!await verifyGmailWebhookRequest(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    const result = await acceptGmailWebhook(payload);
    // After the 204, one post-commit work: the receipt and, beside it, the watchdog of the scheduled catch-up (one row read, at most
    // once a minute, never throws) and the self-scheduler fallback. allSettled keeps the watchdog and the fallback alive until they
    // settle even when the receipt fails; the receipt's failure is then rethrown as before.
    if (!result.duplicate) after(async () => {
      const [receipt] = await Promise.allSettled([processGmailReceipt(result.receipt.id), watchSavReconcilePulse(), runSelfSchedulerFallback(requestStartedAt)]);
      if (receipt.status === "rejected") throw receipt.reason;
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const invalidPayload = error instanceof ZodError || error instanceof SyntaxError;
    const errorCode = error instanceof ZodError
      ? error.issues.map((issue) => `${issue.path.join(".") || "payload"}:${issue.code}`).join(",")
      : error instanceof SyntaxError
        ? "INVALID_JSON_PAYLOAD"
        : error instanceof Error
          ? error.message.replace(/[^A-Z0-9_:.\-]/gi, "_").slice(0, 160)
          : "UNKNOWN_ERROR";
    const payloadShape = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload as Record<string, unknown>).sort()
      : [typeof payload];
    console.error("GMAIL_WEBHOOK_REJECTED", { errorCode, payloadShape });
    return Response.json(
      { error: invalidPayload ? "invalid_notification" : "webhook_storage_failed" },
      { status: invalidPayload ? 400 : 500 },
    );
  }
}

/** Fallback for the Vercel schedules (lib/sav/self-scheduler.ts). Opt-in: it does nothing unless the production database
 * switch is ON, and then only what the schedules visibly missed. It never changes the response or the receipt's processing
 * and never rejects; its errors are only logged. Loaded lazily, so that module can neither slow down nor break the
 * acknowledgement. Its pass ends by this request's deadline (computed from requestStartedAt). */
async function runSelfSchedulerFallback(requestStartedAt: number) {
  try {
    const [{ runSavSelfSchedulerFromWebhook }, { ensureSavHeartbeat }] = await Promise.all([import("@/lib/sav/self-scheduler"), import("@/lib/sav/self-scheduler-heartbeat")]);
    await runSavSelfSchedulerFromWebhook({ requestStartedAt, ensureHeartbeat: () => ensureSavHeartbeat({ trigger: "gmail_webhook" }) });
  } catch {
    console.error("sav_self_scheduler_webhook", { status: "failed" });
  }
}
