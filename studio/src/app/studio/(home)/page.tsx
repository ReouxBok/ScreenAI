import Link from "next/link";
import { isDatabaseConfigured } from "@/db";
import { listContent } from "@/lib/workflow";
import { listTrainings } from "@/lib/training";
import { AGENTS } from "@/lib/agents";
import { canCreateTraining } from "@/lib/access";
import { requireStaff } from "@/lib/auth";
export const dynamic = "force-dynamic";
export default async function DashboardPage() {
  const staff = await requireStaff();
  const [rows,trainings] = isDatabaseConfigured() ? await Promise.all([listContent(),listTrainings()]) : [[],[]];
  const counts = { draft: 0, in_review: 0, published: 0, stale: 0 };
  for (const { item, stale } of rows) { if (item.status !== "archived") counts[item.status] += 1; if (stale) counts.stale += 1; }
  return <><div className="dashboard-hero"><div><span className="eyebrow">Vue d’ensemble</span><h1>Apprenez à Charly comme à une nouvelle collègue.</h1><p>Écrivez ce qu’elle doit savoir, montrez-lui les gestes dans Limova, puis vérifiez ses réponses avant publication.</p><div className="hero-actions">{canCreateTraining(staff.role) && <Link className="button primary" href="/studio/entrainements">Lancer un entraînement</Link>}<Link className="button secondary" href="/studio/contenus/nouveau">Écrire un contenu</Link></div></div><div className="mastery-orbit"><strong>{counts.published}</strong><span>connaissances<br/>maîtrisées</span></div></div>{!isDatabaseConfigured() && <div className="setup card"><strong>Configuration requise.</strong> Ajoutez Neon et Gemini dans les variables Vercel, puis lancez les migrations et l’import Markdown.</div>}<section className="workflow-strip"><article><span>1</span><strong>Écrire</strong><small>{counts.draft} brouillons</small></article><article><span>2</span><strong>Démontrer</strong><small>{trainings.filter(item=>item.status==="recording").length} en cours</small></article><article><span>3</span><strong>Valider</strong><small>{counts.in_review} à relire</small></article><article><span>4</span><strong>Vérifier</strong><small>{counts.stale} à actualiser</small></article></section><div className="section-heading"><div><span className="eyebrow">Maîtrise par agent</span><h2>Qui sait quoi ?</h2></div><Link href="/studio/contenus">Voir tous les contenus →</Link></div><div className="agent-overview">{AGENTS.map(agent=>{const items=rows.filter(({item})=>item.agentKey===agent.key);const valid=items.filter(({item})=>item.status==="published").length;return <Link className="agent-tile card" href={`/studio/contenus#${agent.key}`} key={agent.key}><span className="agent-monogram" style={{background:agent.color}}>{agent.name[0]}</span><strong>{agent.name}</strong><small>{valid}/{items.length} validés</small><div><i style={{width:`${items.length?Math.round(valid/items.length*100):0}%`,background:agent.color}}/></div></Link>})}</div></>;
}
