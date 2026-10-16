"use client";
import { useState, useTransition } from "react";
import type { getSavPlaybookWorkspace } from "@/lib/sav/playbook";
import { SAV_PLAYBOOK_PROMPT_MAX_LENGTH, savPlaybookPrompt } from "@/lib/sav/playbook-contract";
import { changeSavPlaybook } from "./actions";
import styles from "../workspace.module.css";
type Workspace = Awaited<ReturnType<typeof getSavPlaybookWorkspace>>;
export function PlaybookEditor({ initial, canManage }: { initial: Workspace; canManage: boolean }) {
  const [workspace, setWorkspace] = useState(initial);
  const [document, setDocument] = useState(initial.versions.find(v => v.id === initial.draftId)?.document ?? initial.fallback);
  const [prompt, setPrompt] = useState(() => initial.versions.find(v => v.id === initial.draftId)?.prompt ?? savPlaybookPrompt(document));
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const [dirty, setDirty] = useState(false);
  const promptTooLong = prompt.length > SAV_PLAYBOOK_PROMPT_MAX_LENGTH;
  function change(action: "save" | "review" | "activate", versionId?: string) {
    if (action === "save" && promptTooLong) return;
    startTransition(async () => {
      // Keep the existing fact dictionary; only merge the editable prose into one field.
      const result = await changeSavPlaybook({ action, document: action === "save" ? document : undefined, prompt: action === "save" ? prompt : undefined, versionId,
        expectedDraftId: workspace.draftId, expectedActiveId: workspace.activeId });
      const nextWorkspace = result.workspace;
      if (nextWorkspace) {
        setWorkspace(nextWorkspace);
        const saved = nextWorkspace.versions.find(v => v.id === nextWorkspace.draftId)?.document ?? nextWorkspace.fallback;
        setDocument(saved); setPrompt(nextWorkspace.versions.find(v => v.id === nextWorkspace.draftId)?.prompt ?? savPlaybookPrompt(saved)); setDirty(false);
      }
      setMessage(result.error ?? (action === "save" ? "Brouillon enregistré. La version active reste utilisée." : action === "review" ? "Version relue et contrôlée. Vous pouvez maintenant l’activer." : "Version activée pour les prochaines analyses."));
    });
  }
  const current = workspace.versions.find(v => v.id === workspace.draftId);
  return <section className={styles.panel}>
    <p>{workspace.activeId ? `Version active : ${workspace.versions.find(v => v.id === workspace.activeId)?.version ?? "—"}` : "Le process existant est utilisé ; aucun master prompt édité n’est encore actif."}</p>
    {message && <p role="status">{message}</p>}
    <fieldset disabled={!canManage || pending} className={styles.editor}><legend>Master prompt SAV</legend>
      <label>Consignes générales de l’agent<textarea rows={24} maxLength={SAV_PLAYBOOK_PROMPT_MAX_LENGTH} value={prompt} onChange={e => { setPrompt(e.target.value); setDirty(true); setMessage(""); }}/></label>
      <p>{prompt.length} / {SAV_PLAYBOOK_PROMPT_MAX_LENGTH} caractères</p>
      {promptTooLong && <p role="alert">Les anciennes consignes sont affichées en entier. Réduisez le texte à {SAV_PLAYBOOK_PROMPT_MAX_LENGTH} caractères avant de l’enregistrer ; aucune version existante n’a été modifiée.</p>}
      <button type="button" disabled={promptTooLong} onClick={() => change("save")}>Enregistrer le brouillon</button>
    </fieldset>
    {canManage && current && <div className={styles.row}><button disabled={pending || dirty || current.reviewed} onClick={() => change("review", current.id)}>Valider la version {current.version} après relecture</button><button disabled={pending || dirty || !current.reviewed || workspace.activeId === current.id} onClick={() => change("activate", current.id)}>Activer la version {current.version}</button></div>}
    <h2>Historique et retour à une version précédente</h2>
    <ul>{workspace.versions.map(version => <li key={version.id}>Version {version.version} · {version.author}{workspace.activeId === version.id ? " · active" : version.reviewed && canManage ? <button className="secondary" disabled={pending || dirty} onClick={() => change("activate", version.id)}>Réactiver cette version</button> : " · brouillon à relire"}</li>)}</ul>
  </section>;
}
