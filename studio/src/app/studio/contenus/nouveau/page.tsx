import Link from "next/link";
import { ContentForm } from "@/components/content-form";
import { requireStaff } from "@/lib/auth";
export default async function NewContentPage({searchParams}:{searchParams:Promise<{type?:string}>}) {
  const staff = await requireStaff(); const {type:rawType}=await searchParams; const type=rawType === "onboarding" ? "onboarding" : "article";
  return <><span className="eyebrow">Nouveau contenu</span><h1 className="page-title">Donner un nouveau repère à Charly</h1><div className="actions"><Link className={`button ${type==="article"?"primary":"secondary"}`} href="/studio/contenus/nouveau?type=article">Article</Link><Link className={`button ${type==="onboarding"?"primary":"secondary"}`} href="/studio/contenus/nouveau?type=onboarding">Parcours</Link></div><div style={{height:18}}/><div className="editor-layout"><section className="editor-card card"><ContentForm defaults={{ ownerEmail: staff.email, type }}/></section><aside className="publication-rail card"><span className="eyebrow">Publication</span><div style={{height:18}}/><div className="rail-step active">Brouillon</div><div className="rail-step">À valider</div><div className="rail-step">Publié</div><div className="rail-step">Archivé</div></aside></div></>;
}
