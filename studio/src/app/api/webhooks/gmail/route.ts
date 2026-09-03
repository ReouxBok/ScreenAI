import { after } from "next/server";
import { ZodError } from "zod";
import { acceptGmailWebhook, processGmailReceipt, verifyGmailWebhookRequest } from "@/lib/sav/gmail";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
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
    if (!result.duplicate) after(() => processGmailReceipt(result.receipt.id));
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
