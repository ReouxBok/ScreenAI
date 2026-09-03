import Link from "next/link";
import { setAiEnabledAction } from "@/app/studio/actions";
import { isDatabaseConfigured } from "@/db";
import { canEditContent } from "@/lib/access";
import { AGENTS } from "@/lib/agents";
import { requireStaff } from "@/lib/auth";
import { listContent } from "@/lib/workflow";

export const dynamic = "force-dynamic";

export default async function ContentPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const staff = await requireStaff();
  const rows = isDatabaseConfigured() ? await listContent() : [];
  const { deleted } = await searchParams;
  return <>
    {deleted === "1" && <p className="login-notice" role="status">Le contenu, ses versions et ses tests ont bien été supprimés.</p>}
    <div className="page-intro compact"><div><span className="eyebrow">Bibliothèque de Charly</span><h1>Les connaissances, rangées par agent</h1><p>{rows.length} contenus internes. Le toggle « Agent IA » détermine si une version publiée peut être utilisée dans les réponses de l’agent.</p></div><Link className="button primary" href="/studio/contenus/nouveau">Créer un contenu</Link></div>
    <div className="agent-groups">{AGENTS.map((agent) => {
      const items = rows.filter(({ item }) => item.agentKey === agent.key);
      if (!items.length) return null;
      const published = items.filter(({ item }) => item.status === "published").length;
      return <section className="agent-group card" key={agent.key} id={agent.key}>
        <header><span className="agent-monogram" style={{ background: agent.color }}>{agent.name[0]}</span><div><h2>{agent.name}</h2><p>{agent.role}</p></div><span className="mastery">{published}/{items.length} validés</span></header>
        <div className="agent-content-list">{items.map(({ item, category }) => {
          const toggleAllowed = canEditContent(staff.role, item.publishedVersionId);
          return <article className="content-library-row" key={item.id}>
            <Link href={`/studio/contenus/${item.id}`}>
              <span><strong>{item.title}</strong><small>{category?.label ?? "Sans catégorie"} · Créé par {item.ownerEmail}</small></span>
              <span className={`status ${item.status}`}>{item.status === "published" ? "Validé" : item.status === "in_review" ? "À valider" : item.status === "draft" ? "Brouillon" : "Archivé"}</span>
            </Link>
            <form action={setAiEnabledAction} className="ai-toggle-form">
              <input type="hidden" name="itemId" value={item.id}/>
              <input type="hidden" name="enabled" value={String(!item.aiEnabled)}/>
              <button
                type="submit"
                role="switch"
                aria-checked={item.aiEnabled}
                className={`ai-toggle${item.aiEnabled ? " is-on" : ""}`}
                disabled={!toggleAllowed}
                title={toggleAllowed ? "Changer l’utilisation par l’agent IA" : "Réservé à l’administrateur pour un contenu en production"}
              ><span aria-hidden="true"/><strong>Agent IA</strong></button>
            </form>
          </article>;
        })}</div>
      </section>;
    })}</div>
  </>;
}
