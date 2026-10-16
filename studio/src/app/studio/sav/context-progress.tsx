"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function SavContextProgress({ threadId, requestId }: { threadId:string; requestId:string }) {
  const router = useRouter();
  const [state,setState] = useState("pending");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>, stopped = false, attempts=0;
    const controller = new AbortController();
    async function poll() {
      if (stopped) return;
      try {
        const response = await fetch(`/api/internal/sav/dossiers/${threadId}/status?refreshId=${encodeURIComponent(requestId)}`,{ cache:"no-store",signal:controller.signal });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (data.context === "completed" || data.context === "failed") {
          setState(data.context);
          const url = new URL(window.location.href); url.searchParams.delete("refreshId"); url.searchParams.set("context",data.context === "completed" ? "refreshed" : "failed");
          router.replace(url.pathname+url.search+url.hash,{ scroll:false }); return;
        }
      } catch { if (controller.signal.aborted) return; }
      if (++attempts < 100) timer = setTimeout(poll,3000); else setState("timeout");
    }
    void poll();
    return () => { stopped=true;controller.abort();clearTimeout(timer); };
  },[threadId,requestId,router]);
  return <p className="login-notice" role="status">{state === "pending" ? "Actualisation du contexte client en cours… Le dossier reste consultable." : state === "completed" ? "Contexte client actualisé." : "Contexte non confirmé. Utilisez Actualiser le contexte client pour reprendre."}</p>;
}
