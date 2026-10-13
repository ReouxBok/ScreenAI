"use client";

import Link from "next/link";
import { useState } from "react";
import { useFormStatus } from "react-dom";
import type { CanonicalKnowledge, SemanticStep, OnboardingSourceSection } from "@/lib/knowledge/contracts";
import { onboardingSectionLabels, onboardingSectionsQualified } from "@/lib/knowledge/onboarding-sections";
import { previewOnboardingReviewAction, reviewOnboardingKnowledgeAction } from "./onboarding-actions";

type Comparison = NonNullable<Awaited<ReturnType<typeof previewOnboardingReviewAction>>["comparison"]>;
type ReturnFilters = { page: number; status: string; source: string; batch?: string; candidate?: string };
const lines = (value: string[]) => value.map((entry) => entry.trim()).filter(Boolean);
const fieldStyle = { width: "100%" };

function cleanDocument(document: CanonicalKnowledge): CanonicalKnowledge {
  return { ...document, prerequisites: lines(document.prerequisites), exceptions: lines(document.exceptions),
    steps: document.steps.map((step) => ({ ...step, prerequisites: lines(step.prerequisites), exceptions: lines(step.exceptions) })),
    ...(document.supportContext ? { supportContext: { ...document.supportContext, symptoms: lines(document.supportContext.symptoms), diagnosticQuestions: lines(document.supportContext.diagnosticQuestions) } } : {}),
    ...(document.onboardingContext ? { onboardingContext: { ...document.onboardingContext, sourceNotes: lines(document.onboardingContext.sourceNotes) } } : {}),
  };
}

function SubmitButtons({ canApprove, busy }: { canApprove: boolean; busy: boolean }) {
  const { pending } = useFormStatus();
  return <div>
    <button className="primary" name="decision" value="approve" disabled={pending || busy || !canApprove}>{pending ? "Enregistrement…" : "Valider et préparer le brouillon SAV"}</button>
    <button className="secondary" name="decision" value="reject" disabled={pending || busy}>Écarter le candidat</button>
  </div>;
}

function errorMessage(code: string) {
  if (code === "ONBOARDING_CONVERTER_STALE") return "Cette carte a été préparée avec une ancienne extraction. Préparez un nouvel inventaire pour récupérer toutes les consignes de la source.";
  if (code === "ONBOARDING_SOURCE_SECTIONS_CHANGED") return "Les passages de la source doivent rester intacts. Rechargez la carte, puis qualifiez chaque section.";
  if (/SOURCE.*(?:STALE|CHANGED|INACTIVE)|ONBOARDING.*(?:STALE|CHANGED|INACTIVE)/.test(code)) return "Le tutoriel source a changé ou n’est plus actif. Préparez un nouveau lot avant de valider cette connaissance.";
  if (code === "KNOWLEDGE_CANDIDATE_STALE") return "Ce candidat a changé. Rechargez la page pour consulter sa dernière version.";
  return "La comparaison n’a pas pu être préparée. Vérifiez les champs et la source, puis réessayez.";
}

export function OnboardingReviewForm({ candidateId, revisionId, title, initialDocument, needsCompletion, filters }: {
  candidateId: string; revisionId: string; title: string; initialDocument: CanonicalKnowledge; needsCompletion: boolean; filters: ReturnFilters;
}) {
  const [document, setDocument] = useState(initialDocument);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [missingAcknowledged, setMissingAcknowledged] = useState(false);
  const [completionNote, setCompletionNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function update(next: CanonicalKnowledge) {
    setDocument(next); setComparison(null); setAcknowledged(false); setMissingAcknowledged(false); setError("");
  }
  function updateStep(index: number, patch: Partial<SemanticStep>) {
    update({ ...document, steps: document.steps.map((step, position) => position === index ? { ...step, ...patch } : step) });
  }
  function updateSection(index: number, patch: Partial<Pick<OnboardingSourceSection, "classification" | "rationale">>) {
    if (!document.onboardingContext) return;
    update({ ...document, onboardingContext: { ...document.onboardingContext,
      sourceSections: document.onboardingContext.sourceSections?.map((section, position) => position === index ? { ...section, ...patch } : section) } });
  }
  async function preview() {
    setBusy(true); setComparison(null); setAcknowledged(false); setMissingAcknowledged(false); setError("");
    const form = new FormData();
    form.set("candidateId", candidateId); form.set("revisionId", revisionId); form.set("document", JSON.stringify(cleanDocument(document)));
    try {
      const result = await previewOnboardingReviewAction(form);
      setComparison(result.comparison); setError(result.error ? errorMessage(result.error) : "");
    } catch { setError("Comparaison indisponible. Réessayez avant de valider."); }
    finally { setBusy(false); }
  }
  const completionRequired = needsCompletion || Boolean(comparison?.missing.length);
  const contentChanged = JSON.stringify(cleanDocument(document)) !== JSON.stringify(cleanDocument(initialDocument));
  const canApprove = Boolean(comparison?.sourceCurrent && acknowledged && onboardingSectionsQualified(document) && (!completionRequired || (contentChanged && missingAcknowledged && completionNote.trim().length >= 20)));

  return <form action={reviewOnboardingKnowledgeAction} aria-label={`Revoir ${title}`}>
    <input type="hidden" name="candidateId" value={candidateId}/><input type="hidden" name="revisionId" value={revisionId}/>
    <input type="hidden" name="document" value={JSON.stringify(cleanDocument(document))}/>
    <input type="hidden" name="returnPage" value={filters.page}/><input type="hidden" name="returnStatus" value={filters.status}/><input type="hidden" name="returnSource" value={filters.source}/>
    {filters.batch && <input type="hidden" name="returnBatch" value={filters.batch}/>}{filters.candidate && <input type="hidden" name="returnCandidate" value={filters.candidate}/>}
    <details>
      <summary>Corriger ou compléter la connaissance</summary>
      <p>Le titre « {title} » reste celui du tutoriel. Décrivez les informations utiles au support et citez les preuves dans le motif de revue.</p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
        {Boolean(document.onboardingContext?.sourceSections?.length) && <section aria-label="Qualifier les sections de la source">
          <h3>Qualifier les sections de la source</h3>
          <p>Ces passages ne correspondent pas aux rubriques habituelles. Classez chacun et justifiez votre choix. Les passages pertinents seront repris intégralement dans la connaissance ; les autres resteront conservés dans la preuve de revue.</p>
          {document.onboardingContext?.sourceSections?.map((section, index) => <fieldset key={section.id}>
            <legend>{index + 1}. {section.heading}</legend>
            <p style={{ whiteSpace: "pre-wrap" }}>{section.content || "Section sans texte exploitable : vérifier la source avant de qualifier."}</p>
            <div><label htmlFor={`onboarding-${candidateId}-section-${section.id}-classification`}>Classement de la section {index + 1}</label>
              <select id={`onboarding-${candidateId}-section-${section.id}-classification`} value={section.classification} onChange={(event) => updateSection(index, { classification: event.target.value as OnboardingSourceSection["classification"] })}>
                {Object.entries(onboardingSectionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></div>
            <div><label htmlFor={`onboarding-${candidateId}-section-${section.id}-rationale`}>Justification du classement {index + 1}</label>
              <textarea id={`onboarding-${candidateId}-section-${section.id}-rationale`} rows={3} minLength={20} maxLength={2000} value={section.rationale} onChange={(event) => updateSection(index, { rationale: event.target.value })} style={fieldStyle}/></div>
          </fieldset>)}
        </section>}
        <div><label htmlFor={`onboarding-${candidateId}-objective`}>Objectif et valeur pour le membre</label><textarea id={`onboarding-${candidateId}-objective`} rows={3} maxLength={500} value={document.objective} onChange={(event) => update({ ...document, objective: event.target.value })} style={fieldStyle}/></div>
        <div><label htmlFor={`onboarding-${candidateId}-entry`}>Point d’entrée de la procédure</label><textarea id={`onboarding-${candidateId}-entry`} rows={3} maxLength={5000} value={document.onboardingContext?.entryPoint ?? ""} onChange={(event) => update({ ...document, onboardingContext: { ...(document.onboardingContext ?? { entryPoint: "", sourceNotes: [] }), entryPoint: event.target.value } })} style={fieldStyle}/></div>
        <details><summary>Précisions conservées depuis la source</summary>
          {(document.onboardingContext?.sourceNotes ?? []).map((note, index) => <div key={index}><label htmlFor={`onboarding-${candidateId}-note-${index}`}>Précision {index + 1}</label><textarea id={`onboarding-${candidateId}-note-${index}`} rows={4} maxLength={10000} value={note} onChange={(event) => update({ ...document, onboardingContext: { ...document.onboardingContext, entryPoint: document.onboardingContext?.entryPoint ?? "", sourceNotes: (document.onboardingContext?.sourceNotes ?? []).map((value, position) => position === index ? event.target.value : value) } })} style={fieldStyle}/></div>)}
          <button type="button" className="secondary" disabled={(document.onboardingContext?.sourceNotes.length ?? 0) >= 50} onClick={() => update({ ...document, onboardingContext: { ...document.onboardingContext, entryPoint: document.onboardingContext?.entryPoint ?? "", sourceNotes: [...(document.onboardingContext?.sourceNotes ?? []), ""] } })}>Ajouter une précision sourcée</button>
        </details>
        <div><label htmlFor={`onboarding-${candidateId}-prerequisites`}>Prérequis — un par ligne</label><textarea id={`onboarding-${candidateId}-prerequisites`} rows={3} value={document.prerequisites.join("\n")} onChange={(event) => update({ ...document, prerequisites: event.target.value.split("\n") })} style={fieldStyle}/></div>
        <div><label htmlFor={`onboarding-${candidateId}-expected-result`}>Résultat attendu</label><textarea id={`onboarding-${candidateId}-expected-result`} rows={3} maxLength={5000} value={document.expectedResult} onChange={(event) => update({ ...document, expectedResult: event.target.value })} style={fieldStyle}/></div>
        <div><label htmlFor={`onboarding-${candidateId}-exceptions`}>Exceptions et limites — une par ligne</label><textarea id={`onboarding-${candidateId}-exceptions`} rows={3} value={document.exceptions.join("\n")} onChange={(event) => update({ ...document, exceptions: event.target.value.split("\n") })} style={fieldStyle}/></div>
        <div><label htmlFor={`onboarding-${candidateId}-escalation`}>Quand et comment passer la main</label><textarea id={`onboarding-${candidateId}-escalation`} rows={3} maxLength={5000} value={document.escalation} onChange={(event) => update({ ...document, escalation: event.target.value })} style={fieldStyle}/></div>
        <div><label htmlFor={`onboarding-${candidateId}-product-version`}>Version du produit, si connue</label><input id={`onboarding-${candidateId}-product-version`} maxLength={100} value={document.productVersion} onChange={(event) => update({ ...document, productVersion: event.target.value })}/></div>
        <div><label htmlFor={`onboarding-${candidateId}-valid-until`}>Date de fin de validité, si applicable</label><input id={`onboarding-${candidateId}-valid-until`} type="date" value={document.validUntil ?? ""} onChange={(event) => { const next = { ...document }; if (event.target.value) next.validUntil = event.target.value; else delete next.validUntil; update(next); }}/></div>
        <details>
          <summary>Contexte d’utilisation et diagnostic</summary>
          <div><label htmlFor={`onboarding-${candidateId}-symptoms`}>Situations ou symptômes — un par ligne</label><textarea id={`onboarding-${candidateId}-symptoms`} rows={3} value={document.supportContext?.symptoms.join("\n") ?? ""} onChange={(event) => update({ ...document, supportContext: { ...(document.supportContext ?? { symptoms: [], diagnosticQuestions: [], responseTemplate: "" }), symptoms: event.target.value.split("\n") } })} style={fieldStyle}/></div>
          <div><label htmlFor={`onboarding-${candidateId}-questions`}>Questions de diagnostic — une par ligne</label><textarea id={`onboarding-${candidateId}-questions`} rows={3} value={document.supportContext?.diagnosticQuestions.join("\n") ?? ""} onChange={(event) => update({ ...document, supportContext: { ...(document.supportContext ?? { symptoms: [], diagnosticQuestions: [], responseTemplate: "" }), diagnosticQuestions: event.target.value.split("\n") } })} style={fieldStyle}/></div>
          <div><label htmlFor={`onboarding-${candidateId}-response`}>Exemple de réponse à adapter</label><textarea id={`onboarding-${candidateId}-response`} rows={4} maxLength={5000} value={document.supportContext?.responseTemplate ?? ""} onChange={(event) => update({ ...document, supportContext: { ...(document.supportContext ?? { symptoms: [], diagnosticQuestions: [], responseTemplate: "" }), responseTemplate: event.target.value } })} style={fieldStyle}/></div>
        </details>
        <h3>Procédure</h3>
        {document.steps.map((step, index) => <fieldset key={step.id} style={{ marginBottom: 16 }}>
          <legend>Étape {index + 1}</legend>
          <div><label htmlFor={`onboarding-${candidateId}-step-${step.id}-label`}>Nom de l’étape</label><input id={`onboarding-${candidateId}-step-${step.id}-label`} maxLength={500} value={step.userLabel} onChange={(event) => updateStep(index, { userLabel: event.target.value })}/></div>
          <div><label htmlFor={`onboarding-${candidateId}-step-${step.id}-objective`}>But de l’étape</label><input id={`onboarding-${candidateId}-step-${step.id}-objective`} maxLength={500} value={step.objective} onChange={(event) => updateStep(index, { objective: event.target.value })}/></div>
          <div><label htmlFor={`onboarding-${candidateId}-step-${step.id}-instruction`}>Instruction complète</label><textarea id={`onboarding-${candidateId}-step-${step.id}-instruction`} rows={4} maxLength={2000} value={step.instruction} onChange={(event) => updateStep(index, { instruction: event.target.value })} style={fieldStyle}/></div>
          <div><label htmlFor={`onboarding-${candidateId}-step-${step.id}-location`}>Emplacement dans l’interface</label><input id={`onboarding-${candidateId}-step-${step.id}-location`} maxLength={200} value={step.location} onChange={(event) => updateStep(index, { location: event.target.value })}/></div>
          <div><label htmlFor={`onboarding-${candidateId}-step-${step.id}-result`}>Résultat observable</label><textarea id={`onboarding-${candidateId}-step-${step.id}-result`} rows={2} maxLength={5000} value={step.expectedResult} onChange={(event) => updateStep(index, { expectedResult: event.target.value })} style={fieldStyle}/></div>
          <details><summary>Conditions propres à cette étape</summary>
            <div><label htmlFor={`onboarding-${candidateId}-step-${step.id}-prerequisites`}>Prérequis — un par ligne</label><textarea id={`onboarding-${candidateId}-step-${step.id}-prerequisites`} rows={2} value={step.prerequisites.join("\n")} onChange={(event) => updateStep(index, { prerequisites: event.target.value.split("\n") })} style={fieldStyle}/></div>
            <div><label htmlFor={`onboarding-${candidateId}-step-${step.id}-exceptions`}>Exceptions — une par ligne</label><textarea id={`onboarding-${candidateId}-step-${step.id}-exceptions`} rows={2} value={step.exceptions.join("\n")} onChange={(event) => updateStep(index, { exceptions: event.target.value.split("\n") })} style={fieldStyle}/></div>
            <div><label htmlFor={`onboarding-${candidateId}-step-${step.id}-escalation`}>Passage à un humain</label><textarea id={`onboarding-${candidateId}-step-${step.id}-escalation`} rows={2} maxLength={5000} value={step.escalation} onChange={(event) => updateStep(index, { escalation: event.target.value })} style={fieldStyle}/></div>
          </details>
          {step.variants.length > 0 && <p>Cette étape contient des variantes de contexte. Elles sont conservées ; leur qualification reste nécessaire avant validation.</p>}
          <button type="button" className="secondary" onClick={() => update({ ...document, steps: document.steps.filter((_, position) => position !== index) })}>Retirer l’étape {index + 1}</button>
        </fieldset>)}
        <button type="button" className="secondary" disabled={document.steps.length >= 50} onClick={() => update({ ...document, steps: [...document.steps, { id: `step.review-${crypto.randomUUID()}`, userLabel: `Étape ${document.steps.length + 1}`, objective: "", instruction: "", location: "", prerequisites: [], expectedResult: "", exceptions: [], escalation: "", variants: [] }] })}>Ajouter une étape sourcée</button>
      </fieldset>
    </details>
    <button type="button" className="secondary" disabled={busy} onClick={preview}>{busy ? "Vérification et comparaison…" : "Vérifier la source et comparer"}</button>
    {error && <p role="alert">{error}</p>}
    {comparison && <section aria-label="Comparaison de la connaissance corrigée" aria-live="polite">
      <h3>{comparison.title}</h3>
      <p>{comparison.sourceCurrent ? "Version du tutoriel source vérifiée." : "Source obsolète : validation indisponible."} {comparison.compared} versions comparées.</p>
      {comparison.missing.length > 0 && <><h4>Points à compléter</h4><ul>{comparison.missing.map((entry, index) => <li key={index}>{entry}</li>)}</ul></>}
      {comparison.warnings.length > 0 && <><h4>Points d’attention</h4><ul>{comparison.warnings.map((entry, index) => <li key={index}>{entry}</li>)}</ul></>}
      <p>Les rapprochements aident la revue. Vérifiez les conditions d’utilisation et les éventuelles contradictions.</p>
      {!comparison.findings.length && <p>Aucun sujet proche détecté automatiquement.</p>}
      {comparison.findings.map((finding) => <details key={`${finding.ref}:${finding.versionId}`}>
        <summary>{finding.title} · {finding.signal === "duplicate" ? "Doublon possible" : "Sujet proche"}</summary><p>{finding.explanation}</p>
        {finding.ref.startsWith("content:") && <p><Link href={`/studio/contenus/${encodeURIComponent(finding.ref.slice(8))}`}>Ouvrir la fiche comparée</Link></p>}
        <pre style={{ whiteSpace: "pre-wrap" }}>{finding.body}</pre>
      </details>)}
      <details><summary>Vérifier le texte actuel et la proposition complète</summary>
        <h4>Version actuelle</h4><pre style={{ whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto" }}>{comparison.before || "Aucune projection SAV existante."}</pre>
        <h4>Proposition complète</h4><pre style={{ whiteSpace: "pre-wrap", maxHeight: 480, overflow: "auto" }}>{comparison.after}</pre>
      </details>
      <input type="hidden" name="comparisonSnapshot" value={comparison.snapshot}/>
      <label><input type="checkbox" name="comparisonAcknowledged" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)}/>J’ai vérifié la source, la procédure complète et les sujets proches.</label>
    </section>}
    {completionRequired && <section aria-label="Qualification des informations manquantes">
      <p>Complétez le contenu et expliquez les preuves ajoutées avant de valider. Une simple confirmation ne complète pas la connaissance.</p>
      <div><label htmlFor={`onboarding-${candidateId}-completion-note`}>Preuves et précisions apportées</label><textarea id={`onboarding-${candidateId}-completion-note`} name="completionNote" rows={3} value={completionNote} onChange={(event) => setCompletionNote(event.target.value)} style={fieldStyle}/></div>
      <label><input type="checkbox" name="missingAcknowledged" checked={missingAcknowledged} onChange={(event) => setMissingAcknowledged(event.target.checked)}/>J’ai vérifié et traité les informations manquantes indiquées.</label>
    </section>}
    <div><label htmlFor={`onboarding-${candidateId}-reason`}>Motif de la décision</label><input id={`onboarding-${candidateId}-reason`} name="reason" required minLength={10} maxLength={1000}/></div>
    <p>La validation prépare un brouillon SAV. Ugo décidera séparément de sa publication et de son utilisation par l’agent.</p>
    <SubmitButtons canApprove={canApprove} busy={busy}/>
  </form>;
}
