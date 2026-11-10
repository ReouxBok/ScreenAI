import { readDailyReviewSnapshot } from "@/lib/sav/daily-review-read";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
/** Staff-authenticated read only. No worker, model, provider, delivery or schedule is invoked. */
export async function GET(request: Request) {
  const url = new URL(request.url), entries = [...url.searchParams.entries()];
  const options: Record<string, unknown> = Object.fromEntries(entries);
  if (options.limit !== undefined) options.limit = Number(options.limit);
  try {
    // Duplicate keys become an invalid field, rejected after authentication by the reader.
    if (new Set(entries.map(([key]) => key)).size !== entries.length) options.duplicate = true;
    return Response.json(await readDailyReviewSnapshot(options), { headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "DAILY_REVIEW_UNAUTHORIZED")
      return Response.json({ error: "forbidden" }, { status: 403, headers });
    if (code === "DAILY_REVIEW_WINDOW_INVALID" || error instanceof Error && error.name === "ZodError")
      return Response.json({ error: "invalid_request" }, { status: 400, headers });
    return Response.json({ error: "monitoring_unavailable" }, { status: 503, headers });
  }
}
