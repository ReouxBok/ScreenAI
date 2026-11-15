"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Status } from "@/components/ui/primitives";
import { TextArea } from "@/components/ui/forms";
import { describeCaseReplyReview, type CaseReplyReviewOutcome } from "./case-replies";
import styles from "./v2.module.css";

type Mode = "idle" | "correct" | "decline";

/**
 * SAV-92: the three decisions an administrator may take on ONE proposed reply. The token is the version the page showed (reply, exact text, case version):
 * the server refuses anything that moved since, and its registry sends at most one reply per mail. Nothing is retried by this component.
 */
export function ReplyReviewPanel({ token, body, sensitive }: { token: string; body: string; sensitive: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [text, setText] = useState(body);
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<CaseReplyReviewOutcome | null>(null);
  const [pending, startTransition] = useTransition();
  const done = outcome?.ok === true || Boolean(outcome?.approvedValidationId) || outcome?.code === "review_unconfirmed";

  const send = (payload: Record<string, string>) => startTransition(async () => {
    setOutcome(null);
    let result: CaseReplyReviewOutcome;
    try {
      const response = await fetch("/api/internal/sav/v2/replies/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...payload }) });
      const data = await response.json().catch(() => null) as CaseReplyReviewOutcome | { error?: string } | null;
      result = data && "ok" in data ? data : { ok: false, code: response.status === 403 ? "forbidden" : "review_unconfirmed" };
    } catch { result = { ok: false, code: "review_unconfirmed" }; }
    setOutcome(result);
    if (result.ok || result.approvedValidationId) { setMode("idle"); router.refresh(); }
  });
  const shown = outcome ? (outcome.code === "forbidden" ? { tone: "danger" as const, text: "Action réservée aux administrateurs du Studio. Rien n’a été envoyé." } : describeCaseReplyReview(outcome)) : null;

  return <div className={styles.seam} id="v2-review">
    <h4>Décision de l’administrateur</h4>
    {sensitive ? <p><Status tone="warning">Dossier sensible : aucun envoi depuis ce bouton.</Status> Seul le refus, qui confie le dossier à l’équipe, est possible.</p>
      : <p>Valider envoie exactement le texte ci-dessus, par le même registre que l’envoi automatique : une seule réponse par mail, jamais de renvoi automatique.</p>}
    {shown ? <p role={shown.tone === "success" ? "status" : "alert"}><Status tone={shown.tone}>{shown.text}</Status></p> : null}
    {done ? null : <>
      {mode === "idle" ? <div className={styles.filters}>
        {sensitive ? null : <>
          <Button variant="primary" busy={pending} onClick={() => send({ action: "approve" })}>Approuver et envoyer</Button>
          <Button disabled={pending} onClick={() => { setMode("correct"); setOutcome(null); }}>Corriger puis envoyer</Button>
        </>}
        <Button variant="danger" disabled={pending} onClick={() => { setMode("decline"); setOutcome(null); }}>Refuser</Button>
      </div> : null}
      {mode === "correct" ? <form onSubmit={event => { event.preventDefault(); send({ action: "correct", text }); }}>
        <label htmlFor="v2-review-text"><strong>Texte corrigé</strong></label>
        <p className={styles.small}>La ligne d’aide, la signature et la mention IA (« rédigée avec l’aide de notre agent IA ») sont ajoutées automatiquement. Le texte repasse par les contrôles de l’envoi automatique avant tout envoi.</p>
        <TextArea id="v2-review-text" rows={12} maxLength={6000} value={text} onChange={event => setText(event.target.value)} required/>
        <div className={styles.filters}>
          <Button type="submit" variant="primary" busy={pending}>Envoyer le texte corrigé</Button>
          <Button disabled={pending} onClick={() => { setMode("idle"); setText(body); }}>Annuler</Button>
        </div>
      </form> : null}
      {mode === "decline" ? <form onSubmit={event => { event.preventDefault(); send({ action: "decline", reason }); }}>
        <label htmlFor="v2-review-reason"><strong>Motif du refus</strong></label>
        <p className={styles.small}>Rien n’est envoyé au client. Le dossier passe à l’équipe ; le motif est conservé dans le journal d’administration.</p>
        <TextArea id="v2-review-reason" rows={3} minLength={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} required/>
        <div className={styles.filters}>
          <Button type="submit" variant="danger" busy={pending}>Refuser et confier à l’équipe</Button>
          <Button disabled={pending} onClick={() => setMode("idle")}>Annuler</Button>
        </div>
      </form> : null}
    </>}
  </div>;
}
