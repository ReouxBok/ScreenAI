import Link from "next/link";
import { deleteTrainingAction, recoverTrainingAction, restartTrainingAction } from "@/app/studio/entrainements/actions";

export function TrainingActions({ sessionId, title, status, recordingStatus, compact = false }: {
  sessionId: string;
  title: string;
  status: string;
  recordingStatus: string;
  compact?: boolean;
}) {
  const controls = <>
    {status === "recording" && recordingStatus === "ready" ? <form action={recoverTrainingAction}>
      <input type="hidden" name="sessionId" value={sessionId}/>
      <button className={compact ? "training-menu-action" : "primary"} type="submit">Finaliser la démo récupérée</button>
    </form> : null}
    {status !== "recording" ? <Link className={compact ? "training-menu-action" : "button secondary"} href={`/studio/entrainements/${sessionId}?edit=1`}>
      Modifier
    </Link> : null}
    <form action={restartTrainingAction}>
      <input type="hidden" name="sessionId" value={sessionId}/>
      <button className={compact ? "training-menu-action" : "secondary"} type="submit" aria-label={compact ? `Recommencer ${title}` : undefined}>
        {compact ? "Recommencer" : "Recommencer cette démo"}
      </button>
    </form>
    <details className={compact ? "training-delete compact" : "training-delete"}>
      <summary>{compact ? "Supprimer…" : "Supprimer"}</summary>
      <div className="training-delete-panel">
        <p>La démonstration et ses événements seront supprimés définitivement. Un parcours déjà créé restera conservé.</p>
        <form action={deleteTrainingAction}>
          <input type="hidden" name="sessionId" value={sessionId}/>
          <button className="ghost-danger" type="submit" aria-label={`Confirmer la suppression de ${title}`}>Confirmer la suppression</button>
        </form>
      </div>
    </details>
  </>;

  if (compact) {
    return <details className="training-menu">
      <summary aria-label={`Gérer ${title}`}>Gérer</summary>
      <div className="training-menu-panel">{controls}</div>
    </details>;
  }

  return <div className="training-detail-actions">{controls}</div>;
}
