import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getPublishedOnboardingTemplate } from "@/lib/onboarding-template";

export const runtime = "nodejs";

function authorized(request: Request) {
  const expected = process.env.STUDIO_SERVICE_TOKEN;
  const provided = request.headers.get("authorization");
  if (!expected || expected.length < 32 || !provided) return false;
  const expectedBuffer = Buffer.from(`Bearer ${expected}`);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const template = await getPublishedOnboardingTemplate();
    return NextResponse.json(template ?? { revision: "onboarding_fallback", template: null }, {
      headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=30" },
    });
  } catch (error) {
    console.error("onboarding_template_error", { errorCode: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "onboarding_template_unavailable" }, { status: 503 });
  }
}
