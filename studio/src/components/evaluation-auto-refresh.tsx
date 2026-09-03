"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function EvaluationAutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      if (Date.now() - startedAt > 30 * 60_000) {
        window.clearInterval(interval);
        return;
      }
      router.refresh();
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [active, router]);

  return null;
}
