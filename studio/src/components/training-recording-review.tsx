type RecordingSession = {
  id: string;
  recordingStatus: string;
  recordingPathname: string | null;
  recordingSizeBytes: number | null;
  recordingDurationMs: number | null;
  recordingUploadedAt: Date | string | null;
};

function formatDuration(milliseconds: number | null) {
  const seconds = Math.max(0, Math.round((milliseconds ?? 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatSize(bytes: number | null) {
  if (!bytes) return "Taille inconnue";
  return `${(bytes / 1024 / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;
}

export function TrainingRecordingReview({ session, context = "training" }: { session: RecordingSession; context?: "training" | "validation" }) {
  const ready = session.recordingStatus === "ready" && Boolean(session.recordingPathname);
  return <section className={`recording-proof card ${ready ? "ready" : "pending"}`} aria-labelledby={`recording-title-${session.id}`}>
    <div className="recording-proof-heading">
      <div>
        <span className="eyebrow">{context === "validation" ? "Preuve de démonstration" : "Écran du formateur"}</span>
        <h2 id={`recording-title-${session.id}`}>{ready ? "Revoir le flow exactement comme il a été réalisé" : "Vidéo complète requise"}</h2>
        <p>{ready
          ? "La vidéo permet de vérifier les fenêtres, modales et transitions qui ne figurent pas toujours dans le DOM. Les événements structurés restent la référence pour les actions de Charly."
          : "Le parcours ne pourra pas être finalisé tant que l’enregistrement de l’écran entier n’aura pas été envoyé."}</p>
      </div>
      {ready && <div className="recording-meta" aria-label="Informations sur la vidéo"><strong>{formatDuration(session.recordingDurationMs)}</strong><span>{formatSize(session.recordingSizeBytes)}</span></div>}
    </div>
    {ready ? <div className="recording-frame">
      <video controls preload="metadata" playsInline controlsList="nodownload" src={`/api/studio/training-recordings/${session.id}`}>
        Votre navigateur ne peut pas lire cette vidéo.
      </video>
    </div> : <div className="recording-empty"><span aria-hidden="true">●</span><p>Ouvrez l’extension, démarrez l’entraînement et sélectionnez <strong>Écran entier</strong> dans le sélecteur Chrome.</p></div>}
    {ready && session.recordingUploadedAt && <small className="recording-date">Enregistrement reçu le {new Date(session.recordingUploadedAt).toLocaleString("fr-FR")}</small>}
  </section>;
}
