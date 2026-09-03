import Link from "next/link";
import { notFound } from "next/navigation";
import { AGENTS, getAgent } from "@/lib/agents";
import { getManageableTraining } from "@/lib/training";
import { compactTrainingEvents } from "@/lib/training-events";
import { TrainingActions } from "@/components/training-actions";
import { TrainingLiveProgress, type TrainingLiveSnapshot } from "@/components/training-live-progress";
import { updateTrainingAction } from "../actions";
import { requireStaff } from "@/lib/auth";
export const dynamic = "force-dynamic";

const formatAddedAt = (date: Date) => new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Europe/Paris",
}).format(date);

export default async function TrainingDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string; edit?: string; restarted?: string; updated?: string; recovered?: string }>;
}) {
  const staff = await requireStaff();
  const { id } = await params;
  const { token, edit, restarted, updated, recovered } = await searchParams;
  const detail = await getManageableTraining(id, staff);
  if (!detail) notFound();
  const agent = getAgent(detail.session.agentKey);
  const displayEvents = compactTrainingEvents(detail.events);
  const initialSnapshot: TrainingLiveSnapshot = {
    session: {
      id: detail.session.id,
      status: detail.session.status,
      contentItemId: detail.session.contentItemId,
      recordingStatus: detail.session.recordingStatus,
      recordingPathname: detail.session.recordingPathname ? "available" : null,
      recordingSizeBytes: detail.session.recordingSizeBytes,
      recordingDurationMs: detail.session.recordingDurationMs,
      recordingUploadedAt: detail.session.recordingUploadedAt?.toISOString() ?? null,
    },
    events: displayEvents.map((event) => ({
      id: event.id,
      ordinal: event.ordinal,
      kind: event.kind,
      path: event.path,
      label: event.label,
      payload: {
        controlType: event.payload.controlType ?? null,
        section: event.payload.section ?? null,
        testId: event.payload.testId ?? null,
        elementId: event.payload.elementId ?? null,
        role: event.payload.role ?? null,
      },
    })),
    rawEventCount: detail.events.length,
    revision: detail.session.updatedAt.toISOString(),
  };

  return <>
    <Link className="back-link" href="/studio/entrainements">← Toutes les démonstrations</Link>
    <div className="page-intro compact">
      <div><span className="eyebrow">{agent.name} · démonstration</span><h1>{detail.session.title}</h1><p>{detail.session.goal}</p><time className="training-added-at" dateTime={detail.session.createdAt.toISOString()}>Ajouté le {formatAddedAt(detail.session.createdAt)}</time></div>
      <div className="training-page-controls"><TrainingActions sessionId={id} title={detail.session.title} status={detail.session.status} recordingStatus={detail.session.recordingStatus}/></div>
    </div>
    {restarted === "1" && <p className="login-notice" role="status">Nouvel essai créé. La démonstration précédente reste disponible dans l’historique.</p>}
    {updated === "1" && <p className="login-notice" role="status">Le tutoriel a bien été modifié.</p>}
    {recovered === "1" && <p className="login-notice" role="status">La vidéo déjà reçue a été récupérée et la démonstration est maintenant finalisée.</p>}
    {edit === "1" && <section className="training-edit card">
      <div><span className="eyebrow">Administration</span><h2>Modifier ce tutoriel</h2><p>Les événements et la vidéo restent inchangés. Si ce tutoriel a déjà créé un parcours, ce parcours conserve sa propre version.</p></div>
      {detail.session.status === "recording" ? <p className="login-error" role="alert">Arrêtez l’enregistrement avant de modifier ce tutoriel.</p> : <form action={updateTrainingAction}>
        <input type="hidden" name="sessionId" value={id}/>
        <div className="field"><label htmlFor="edit-training-title">Nom du parcours</label><input id="edit-training-title" name="title" required defaultValue={detail.session.title}/></div>
        <div className="field"><label htmlFor="edit-training-goal">Ce que Charly doit apprendre</label><textarea id="edit-training-goal" name="goal" required defaultValue={detail.session.goal}/></div>
        <div className="form-grid">
          <div className="field"><label htmlFor="edit-training-agent">Agent</label><select id="edit-training-agent" name="agentKey" defaultValue={detail.session.agentKey}>{AGENTS.filter(item => item.key !== "common").map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></div>
          <div className="field"><label htmlFor="edit-training-path">Page de départ</label><input id="edit-training-path" name="startPath" required pattern="/(?!/).*" defaultValue={detail.session.startPath}/></div>
        </div>
        <div className="training-edit-actions"><button className="primary" type="submit">Enregistrer les modifications</button><Link className="button secondary" href={`/studio/entrainements/${id}`}>Annuler</Link></div>
      </form>}
    </section>}
    {token && <section className="training-launch card"><span className="step-number">02</span><div>
      <h2>Démarrer dans l’extension</h2>
      <p>Copiez ce code, ouvrez Limova puis choisissez <strong>Menu → Entraîner Charly</strong> dans l’extension.</p>
      <div className="training-code"><code>{token}</code></div>
      <p className="privacy-note">Le code expire dès que la démonstration est terminée. La vidéo enregistre tout ce qui est visible à l’écran ainsi que la voix du formateur : fermez vos notifications et ne montrez jamais de mot de passe, d’OTP ou de donnée personnelle.</p>
    </div></section>}
    <TrainingLiveProgress initialSnapshot={initialSnapshot}/>
  </>;
}
