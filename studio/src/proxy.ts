import { clerkMiddleware } from "@clerk/nextjs/server";
import { synPreviewEnabled, synRequestAuthorized } from "./lib/sav/local-syn";
import { NextResponse, type NextRequest } from "next/server";

const isDevelopmentAuthBypass =
  process.env.NODE_ENV !== "production" && process.env.DEV_AUTH_BYPASS === "true";

// The isolated E2E server deliberately has no Clerk tenant. Keep the bypass
// development-only so a production build can never disable Clerk by accident.
export default process.env.SAV_SYN_PREVIEW === "true"
  ? (request: NextRequest) => {
    if (!synPreviewEnabled()) return new NextResponse("SYN configuration refusée", { status: 503 });
    if (!synRequestAuthorized(request.headers)) return new NextResponse("Session SYN requise", { status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Studio SYN local"', "Cache-Control": "no-store" } });
    if (!["GET", "HEAD"].includes(request.method)) return new NextResponse("SYN en lecture seule", { status: 405 });
    return NextResponse.next();
  }
  : isDevelopmentAuthBypass
  ? () => NextResponse.next()
  : clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|\\.well-known/workflow/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
