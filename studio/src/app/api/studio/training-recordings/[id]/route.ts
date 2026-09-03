import { get } from "@vercel/blob";
import { NextResponse } from "next/server";
import { requireApiStaff } from "@/lib/auth";
import { getManageableTraining } from "@/lib/training";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const staff = await requireApiStaff();
    const { id } = await context.params;
    const detail = await getManageableTraining(id, staff);
    const pathname = detail?.session.recordingPathname;
    if (!pathname || detail.session.recordingStatus !== "ready") return new NextResponse("Vidéo introuvable", { status: 404 });

    const forwardedHeaders: Record<string, string> = {};
    const range = request.headers.get("range");
    if (range) forwardedHeaders.Range = range;
    const result = await get(pathname, {
      access: "private",
      ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
      headers: forwardedHeaders,
    });
    if (!result) return new NextResponse("Vidéo introuvable", { status: 404 });
    if (result.statusCode === 304) {
      return new NextResponse(null, { status: 304, headers: { ETag: result.blob.etag, "Cache-Control": "private, no-cache" } });
    }

    const headers = new Headers({
      "Content-Type": result.blob.contentType || detail.session.recordingContentType || "video/webm",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-cache",
      ETag: result.blob.etag,
      "Accept-Ranges": result.headers.get("accept-ranges") || "bytes",
    });
    for (const name of ["content-length", "content-range"]) {
      const value = result.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new NextResponse(result.stream, { status: result.statusCode, headers });
  } catch {
    return new NextResponse("Non autorisé", { status: 401 });
  }
}
