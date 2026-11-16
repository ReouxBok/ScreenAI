import Link from "next/link";
import { readSavBlockBuilder, savBlockBuilderAdministrator } from "@/lib/sav/blocks/block-builder-admin";
import { exportSavBlockBriefMarkdown, SAV_BLOCK_BRIEF_QUESTIONS, savBlockBriefToDraft, validateSavBlockBrief } from "@/lib/sav/blocks/block-brief";
import { checkSavBlockLessons, SAV_BLOCK_LESSONS } from "@/lib/sav/blocks/lesson-controls";
import { saveBlockBriefAction } from "./actions";

export const dynamic = "force-dynamic";
export default async function BlockAssistantPage({ searchParams }: { searchParams: Promise<{ bloc?: string; result?: string }> }) {
  await savBlockBuilderAdministrator();
  const params = await searchParams;
  const brief = await readSavBlockBuilder(params.bloc ?? "nouveau-bloc");
  const validation = validateSavBlockBrief(brief), lessons = checkSavBlockLessons(brief);
  const fields = {
    objective: ["objective"], examples: ["examples"], boundaries: ["exclusions", "neighbours"],
    humanOnly: ["humanOnly"], transferTo: ["transferTo"], resolutionProof: ["resolutionProof"],
  } as const;
  const labels = { objective: "Objectif", examples: "Exemples synthétiques", exclusions: "Exclusions", neighbours: "Blocs voisins", humanOnly: "Sujets humains supplémentaires", transferTo: "Équipe ou file destinataire", resolutionProof: "Preuve attendue" };
  return <main className="page-content">
    <Link className="back-link" href="/studio/sav">← SAV</Link>
    <h1>Assistant de création de blocs</h1>
    <p>Lot 1 — Brief et leçons. Brouillon à off, sans IA. Trente phrases au maximum dans le squelette. Rien n’est activé, publié ou inscrit dans le registre des blocs.</p>
    <p>Utiliser seulement des exemples synthétiques, sans données personnelles. Finance, résiliation, identité et droits restent humains.</p>
    <form method="get"><label htmlFor="bloc">Charger un brouillon par identifiant</label> <input id="bloc" name="bloc" pattern="[a-z][a-z0-9_-]{1,39}" required defaultValue={brief.blockId}/><button>Charger</button></form>
    {params.result && <p role="status">{params.result === "prepared" && validation.ok ? "Brief préparé. Le lot Fiches et phrases reste à réaliser et à revoir." : params.result === "blocked" ? "Brouillon enregistré. Passage bloqué : compléter les contrôles ci-dessous." : "Brouillon enregistré."}</p>}
    <form action={saveBlockBriefAction}>
      <p><label htmlFor="blockId">Identifiant du bloc (lettres minuscules, chiffres, tirets)</label> <input id="blockId" name="blockId" pattern="[a-z][a-z0-9_-]{1,39}" required defaultValue={brief.blockId}/></p>
      {SAV_BLOCK_BRIEF_QUESTIONS.map((question, index) => <fieldset key={question.id}>
        <legend>{index + 1}. {question.label}</legend><p>{question.hint}</p>
        {fields[question.id].map(field => <p key={field}><label htmlFor={field}>{labels[field]}</label><br/>
          <textarea id={field} name={field} rows={3} maxLength={3000} defaultValue={Array.isArray(brief[field]) ? brief[field].join("\n") : String(brief[field])}/></p>)}
      </fieldset>)}
      <h2>Leçons applicables</h2>
      <p>Chaque leçon exige une confirmation et un plan de contrôle d’au moins dix caractères. Ce contrôle déclaratif ne remplace pas les tests ni les preuves d’exécution. Toutes les leçons s’appliquent à la préparation.</p>
      {SAV_BLOCK_LESSONS.map((lesson, index) => <fieldset key={lesson.id}>
        <legend>{lesson.rule}</legend><p>{lesson.requirement}</p>
        <label><input type="checkbox" name={`lesson.${lesson.id}`} defaultChecked={brief.lessons[lesson.id]?.confirmed ?? false}/> Engagement pris dans le brief</label>
        <p><label htmlFor={`plan.${lesson.id}`}>Plan de contrôle</label><br/><textarea id={`plan.${lesson.id}`} name={`plan.${lesson.id}`} rows={2} maxLength={3000} defaultValue={brief.lessons[lesson.id]?.plan ?? ""}/></p>
        <p>{lessons[index].status === "ok" ? "OK déclaratif" : "Bloqué"} : {lessons[index].reason}</p>
      </fieldset>)}
      <p><button name="intent" value="save">Enregistrer le brouillon</button> <button name="intent" value="prepare">Vérifier et préparer l’étape suivante</button></p>
    </form>
    {!validation.ok && <section aria-label="Points à compléter"><h2>Passage bloqué</h2><ul>{validation.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></section>}
    {validation.ok && <section><h2>Squelette du bloc</h2><p>Aucune fiche liée. Les phrases sont des amorces à compléter ; elles ne constituent pas un jeu d’évaluation qualifié.</p><pre>{JSON.stringify(savBlockBriefToDraft(brief), null, 2)}</pre></section>}
    <section><h2>Export Markdown</h2><p>Copier le texte ci-dessous pour la revue. Les engagements restent déclaratifs.</p>
      <textarea aria-label="Export Markdown" readOnly rows={18} style={{ width: "100%" }} value={exportSavBlockBriefMarkdown(brief)}/></section>
  </main>;
}
