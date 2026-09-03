import Link from "next/link";
import { AGENTS, getAgent } from "@/lib/agents";
import { listTrainingSummaries } from "@/lib/training";
import { TrainingActions } from "@/components/training-actions";
import { requireStaff } from "@/lib/auth";
import { createTrainingAction } from "./actions";
export const dynamic = "force-dynamic";

const formatAddedAt = (date: Date) => new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Paris",
}).format(date);

export default async function TrainingsPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const staff = await requireStaff();
  const rows = await listTrainingSummaries(staff);
  const { deleted } = await searchParams;
  return <>
    <div className="page-intro"><div><span className="eyebrow">Apprentissage guidé</span><h1>Montrez à Charly comment faire</h1><p>Expliquez un processus à voix haute pendant que vous le réalisez dans Limova. Charly conservera les pages, clics et champs utilisés — jamais les valeurs saisies.</p></div></div>
    {deleted === "1" && <p className="login-notice" role="status">La démonstration et ses événements ont bien été supprimés.</p>}
    <div className="training-layout">
      <section className="card training-create"><span className="step-number">01</span><h2>Préparer une démonstration</h2><form action={createTrainingAction}><div className="field"><label htmlFor="training-title">Nom du parcours</label><input id="training-title" name="title" required placeholder="Créer une campagne LinkedIn"/></div><div className="field"><label htmlFor="training-goal">Ce que Charly doit apprendre</label><textarea id="training-goal" name="goal" required placeholder="Accompagner un utilisateur depuis le choix du super-pouvoir jusqu’au brouillon prêt à être relu."/></div><div className="form-grid"><div className="field"><label htmlFor="training-agent">Agent</label><select id="training-agent" name="agentKey">{AGENTS.filter(agent=>agent.key!=="common").map(agent=><option key={agent.key} value={agent.key}>{agent.name}</option>)}</select></div><div className="field"><label htmlFor="training-path">Page de départ</label><input id="training-path" name="startPath" defaultValue="/" placeholder="/super-powers"/></div></div><button className="primary" type="submit">Créer la démonstration</button></form></section>
      <section>
        <div className="section-heading"><div><span className="eyebrow">Historique</span><h2>{rows.length} démonstrations</h2></div></div>
        <div className="training-list">{rows.map(({ session, contentStatus }) => {
          const agent = getAgent(session.agentKey);
          const isNew = session.status !== "archived" && contentStatus !== "published";
          const isRecoverable = session.status === "recording" && session.recordingStatus === "ready";
          return <article className={`training-row card${isNew ? " is-new" : ""}`} key={session.id}>
            <span className="agent-dot" style={{background:agent.color}}/>
            <Link className="training-row-link" href={`/studio/entrainements/${session.id}`}>
              <span className="training-title-line"><strong>{session.title}</strong>{isNew && <span className="new-badge">Nouveau</span>}</span>
              <small>{agent.name} · {session.goal}</small>
              <time dateTime={session.createdAt.toISOString()}>Ajouté le {formatAddedAt(session.createdAt)}</time>
            </Link>
            <span className={`status ${isRecoverable ? "ready" : session.status}`}>{isRecoverable ? "À finaliser" : session.status === "draft" ? "À démarrer" : session.status === "recording" ? "En cours" : session.status === "ready" ? "À transformer" : session.status === "converted" ? "Convertie" : "Archivée"}</span>
            <TrainingActions sessionId={session.id} title={session.title} status={session.status} recordingStatus={session.recordingStatus} compact/>
          </article>;
        })}{rows.length===0&&<div className="empty card">Créez la première démonstration. L’extension vous guidera ensuite.</div>}</div>
      </section>
    </div>
  </>;
}
