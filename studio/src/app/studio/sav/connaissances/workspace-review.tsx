"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CanonicalKnowledge } from "@/lib/knowledge/contracts";
import { KnowledgeDocument } from "./knowledge-document";
import { KnowledgeEditor, cleanKnowledgeDocument } from "./knowledge-editor";
import { activateKnowledgeWorkspaceAction, previewKnowledgeReviewAction, publishKnowledgeWorkspaceAction, reviewKnowledgeWorkspaceAction, startKnowledgeRevisionAction } from "./workspace-actions";
import styles from "./workspace.module.css";

type ReviewPreview = NonNullable<Awaited<ReturnType<typeof previewKnowledgeReviewAction>>["preview"]>;
export function KnowledgeWorkspaceReview({ candidateId, revisionId, initialDocument }: { candidateId: string; revisionId: string; initialDocument: CanonicalKnowledge }) {
  const router = useRouter();
  const [document, setDocument] = useState(initialDocument);
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, startTransition] = useTransition();
  const lock = useRef(false);
  function run(operation: () => Promise<void>) { if (lock.current) return; lock.current = true; startTransition(async () => { setError(""); try { await operation(); } catch { setError("La décision n’a pas pu être enregistrée. Vos corrections sont conservées."); } finally { lock.current = false; } }); }
  function decide(decision: "approve" | "reject" | "needs_completion") { run(async () => {
    if (!preview && decision === "approve") return;
    const result = await reviewKnowledgeWorkspaceAction({ candidateId, expectedRevisionId: revisionId, snapshot: preview?.snapshot ?? "", decision, reason, document: cleanKnowledgeDocument(document) });
    if (!result.success) { setError(result.error ?? "Décision non enregistrée."); setPreview(null); setAcknowledged(false); return; }
    router.refresh();
  }); }
  return <section className={styles.panel} aria-label="Revue de la proposition">
    <h2>Relire et décider</h2><p className={styles.subtle}>Une correction conserve l’origine de la proposition. La validation prépare une version ; publication et activation restent deux actions distinctes d’Ugo.</p>
    <details><summary>Corriger la proposition</summary><KnowledgeEditor disabled={busy} document={document} onChange={next => { setDocument(next); setPreview(null); setAcknowledged(false); }}/></details>
    <button className="secondary" disabled={busy} onClick={() => run(async () => { setPreview(null); setAcknowledged(false); const result = await previewKnowledgeReviewAction(candidateId, cleanKnowledgeDocument(document)); setPreview(result.preview); setError(result.error ?? ""); })}>{busy ? "Vérification…" : "Vérifier les sources et comparer"}</button>
    {preview && <section aria-live="polite"><h3>Comparaison courante</h3><p>La version active et les sources seront revérifiées lors de la décision.</p>
      <div className={styles.comparison}><section><h3>Version active conservée</h3><pre className={styles.text}>{preview.activeVersion?.body ?? "Aucune version active."}</pre></section><section><h3>Proposition corrigée</h3><KnowledgeDocument document={cleanKnowledgeDocument(document)}/></section></div>
      {preview.missing.length > 0 && <ul className={styles.alert}>{preview.missing.map(entry => <li key={entry}>{entry}</li>)}</ul>}
      {preview.comparison.map(finding => <details key={`${finding.ref}:${finding.versionId}`}><summary>{finding.title} · {finding.signal === "duplicate" ? "Doublon possible" : "Sujet proche"}</summary><p>{finding.explanation}</p><pre className={styles.text}>{finding.body}</pre></details>)}
      <label className={styles.choice}><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)}/>J’ai vérifié les sources, la version active et les différences de cette proposition.</label>
    </section>}
    <label className={styles.editor}>Motif de la décision<textarea value={reason} maxLength={2000} minLength={10} disabled={busy} onChange={event => setReason(event.target.value)}/></label>
    <div className={styles.row}><button className="primary" disabled={busy || !preview || !acknowledged || reason.trim().length < 10 || Boolean(preview?.missing.length)} onClick={() => decide("approve")}>{busy ? "Enregistrement…" : "Valider la proposition"}</button>
      <button className="secondary" disabled={busy || reason.trim().length < 10} onClick={() => decide("needs_completion")}>Demander un complément</button>
      <button className="secondary" disabled={busy || reason.trim().length < 10} onClick={() => decide("reject")}>Écarter avec ce motif</button></div>
    {error && <p className={`${styles.alert} ${styles.error}`} role="alert">{error}</p>}
  </section>;
}

export function KnowledgePublication({ itemId, proposedVersionId, publishedVersionId, activeVersionId, canPublish, canActivate, title }: { itemId: string; proposedVersionId: string | null; publishedVersionId: string | null; activeVersionId: string | null; canPublish: boolean; canActivate: boolean; title: string }) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState<"publish" | "activate" | null>(null);
  const [error, setError] = useState("");
  const [busy, startTransition] = useTransition();
  const lock = useRef(false);
  function confirm() {
    if (lock.current || !confirmation) return;
    lock.current = true;
    startTransition(async () => { setError(""); try {
      const result = confirmation === "publish" && proposedVersionId ? await publishKnowledgeWorkspaceAction({ itemId, expectedVersionId: proposedVersionId })
        : confirmation === "activate" && publishedVersionId ? await activateKnowledgeWorkspaceAction({ itemId, expectedPublishedVersionId: publishedVersionId, expectedActiveVersionId: activeVersionId }) : null;
      if (!result?.success) { setError(result?.error ?? "La version a changé. Rechargez la fiche."); return; }
      setConfirmation(null); router.refresh();
    } catch { setError("L’action n’a pas abouti. Vérifiez l’état courant avant de confirmer à nouveau."); } finally { lock.current = false; } });
  }
  return <section className={styles.panel} aria-label="Publication et activation"><h2>Publication et utilisation par l’agent</h2><p className={styles.subtle}>Ugo publie la version validée, puis décide séparément de son activation. La version active reste utilisée entre ces deux étapes.</p>
    <div className={styles.row}>{canPublish && <button className="secondary" disabled={busy} onClick={() => setConfirmation("publish")}>Publier la version validée</button>}{canActivate && <button className="primary" disabled={busy} onClick={() => setConfirmation("activate")}>Activer cette version pour le SAV</button>}</div>
    {confirmation && <div className={styles.alert} role="region" aria-label="Confirmer l’action sur la connaissance"><h3>{confirmation === "publish" ? "Confirmer la publication" : "Confirmer l’activation"} : {title}</h3><p>{confirmation === "publish" ? "La version sera publiée et indexée. La version utilisée par l’agent ne change pas à cette étape." : "La version publiée remplacera la version actuellement utilisée par l’agent SAV après vérification de son index."}</p><div className={styles.row}><button className="primary" disabled={busy} onClick={confirm}>{busy ? "Action en cours…" : confirmation === "publish" ? "Confirmer la publication" : "Confirmer l’activation"}</button><button className="secondary" disabled={busy} onClick={() => setConfirmation(null)}>Annuler</button></div></div>}
    {error && <p className={`${styles.alert} ${styles.error}`} role="alert">{error}</p>}
  </section>;
}

export function KnowledgeRevisionButton({ candidateId }: { candidateId: string }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState("");
  return <div><button className="secondary" disabled={busy} onClick={() => startTransition(async () => {
    setError("");
    try { const result = await startKnowledgeRevisionAction(candidateId); if (!result.draft) { setError(result.error ?? "La proposition ne peut pas être reprise."); return; }
      router.push(result.draft.status === "submitted" && result.draft.candidateId ? `/studio/sav/connaissances/${result.draft.candidateId}?kind=candidate` : `/studio/sav/connaissances/proposer?draft=${result.draft.id}`);
    } catch { setError("La proposition ne peut pas être reprise. Réessayez après avoir rechargé la fiche."); }
  })}>{busy ? "Préparation…" : "Compléter la proposition et ses sources"}</button>{error && <p className={styles.alert} role="alert">{error}</p>}</div>;
}
