"use client";
import { useState, useTransition } from "react";
import { prepareDiagnosticPage } from "./actions";
export function EnrichmentButton({ after, canManage }: { after?: string; canManage: boolean }) {
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  return <><button disabled={!canManage || pending} onClick={() => startTransition(async () => {
    const totals = { prepared: 0, preserved: 0, review_required: 0 };
    let cursor = after;
    const visited = new Set<string>();
    try {
      do {
        if (cursor && visited.has(cursor)) throw new Error("CURSOR_REPEATED");
        if (cursor) visited.add(cursor);
        const result = await prepareDiagnosticPage(cursor);
        for (const row of result.results) totals[row.status]++;
        cursor = result.next ?? undefined;
        setMessage(`${totals.prepared} brouillons préparés ; ${totals.preserved} brouillons existants conservés ; ${totals.review_required} fiches à vérifier.${cursor ? " Préparation des fiches suivantes…" : " Préparation terminée. Retrouvez les brouillons dans Propositions humaines."}`);
      } while (cursor);
    } catch { setMessage(`Préparation interrompue après ${totals.prepared} brouillons. Les brouillons enregistrés sont conservés. Vous pouvez reprendre sans les dupliquer.`); }

  })}>{pending ? "Préparation…" : after ? "Préparer les fiches à partir de cette page" : "Préparer toutes les fiches actives"}</button>{message && <p role="status">{message}</p>}</>;
}
