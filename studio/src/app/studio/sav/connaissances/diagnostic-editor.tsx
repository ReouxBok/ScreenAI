"use client";
import { useEffect, useState } from "react";
import { loadSavFactDictionaryAction } from "./workspace-actions";
import type { CanonicalKnowledge } from "@/lib/knowledge/contracts";
import type { DiagnosticKnowledge } from "@/lib/knowledge/diagnostic-contract";
import { defaultSavPlaybook } from "@/lib/sav/playbook-contract";
import styles from "./workspace.module.css";
export function DiagnosticEditor({ document, onChange }: { document: CanonicalKnowledge; onChange: (document: CanonicalKnowledge) => void }) {
  const [facts, setFacts] = useState(defaultSavPlaybook.facts.map(f => ({ key: f.key, label: f.label })));
  const [dictionaryError, setDictionaryError] = useState(false);
  useEffect(() => { let disposed = false; loadSavFactDictionaryAction().then(value => { if (!disposed) setFacts(value); }).catch(() => { if (!disposed) setDictionaryError(true); }); return () => { disposed = true; }; }, []);
  const diagnostic: DiagnosticKnowledge = document.diagnostic ?? { requiredFacts: [], checks: [], knownCauses: [] };
  const update = (patch: Partial<DiagnosticKnowledge>) => onChange({ ...document, diagnostic: { ...diagnostic, ...patch } });
  return <details><summary>Diagnostic guidé : informations, contrôles et causes documentées</summary><div className={styles.editor}>
    {dictionaryError && <p role="alert">Le dictionnaire actif n’a pas pu être chargé. Rechargez avant d’ajouter une information.</p>}
    <h3>Informations nécessaires</h3>
    {diagnostic.requiredFacts.map((fact, index) => <fieldset key={index}><legend>{fact.label || "Information manquante"}</legend>
      <label>Information<select value={fact.key} onChange={e => { const selected = facts.find(f => f.key === e.target.value); if (selected) update({ requiredFacts: diagnostic.requiredFacts.map((f, i) => i === index ? { ...f, key: selected.key, label: selected.label } : f) }); }}>
        {!facts.some(f => f.key === fact.key) && <option value={fact.key}>{fact.label} · {fact.key}</option>}{facts.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}</select></label>
      <label>Question en français<textarea value={fact.question} onChange={e => update({ requiredFacts: diagnostic.requiredFacts.map((f, i) => i === index ? { ...f, question: e.target.value } : f) })}/></label>
      <label>Question en anglais<textarea value={fact.questionEn ?? ""} onChange={e => update({ requiredFacts: diagnostic.requiredFacts.map((f, i) => i === index ? { ...f, questionEn: e.target.value } : f) })}/></label>
      <label>Contrôles qui nécessitent cette information<select multiple value={fact.requiredFor} onChange={e => update({ requiredFacts: diagnostic.requiredFacts.map((f, i) => i === index ? { ...f, requiredFor: Array.from(e.target.selectedOptions, option => option.value) } : f) })}>{diagnostic.checks.map(c => <option key={c.id} value={c.id}>{document.steps.find(s => s.id === c.evidenceStepId)?.userLabel ?? c.id}</option>)}</select></label>
      <button type="button" onClick={() => update({ requiredFacts: diagnostic.requiredFacts.filter((_, i) => i !== index) })}>Retirer l’information</button>
    </fieldset>)}
    <button type="button" disabled={dictionaryError || diagnostic.requiredFacts.length >= 50 || !facts.some(f => !diagnostic.requiredFacts.some(existing => existing.key === f.key))} onClick={() => { const fact = facts.find(f => !diagnostic.requiredFacts.some(existing => existing.key === f.key)); if (fact) update({ requiredFacts: [...diagnostic.requiredFacts, { key: fact.key, label: fact.label, question: "", questionEn: "", requiredFor: [] }] }); }}>Ajouter une information nécessaire</button>
    <h3>Contrôles et chemin de diagnostic</h3><p>Chaque contrôle reprend une étape documentée. Un résultat inconnu ne permet pas de choisir une branche.</p>
    {diagnostic.checks.map((check, index) => <fieldset key={check.id}><legend>{document.steps.find(s => s.id === check.evidenceStepId)?.userLabel ?? check.id}</legend>
      <p>{check.instruction}</p><p>Résultat attendu : {check.expectedResult || "À compléter dans l’étape source."}</p>
      {(["ifExpected", "ifNot"] as const).map(branch => <label key={branch}>{branch === "ifExpected" ? "Si le résultat est obtenu" : "Si le résultat n’est pas obtenu"}<select value={check[branch] ?? ""} onChange={e => update({ checks: diagnostic.checks.map((c, i) => i === index ? { ...c, [branch]: e.target.value || null } : c) })}><option value="">Arrêter et vérifier avec un humain</option>{diagnostic.checks.filter(c => c.id !== check.id).map(c => <option key={c.id} value={c.id}>{document.steps.find(s => s.id === c.evidenceStepId)?.userLabel ?? c.id}</option>)}</select></label>)}
    </fieldset>)}
    <button type="button" onClick={() => update({ checks: document.steps.map(step => ({ id: step.id, evidenceStepId: step.id, instruction: step.instruction, expectedResult: step.expectedResult, ifExpected: null, ifNot: null, prerequisites: [] })) })}>Reprendre les contrôles depuis les étapes</button>
    <h3>Causes déjà documentées</h3><p>Renseigner uniquement une cause prouvée et les contrôles qui l’établissent.</p>
    {diagnostic.knownCauses.map((cause, index) => <fieldset key={index}><legend>Cause {index + 1}</legend>
      {(["symptom", "cause", "fix"] as const).map(field => <label key={field}>{({ symptom: "Symptôme", cause: "Cause prouvée", fix: "Correction documentée" })[field]}<textarea value={cause[field]} maxLength={2000} onChange={e => update({ knownCauses: diagnostic.knownCauses.map((c, i) => i === index ? { ...c, [field]: e.target.value } : c) })}/></label>)}
      <label>Contrôles qui prouvent cette cause<select multiple value={cause.evidence} onChange={e => update({ knownCauses: diagnostic.knownCauses.map((c, i) => i === index ? { ...c, evidence: Array.from(e.target.selectedOptions, option => option.value) } : c) })}>{diagnostic.checks.map(c => <option key={c.id} value={c.id}>{document.steps.find(s => s.id === c.evidenceStepId)?.userLabel ?? c.id}</option>)}</select></label>
      <button type="button" onClick={() => update({ knownCauses: diagnostic.knownCauses.filter((_, i) => i !== index) })}>Retirer cette cause</button>
    </fieldset>)}
    <button type="button" disabled={!diagnostic.checks.length || diagnostic.knownCauses.length >= 30} onClick={() => update({ knownCauses: [...diagnostic.knownCauses, { symptom: "", cause: "", fix: "", evidence: [] }] })}>Ajouter une cause documentée</button>

  </div></details>;
}
