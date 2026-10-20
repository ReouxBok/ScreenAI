"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function SavFilingProgress({ threadId, commandId }: { threadId: string; commandId: string }) {
  const router = useRouter(), [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>, attempts = 0;
    async function poll() {
      try {
        const response = await fetch(`/api/internal/sav/dossiers/${threadId}/status?filingId=${encodeURIComponent(commandId)}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("status unavailable");
        const { filing } = await response.json();
        if (filing && ["completed", "uncertain"].includes(filing.state)) {
          const url = new URL(window.location.href);
          url.searchParams.delete("filingId"); url.searchParams.set("filing", filing.notice);
          router.replace(url.pathname + url.search + url.hash, { scroll: false });
          return;
        }
      } catch { if (controller.signal.aborted) return; }
      if (++attempts < 100) timer = setTimeout(poll, 3000); else setTimedOut(true);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [threadId, commandId, router]);
  return <p className="login-notice" role="status">{timedOut ? "Le classement Gmail n’est pas confirmé. Le dossier reste consultable ; vérifiez le résultat avant de le considérer comme classé." : "Ouverture enregistrée. Classement Gmail en cours… Le dossier reste consultable."}</p>;
}
