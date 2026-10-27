"use client";

import { SpeedInsights } from "@vercel/speed-insights/next";
import { sanitizeStudioVital } from "@/lib/speed-insights";

export function StudioSpeedInsights() {
  return <SpeedInsights beforeSend={sanitizeStudioVital} debug={false} />;
}
