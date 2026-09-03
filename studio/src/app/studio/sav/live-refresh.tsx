"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function SavLiveRefresh({ enabled, intervalMs = 5_000 }: { enabled: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => router.refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, router]);
  return enabled ? <span className="sr-only" role="status">L’analyse du batch est actualisée automatiquement.</span> : null;
}
