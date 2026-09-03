import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isDevelopmentAuthBypass =
  process.env.NODE_ENV !== "production" && process.env.DEV_AUTH_BYPASS === "true";

// The isolated E2E server deliberately has no Clerk tenant. Keep the bypass
// development-only so a production build can never disable Clerk by accident.
export default isDevelopmentAuthBypass
  ? () => NextResponse.next()
  : clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|\\.well-known/workflow/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
