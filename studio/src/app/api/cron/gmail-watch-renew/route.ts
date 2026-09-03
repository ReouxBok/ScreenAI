import { renewActiveGmailWatches } from "@/lib/sav/gmail";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const mailboxes = await renewActiveGmailWatches();
    return Response.json({ renewed: mailboxes.length });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "watch_renewal_failed" }, { status: 503 });
  }
}
