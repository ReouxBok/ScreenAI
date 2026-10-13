import { saveContentAction } from "@/app/studio/actions";
import { CATEGORIES } from "@/lib/content";
import { AGENTS } from "@/lib/agents";
import { MarkdownEditor } from "./markdown-editor";

type Defaults = { id?: string; type?: "article" | "onboarding"; slug?: string; title?: string; summary?: string; categorySlug?: string; agentKey?: string; visibility?: "charly_only" | "charly_and_help"; ownerEmail: string; bodyMarkdown?: string; metadata?: Record<string, unknown> };
const join = (value: unknown) => Array.isArray(value) ? value.join("\n") : "";

export function ContentForm({ defaults }: { defaults: Defaults }) {
  const meta = defaults.metadata ?? {};
  const type = defaults.type ?? "article";
  const resolution = (meta.resolution ?? {}) as Record<string, unknown>;
  const source = ((meta.sourceMetadata as Record<string, unknown> | undefined)?.editorialSource ?? {}) as Record<string, unknown>;
  const tutorialSource = meta.sourceMetadata as Record<string, unknown> | undefined;
  const fromTutorial = tutorialSource?.importKind === "onboarding_catalog";
  return <form id="content-editor-form" action={saveContentAction}>
    <input type="hidden" name="itemId" value={defaults.id ?? ""}/>
    <input type="hidden" name="type" value={type}/>
    <input type="hidden" name="sourceMetadata" value={JSON.stringify(meta.sourceMetadata ?? {})}/>
    {type === "onboarding" && <><input type="hidden" name="branches" value={JSON.stringify(meta.branches ?? [])}/><input type="hidden" name="actionSteps" value={JSON.stringify(meta.actionSteps ?? [])}/></>}
    <div className="form-grid">
      <div className="field"><label htmlFor="type">Type</label><select id="type" defaultValue={type} disabled><option value="article">Article</option><option value="onboarding">Parcours d’onboarding</option></select></div>
      <div className="field"><label htmlFor="agentKey">Agent concerné</label><select id="agentKey" name="agentKey" disabled={fromTutorial} defaultValue={fromTutorial ? "sav" : defaults.agentKey ?? "charly"}>{AGENTS.map(agent=><option key={agent.key} value={agent.key}>{agent.name} · {agent.role}</option>)}</select>{fromTutorial && <input type="hidden" name="agentKey" value="sav"/>}</div>
    </div>
    <div className="field"><label htmlFor="title">Titre</label><input id="title" name="title" required readOnly={fromTutorial} defaultValue={fromTutorial ? String(tutorialSource?.sourceTitle ?? defaults.title ?? "") : defaults.title}/>{fromTutorial && <p>Le titre reste celui du tutoriel source. Cette connaissance est réservée au SAV.</p>}</div>
    <div className="form-grid">
      <div className="field"><label htmlFor="slug">Slug stable</label><input id="slug" name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" readOnly={Boolean(defaults.id)} defaultValue={defaults.slug}/></div>
      <div className="field"><label htmlFor="category">Catégorie</label><select id="category" name="categorySlug" defaultValue={defaults.categorySlug ?? CATEGORIES[0][0]}>{CATEGORIES.map(([slug,label]) => <option key={slug} value={slug}>{label}</option>)}</select></div>
    </div>
    <div className="field"><label htmlFor="summary">Résumé</label><textarea id="summary" name="summary" required defaultValue={defaults.summary}/></div>
    <div className="form-grid">
      <div className="field"><label htmlFor="intents">Intentions / signaux (une ligne chacun)</label><textarea id="intents" name={type === "onboarding" ? "proposalSignals" : "intents"} defaultValue={join(meta.intents ?? meta.proposalSignals)}/></div>
      <div className="field"><label htmlFor="paths">Pages Limova (une ligne chacune)</label><textarea id="paths" name={type === "onboarding" ? "expectedPages" : "limovaPaths"} defaultValue={join(meta.limovaPaths ?? meta.expectedPages)}/></div>
    </div>
    {type === "onboarding" ? <>
      <div className="field"><label htmlFor="objective">Objectif</label><input id="objective" name="objective" defaultValue={String(meta.objective ?? "")}/></div>
      <div className="field"><label htmlFor="qualificationQuestions">Questions de qualification</label><textarea id="qualificationQuestions" name="qualificationQuestions" defaultValue={join(meta.qualificationQuestions)}/></div>
      <div className="field"><label htmlFor="successCriteria">Critères de réussite</label><textarea id="successCriteria" name="successCriteria" defaultValue={join(meta.successCriteria)}/></div>
      <div className="field"><label htmlFor="fallbacks">Solutions de repli</label><textarea id="fallbacks" name="fallbacks" defaultValue={join(meta.fallbacks)}/></div>
    </> : <>
      <div className="field"><label htmlFor="prerequisites">Prérequis</label><textarea id="prerequisites" name="prerequisites" defaultValue={join(meta.prerequisites)}/></div>
      <div className="field"><label htmlFor="expectedResult">Résultat attendu</label><textarea id="expectedResult" name="expectedResult" defaultValue={String(meta.expectedResult ?? "")}/></div>
      <div className="field"><label htmlFor="troubleshooting">Dépannage</label><textarea id="troubleshooting" name="troubleshooting" defaultValue={String(meta.troubleshooting ?? "")}/></div>
      {defaults.agentKey === "sav" && <fieldset>
        <legend>Conditions d’utilisation de la connaissance SAV</legend>
        <p>Précisez les demandes auxquelles cette fiche répond et la conduite à tenir. L’enregistrement prépare une version privée ; l’utilisation par l’agent nécessite une publication et une activation distinctes.</p>
        <input type="hidden" name="savResolution" value="on"/>
        <div className="field"><label htmlFor="savAudience">Public concerné</label><select id="savAudience" name="savAudience" defaultValue={String(resolution.audience ?? "support")}><option value="support">Client demandant du support</option><option value="lead">Lead demandant des informations produit avant achat</option></select></div>
        <div className="field"><label htmlFor="savResponseTemplate">Modèle de réponse pour un lead (sans signature)</label><textarea id="savResponseTemplate" name="savResponseTemplate" maxLength={8000} defaultValue={String(resolution.responseTemplate ?? "")}/><p>Requis pour un lead. La signature Charly et la mention IA sont ajoutées uniquement à l’envoi humain.</p></div>
        <div className="field"><label htmlFor="savSymptoms">Demandes concernées (une ligne chacune)</label><textarea id="savSymptoms" name="savSymptoms" required defaultValue={join(resolution.symptoms)}/></div>
        <div className="field"><label htmlFor="savSteps">Conduite à tenir (une ligne par étape)</label><textarea id="savSteps" name="savSteps" required defaultValue={join(resolution.steps)}/></div>
        <div className="field"><label htmlFor="savExceptions">Exceptions (une ligne chacune)</label><textarea id="savExceptions" name="savExceptions" defaultValue={join(resolution.exceptions)}/></div>
        <div className="field"><label htmlFor="savEscalation">Quand demander une qualification humaine</label><textarea id="savEscalation" name="savEscalation" required minLength={3} defaultValue={String(resolution.escalation ?? meta.troubleshooting ?? "")}/></div>
        <div className="form-grid">
          <div className="field"><label htmlFor="savProductVersion">Version du produit (facultatif)</label><input id="savProductVersion" name="savProductVersion" defaultValue={String(resolution.productVersion ?? "")}/></div>
          <div className="field"><label htmlFor="savValidUntil">Valable jusqu’au (facultatif)</label><input id="savValidUntil" name="savValidUntil" type="date" defaultValue={String(resolution.validUntil ?? "")}/></div>
        </div>
        <div className="field"><label htmlFor="savSourceReference">Source du contenu fourni</label><textarea id="savSourceReference" name="savSourceReference" required minLength={3} maxLength={1000} defaultValue={String(source.reference ?? "")}/></div>
        <div className="field"><label htmlFor="savSourceDate">Date du contenu fourni</label><input id="savSourceDate" name="savSourceDate" type="date" required defaultValue={String(source.suppliedOn ?? "")}/></div>
      </fieldset>}
    </>}
    <div className="field"><label>Contenu</label><MarkdownEditor name="bodyMarkdown" initialValue={defaults.bodyMarkdown ?? "## Objectif\n\nDécrivez ici ce que le membre Limova doit accomplir.\n\n## Étapes\n\n1. Première étape\n2. Deuxième étape"}/></div>
    <input type="hidden" name="ownerEmail" value={defaults.ownerEmail}/>
    <div className="field"><label htmlFor="note">Commentaire de modification</label><input id="note" name="changeNote" required placeholder="Pourquoi cette modification ?"/></div>
    <button className="primary" type="submit">{defaults.id ? "Enregistrer la mise à jour" : "Enregistrer le brouillon"}</button>
  </form>;
}
