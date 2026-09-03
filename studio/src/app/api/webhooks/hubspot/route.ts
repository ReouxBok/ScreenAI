import { after } from "next/server";
import { acceptHubspotWebhook, processPendingHubspotReceipts, verifyHubspotWebhookRequest } from "@/lib/sav/hubspot";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (!verifyHubspotWebhookRequest(request, rawBody)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const receipts = await acceptHubspotWebhook(JSON.parse(rawBody));
    if (receipts.some((receipt) => !receipt.duplicate)) after(() => processPendingHubspotReceipts(100));
    return new Response(null, { status: 204 });
  } catch {
    return Response.json({ error: "invalid_notification" }, { status: 400 });
  }
}
