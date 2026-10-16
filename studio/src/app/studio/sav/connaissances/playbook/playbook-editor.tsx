"use client";
import { useState, useTransition } from "react";
import type { getSavPlaybookWorkspace } from "@/lib/sav/playbook";
import { savDomainSchema, type SavPlaybook } from "@/lib/sav/playbook-contract";
import { changeSavPlaybook } from "./actions";
import styles from "../workspace.module.css";
type Workspace = Awaited<ReturnType<typeof getSavPlaybookWorkspace>>;
const domainLabels = { seo: "SEO", integration: "Intégrations", account: "Accès au compte", telephony: "Téléphonie", billing_navigation: "Navigation factures", general: "Tous les sujets" };
export function PlaybookEditor({ initial, canManage }: { initial: Workspace; canManage: boolean }) {
  const [workspace, setWorkspace] = useState(initial);
  const [document, setDocument] = useState<SavPlaybook>(initial.versions.find(v => v.id === initial.draftId)?.document ?? initial.fallback);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const [dirty, setDirty] = useState(false);
  const patch = (value: SavPlaybook) => { setDocument(value); setDirty(true); };
  function change(action: "save" | "review" | "activate", versionId?: string) {
    startTransition(async () => {
      const result = await changeSavPlaybook({ action, document: action === "save" ? document : undefined, versionId,
        expectedDraftId: workspace.draftId, expectedActiveId: workspace.activeId });
      if (result.workspace) { setWorkspace(result.workspace); setDirty(false); }
      setMessage(result.error ?? (action === "save" ? "Brouillon enregistré. La version active reste utilisée." : action === "review" ? "Version relue et contrôlée. Vous pouvez maintenant l’activer." : "Version activée pour les prochaines analyses."));
    });
  }
  const current = workspace.versions.find(v => v.id === workspace.draftId);
  return <section className={styles.panel}>
    <p>{workspace.activeId ? `Version active : ${workspace.versions.find(v => v.id === workspace.activeId)?.version ?? "—"}` : "Le process existant est utilisé ; aucun master prompt édité n’est encore actif."}</p>
    {message && <p role="status">{message}</p>}
    <fieldset disabled={!canManage || pending} className={styles.editor}><legend>Préparer le master prompt</legend>
      <label>Ton et structure des réponses<textarea rows={5} maxLength={2000} value={document.tone} onChange={e => patch({ ...document, tone: e.target.value })}/></label>
      <label>Consignes de gestion complémentaires<textarea rows={6} maxLength={3000} value={document.handling} onChange={e => patch({ ...document, handling: e.target.value })}/></label>
      <label>Quand demander une intervention humaine<textarea rows={4} maxLength={1500} value={document.escalation} onChange={e => patch({ ...document, escalation: e.target.value })}/></label>
      <details><summary>Informations et questions d’accueil</summary><div className={styles.editor}><p>Une question est utilisée seulement si l’information manque. Laisser la question vide pour ne pas la poser automatiquement.</p>
      {document.facts.map((fact, index) => <fieldset key={index}><legend>{fact.label || "Nouvelle information"}</legend>
        <label>Nom de l’information<input value={fact.label} maxLength={120} onChange={e => patch({ ...document, facts: document.facts.map((f, i) => i === index ? { ...f, label: e.target.value } : f) })}/></label>
        <label>Clé commune aux fiches<input value={fact.key} maxLength={80} pattern="[a-z][a-z0-9_]+" onChange={e => patch({ ...document, facts: document.facts.map((f, i) => i === index ? { ...f, key: e.target.value } : f) })}/></label>
        <label>Domaine<select value={fact.domains[0]} onChange={e => patch({ ...document, facts: document.facts.map((f, i) => i === index ? { ...f, domains: [savDomainSchema.parse(e.target.value)] } : f) })}>{savDomainSchema.options.map(d => <option key={d} value={d}>{domainLabels[d]}</option>)}</select></label>
        <label>Question en français<textarea rows={2} value={fact.question} maxLength={400} onChange={e => patch({ ...document, facts: document.facts.map((f, i) => i === index ? { ...f, question: e.target.value } : f) })}/></label>
        <label>Question en anglais<textarea rows={2} value={fact.questionEn} maxLength={400} onChange={e => patch({ ...document, facts: document.facts.map((f, i) => i === index ? { ...f, questionEn: e.target.value } : f) })}/></label>
        <button type="button" className="secondary" onClick={() => patch({ ...document, facts: document.facts.filter((_, i) => i !== index) })}>Retirer cette information</button>
      </fieldset>)}
      <button type="button" className="secondary" disabled={document.facts.length >= 60} onClick={() => patch({ ...document, facts: [...document.facts, { key: "", label: "", aliases: [], domains: ["general"], question: "", questionEn: "" }] })}>Ajouter une information</button></div></details>
      <button type="button" onClick={() => change("save")}>Enregistrer le brouillon</button>
    </fieldset>
    {canManage && current && <div className={styles.row}><button disabled={pending || dirty || current.reviewed} onClick={() => change("review", current.id)}>Valider la version {current.version} après relecture</button><button disabled={pending || dirty || !current.reviewed || workspace.activeId === current.id} onClick={() => change("activate", current.id)}>Activer la version {current.version}</button></div>}
    <h2>Historique et retour à une version précédente</h2>
    <ul>{workspace.versions.map(version => <li key={version.id}>Version {version.version} · {version.author}{workspace.activeId === version.id ? " · active" : version.reviewed && canManage ? <button className="secondary" disabled={pending || dirty} onClick={() => change("activate", version.id)}>Réactiver cette version</button> : " · brouillon à relire"}</li>)}</ul>
  </section>;
}
