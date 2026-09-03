import { OnboardingTemplateEditor } from "@/components/onboarding-template-editor";
import { isDatabaseConfigured } from "@/db";
import { getOnboardingTemplateEditorData, listTemplateContentOptions } from "@/lib/onboarding-template";
import { publishOnboardingTemplateAction } from "./actions";
import { canManageProduction } from "@/lib/access";
import { requireStaff } from "@/lib/auth";

export default async function OnboardingTemplatePage({ searchParams }: { searchParams: Promise<{ saved?: string; published?: string }> }) {
  const staff = await requireStaff();
  const params = await searchParams;
  const [data, options] = isDatabaseConfigured()
    ? await Promise.all([getOnboardingTemplateEditorData(), listTemplateContentOptions()])
    : [{ state: null, draft: null, published: null, history: [] }, []];
  const initialDefinition = data.draft?.definition;
  return <>
    <div className="page-intro compact"><div><span className="eyebrow">Trame d’onboarding</span><h1>Donnez un fil conducteur à Charly.</h1><p>Organisez les contenus validés dans l’ordre où Charly peut les proposer. Le membre garde toujours la liberté de poser une autre question ou de changer de direction.</p></div><div className="template-live-state"><span className={`status ${data.published ? "published" : "draft"}`}>{data.published ? `Version ${data.published.version} active` : "Aucune version active"}</span></div></div>
    {params.saved === "1" ? <p className="login-notice" role="status">Brouillon enregistré. La version actuellement publiée n’a pas changé.</p> : null}
    {params.published === "1" ? <p className="login-notice" role="status">La nouvelle trame est publiée. Charly l’utilisera dans les prochaines conversations.</p> : null}
    <OnboardingTemplateEditor options={options} initialDefinition={initialDefinition}/>
    {data.draft && canManageProduction(staff.role) ? <section className="template-publication card"><div><span className="eyebrow">Validation</span><h2>Publier le brouillon v{data.draft.version}</h2><p>Cette action remplace immédiatement la trame utilisée par le chat et la voix.</p></div><form action={publishOnboardingTemplateAction}><input type="hidden" name="versionId" value={data.draft.id}/><button className="primary">Valider et publier</button></form></section> : null}
    {data.history.length ? <section className="template-history"><div className="section-heading"><div><span className="eyebrow">Historique</span><h2>Versions enregistrées</h2></div></div><div className="table-wrap card"><table><thead><tr><th>Version</th><th>Auteur</th><th>Modification</th><th>Date</th><th>État</th></tr></thead><tbody>{data.history.toReversed().map((version) => <tr key={version.id}><td>v{version.version}</td><td>{version.authorEmail}</td><td>{version.changeNote}</td><td>{version.createdAt.toLocaleString("fr-FR")}</td><td>{data.published?.id === version.id ? <span className="status published">Active</span> : data.draft?.id === version.id ? <span className="status in_review">Brouillon actuel</span> : "—"}</td></tr>)}</tbody></table></div></section> : null}
  </>;
}
