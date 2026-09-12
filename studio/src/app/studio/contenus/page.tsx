import Link from "next/link";
import { setAiEnabledAction } from "@/app/studio/actions";
import { isDatabaseConfigured } from "@/db";
import { canEditContent } from "@/lib/access";
import { AGENTS } from "@/lib/agents";
import { requireStaff } from "@/lib/auth";
import { assessContentReadiness } from "@/lib/content-readiness";
import { curriculumSlug, LIMOVA_CURRICULUM } from "@/lib/limova-curriculum";
import { listContent } from "@/lib/workflow";

export const dynamic = "force-dynamic";

export default async function ContentPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const staff = await requireStaff();
  const rows = isDatabaseConfigured() ? await listContent() : [];
  const existingSlugs = new Set(rows.map(({ item }) => item.slug));
  const missingCount = LIMOVA_CURRICULUM.filter((entry) => !existingSlugs.has(curriculumSlug(entry.title))).length;
  const curriculumGroups = [...new Set(LIMOVA_CURRICULUM.map((entry) => entry.group))];
  const { deleted } = await searchParams;
  return <>
    {deleted === "1" && <p className="login-notice" role="status">Le contenu, ses versions et ses tests ont bien été supprimés.</p>}
    <div className="page-intro compact"><div><span className="eyebrow">Bibliothèque de Charly</span><h1>Les connaissances, rangées par agent</h1><p>{rows.length} contenus internes. Le toggle « Agent IA » détermine si une version publiée peut être utilisée dans les réponses de l’agent.</p></div><Link className="button primary" href="/studio/contenus/nouveau">Créer un contenu</Link></div>
    <section className="curriculum-coverage card">
      <header><div><span className="eyebrow">Couverture issue du code Limova</span><h2>{LIMOVA_CURRICULUM.length - missingCount}/{LIMOVA_CURRICULUM.length} parcours repérés</h2></div><strong>{missingCount} à créer ou rapprocher</strong></header>
      <p>Ces propositions restent des brouillons tant que le staff n’a pas confirmé les règles métier, démontré les actions et réussi le test réel. Aucun contenu existant n’est supprimé.</p>
      {curriculumGroups.map((group) => {
        const entries = LIMOVA_CURRICULUM.filter((entry) => entry.group === group);
        return <details key={group}><summary>{group} · {entries.filter((entry) => existingSlugs.has(curriculumSlug(entry.title))).length}/{entries.length}</summary><ul>{entries.map((entry) => {
          const slug = curriculumSlug(entry.title); const exists = existingSlugs.has(slug);
          const query = new URLSearchParams({ type:"onboarding", title:entry.title, slug, agentKey:entry.agentKey, category:entry.categorySlug, paths:entry.paths.join("|") });
          return <li key={slug}><span>{exists ? "✓" : "+"}</span><strong>{entry.title}</strong>{exists ? <small>Présent dans la bibliothèque</small> : <Link href={`/studio/contenus/nouveau?${query}`}>Préremplir le brouillon</Link>}</li>;
        })}</ul></details>;
      })}
    </section>
    <div className="agent-groups">{AGENTS.map((agent) => {
      const items = rows.filter(({ item }) => item.agentKey === agent.key);
      if (!items.length) return null;
      const published = items.filter(({ item }) => item.status === "published").length;
      return <section className="agent-group card" key={agent.key} id={agent.key}>
        <header><span className="agent-monogram" style={{ background: agent.color }}>{agent.name[0]}</span><div><h2>{agent.name}</h2><p>{agent.role}</p></div><span className="mastery">{published}/{items.length} validés</span></header>
        <div className="agent-content-list">{items.map(({ item, category, metadata }) => {
          const toggleAllowed = canEditContent(staff.role, item.publishedVersionId);
          const readiness = assessContentReadiness({
            type: item.type,
            metadata: (metadata ?? {}) as Record<string, unknown>,
            itemSourcePath: item.sourcePath,
          });
          return <article className="content-library-row" key={item.id}>
            <Link href={`/studio/contenus/${item.id}`}>
              <span><strong>{item.title}</strong><small>{category?.label ?? "Sans catégorie"} · Créé par {item.ownerEmail}</small></span>
              <span className="content-row-state"><span className={`status ${item.status}`}>{item.status === "published" ? "Validé" : item.status === "in_review" ? "À valider" : item.status === "draft" ? "Brouillon" : "Archivé"}</span><small>{readiness.completed}/{readiness.total} renseignés</small></span>
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
