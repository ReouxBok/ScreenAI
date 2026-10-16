"use client";
import type { CanonicalKnowledge } from "@/lib/knowledge/contracts";
import { projectSavSupportDelivery, renderSavProcedureGroup, savDeliveryGroups, type SavSupportDelivery, unclassifiedSavDelivery } from "@/lib/knowledge/support-delivery";
import styles from "./workspace.module.css";
const labels = { unclassified: "À qualifier", procedure: "Procédure client", diagnostic: "Diagnostic avec contrôles explicites", internal: "Consignes internes uniquement" };
export function DeliveryPreview({ document, delivery }: { document: CanonicalKnowledge; delivery?: SavSupportDelivery }) {
  const value = delivery ?? unclassifiedSavDelivery;
  let projection;
  try { if (value.mode !== "unclassified") projection = projectSavSupportDelivery(document, value, true); } catch { /* The validation list explains incomplete qualification. */ }
  return <section aria-label="Restitution au client"><h3>Restitution : {labels[value.mode]}</h3>
    {value.mode === "unclassified" && <p>Une relecture est nécessaire avant soumission.</p>}
    {value.mode === "internal" && <p>Ces instructions restent internes : elles ne seront pas envoyées comme procédure au client.</p>}
    {value.mode === "diagnostic" && <p>Les contrôles et leurs embranchements explicites sont utilisés après vérification des preuves.</p>}
    {projection && savDeliveryGroups(projection).map(g => <details key={g.id} open><summary>{g.label}{g.requiresHuman ? " · Réservé à un humain" : " · Un objectif à la fois"}</summary><pre className={styles.text}>{renderSavProcedureGroup(g, "fr")}</pre></details>)}
  </section>;
}
export function DeliveryEditor({ document, value, onChange }: { document: CanonicalKnowledge; value: SavSupportDelivery; onChange: (value: SavSupportDelivery, document: CanonicalKnowledge) => void }) {
  function select(mode: SavSupportDelivery["mode"]) {
    // Switching to a procedure is an explicit replacement of the diagnostic graph.
    const nextDocument = { ...document }; if (mode === "procedure" || mode === "internal") delete nextDocument.diagnostic;
    onChange(mode === "procedure" ? { version: 1, mode, groups: [], internalStepIds: [] } : { version: 1, mode }, nextDocument);
  }
  const toggle = <T,>(values: T[], item: T) => values.includes(item) ? values.filter(v => v !== item) : [...values, item];
  return <section><h3>Comment utiliser cette connaissance ?</h3>
    <label>Usage validé<select aria-label="Usage validé" value={value.mode} onChange={e => select(e.target.value as SavSupportDelivery["mode"])}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <p>Une procédure donne toutes les étapes d’un objectif. Séparez les autres méthodes et objectifs. Passer en procédure ou en consignes internes retire le diagnostic de ce brouillon ; la version active reste conservée.</p>
    {value.mode === "procedure" && <>
      {value.groups.map((g, index) => {
        function update(patch: Partial<typeof g>) { if (value.mode === "procedure") onChange({ ...value, groups: value.groups.map((entry, i) => i === index ? { ...entry, ...patch } : entry) }, document); }
        return <fieldset key={g.id}><legend>Objectif {index + 1}</legend>
          <label>Demande couverte<input value={g.label} maxLength={200} onChange={e => update({ label: e.target.value })}/></label>
          <label className={styles.choice}><input type="checkbox" checked={g.requiresHuman} onChange={e => update({ requiresHuman: e.target.checked })}/>Réserver cet objectif à un humain (action sensible, procédure incertaine)</label>
          <p>Étapes client, dans l’ordre choisi :</p>
          {document.steps.map(step => <label key={step.id} className={styles.choice}><input type="checkbox" checked={g.stepIds.includes(step.id)} disabled={value.internalStepIds.includes(step.id)} onChange={() => update({ stepIds: toggle(g.stepIds, step.id) })}/>{step.userLabel}{g.stepIds.includes(step.id) ? ` · ${g.stepIds.indexOf(step.id) + 1}` : ""}</label>)}
          <p>Contexte à communiquer au client :</p>
          {document.prerequisites.map((text, i) => <label key={`p${i}`} className={styles.choice}><input type="checkbox" checked={g.prerequisiteIndexes.includes(i)} onChange={() => update({ prerequisiteIndexes: toggle(g.prerequisiteIndexes, i) })}/>Prérequis : {text}</label>)}
          {document.exceptions.map((text, i) => <label key={`e${i}`} className={styles.choice}><input type="checkbox" checked={g.exceptionIndexes.includes(i)} onChange={() => update({ exceptionIndexes: toggle(g.exceptionIndexes, i) })}/>Limite : {text}</label>)}
          <label className={styles.choice}><input type="checkbox" checked={g.includeExpectedResult} onChange={e => update({ includeExpectedResult: e.target.checked })}/>Inclure le résultat global : {document.expectedResult || "non renseigné"}</label>
          <label className={styles.choice}><input type="checkbox" checked={g.includeEscalation} onChange={e => update({ includeEscalation: e.target.checked })}/>Inclure la consigne de recours : {document.escalation || "non renseignée"}</label>
          <button type="button" className="secondary" onClick={() => onChange({ ...value, groups: value.groups.filter((_, i) => i !== index) }, document)}>Retirer cet objectif</button>
        </fieldset>;
      })}
      <button type="button" className="secondary" disabled={value.groups.length >= 20} onClick={() => onChange({ ...value, groups: [...value.groups, { id: `procedure.${crypto.randomUUID()}`, label: "", stepIds: [], requiresHuman: false, prerequisiteIndexes: [], exceptionIndexes: [], includeExpectedResult: false, includeEscalation: false }] }, document)}>Ajouter un objectif</button>
      <h4>Étapes réservées au SAV</h4>{document.steps.map(step => <label key={step.id} className={styles.choice}><input type="checkbox" checked={value.internalStepIds.includes(step.id)} disabled={value.groups.some(g => g.stepIds.includes(step.id))} onChange={() => onChange({ ...value, internalStepIds: toggle(value.internalStepIds, step.id) }, document)}/>{step.userLabel}</label>)}
      <p>Chaque étape doit être affectée à un objectif ou réservée au SAV. Vérifiez l’aperçu avant soumission.</p>
    </>}
  </section>;
}
