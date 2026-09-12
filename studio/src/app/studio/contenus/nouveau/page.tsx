import Link from "next/link";
import { ContentForm } from "@/components/content-form";
import { requireStaff } from "@/lib/auth";
import { curriculumSlug, LIMOVA_CURRICULUM } from "@/lib/limova-curriculum";
import { buildOperationalJourney } from "@/lib/operational-journey";
export default async function NewContentPage({searchParams}:{searchParams:Promise<{type?:string;title?:string;slug?:string;agentKey?:string;category?:string;paths?:string}>}) {
  const staff = await requireStaff(); const params=await searchParams; const type=params.type === "onboarding" ? "onboarding" : "article";
  const fromCurriculum = type === "onboarding" && Boolean(params.title && params.slug);
  const curriculumEntry = fromCurriculum ? LIMOVA_CURRICULUM.find((entry) => curriculumSlug(entry.title) === params.slug) : undefined;
  const generated = curriculumEntry ? buildOperationalJourney(curriculumEntry) : undefined;
  return <><span className="eyebrow">Nouveau contenu</span><h1 className="page-title">Donner un nouveau repère à Charly</h1><div className="actions"><Link className={`button ${type==="article"?"primary":"secondary"}`} href="/studio/contenus/nouveau?type=article">Article</Link><Link className={`button ${type==="onboarding"?"primary":"secondary"}`} href="/studio/contenus/nouveau?type=onboarding">Parcours</Link></div><div style={{height:18}}/><div className="editor-layout"><section className="editor-card card"><ContentForm defaults={{ ownerEmail: staff.email, type, title:params.title, slug:params.slug, agentKey:params.agentKey, categorySlug:params.category, summary:generated?.summary, bodyMarkdown:generated?.bodyMarkdown, metadata:generated?.metadata }}/></section><aside className="publication-rail card"><span className="eyebrow">Publication</span><div style={{height:18}}/><div className="rail-step active">Brouillon</div><div className="rail-step">À valider</div><div className="rail-step">Publié</div><div className="rail-step">Archivé</div></aside></div></>;
}
