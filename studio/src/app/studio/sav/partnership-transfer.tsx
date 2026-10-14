"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import styles from "./partnership-transfer.module.css";
import type { SavPartnershipPreview, SavPartnershipTransferState } from "@/lib/sav/partnership-forward";
import { confirmPartnershipTransferAction, preparePartnershipTransferAction } from "./partnership-actions";

function errorLabel(code: string) {
  if (code === "SAV_PARTNERSHIP_RECONCILIATION_REQUIRED") return "Le résultat de l’envoi est incertain. Vérifiez les messages envoyés avant toute nouvelle action ; aucun renvoi automatique ne sera effectué.";
  if (["SAV_PARTNERSHIP_PREVIEW_STALE", "SAV_PARTNERSHIP_CONTEXT_CHANGED", "SAV_GMAIL_THREAD_CHANGED", "SAV_PARTNERSHIP_PREVIEW_EXPIRED"].includes(code)) return "L’aperçu a expiré ou le dossier a changé. Actualisez le dossier puis préparez un nouvel aperçu.";
  if (code === "SAV_PARTNERSHIP_NOT_DETECTED" || code === "SAV_PARTNERSHIP_ANALYSIS_REQUIRED" || code === "SAV_PARTNERSHIP_REVIEW_REQUIRED") return "La détection du partenariat doit être réanalysée ou vérifiée avant le transfert.";
  if (code === "SAV_WRITES_DISABLED" || code === "SAV_PILOT_WRITE_BLOCKED") return "Les envois sont désactivés dans cet environnement.";
  if (code === "SAV_PARTNERSHIP_ALREADY_REQUESTED") return "Ce transfert a déjà été confirmé. Actualisez le dossier pour consulter son résultat.";
  return "Le transfert n’a pas été confirmé. Actualisez le dossier et vérifiez son état avant de réessayer.";
}

export function PartnershipTransfer({ threadId, state }: { threadId: string; state: SavPartnershipTransferState }) {
  const router = useRouter();
  const [preview, setPreview] = useState<SavPartnershipPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<"succeeded" | "pending" | "failed" | null>(null);
  const [pending, startTransition] = useTransition();
  if (state.status === "unavailable") return null;
  const completed = result === "succeeded" || state.status === "succeeded";
  const queued = result === "pending" || state.status === "pending";
  const uncertain = state.status === "uncertain" || error === "SAV_PARTNERSHIP_RECONCILIATION_REQUIRED";
  return <section className={`card ${styles.panel}`} aria-label="Transfert partenariat">
    <span className="eyebrow">Transfert interne</span><h2>Demande de partenariat</h2>
    <p>L’agent a identifié une demande de partenariat. Nathan gère ces demandes.</p>
    {completed ? <p role="status">Email transféré à nathan@limova.ai. Le client n’a pas été ajouté aux destinataires.</p>
      : queued ? <p role="status">Transfert confirmé, résultat en attente. Actualisez le dossier pour vérifier l’envoi.</p>
      : uncertain ? <p role="alert">{errorLabel("SAV_PARTNERSHIP_RECONCILIATION_REQUIRED")}</p>
      : <>
        {!preview ? <button type="button" className="primary" disabled={pending} onClick={() => startTransition(async () => {
          setError(null); setResult(null);
          const response = await preparePartnershipTransferAction(threadId);
          if (response.error) setError(response.error);
          else if (response.preview) setPreview(response.preview);
        })}>{pending ? "Préparation de l’aperçu…" : "Préparer le transfert à Nathan"}</button> : <div>
          <h4>Aperçu de l’email à envoyer</h4>
          <dl><dt>De</dt><dd>{preview.from}</dd><dt>À</dt><dd>{preview.to}</dd><dt>Objet</dt><dd>{preview.subject}</dd></dl>
          <pre className={styles.preview}>{preview.text}</pre>
          <p>Nouvel email adressé uniquement à Nathan, sans copie au client. Pièces jointes non incluses. Cet aperçu est valable 15 minutes.</p>
          {state.sendBlockedReason && <p role="status">Les envois sont désactivés dans cet environnement. Cet aperçu ne déclenche aucun envoi.</p>}
          <div className={styles.actions}>
            <button type="button" className="primary" disabled={pending || Boolean(state.sendBlockedReason)} onClick={() => startTransition(async () => {
              setError(null);
              const response = await confirmPartnershipTransferAction(preview.token);
              setResult(response.status); setPreview(null);
              if (response.error) setError(response.error);
              router.refresh();
            })}>{pending ? "Confirmation en cours…" : "Confirmer l’envoi à Nathan"}</button>
            <button type="button" className="secondary" disabled={pending} onClick={() => { setPreview(null); setError(null); }}>Annuler</button>
          </div>
        </div>}
        {error && <p role="alert">{errorLabel(error)}</p>}
      </>}
  </section>;
}
