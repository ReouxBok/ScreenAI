"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { Check, LockKeyhole, Search } from "lucide-react";
import { startSelectedPilotBatchAction } from "../actions";

export type PilotCandidate = {
  id: string;
  receivedLabel: string;
  fromEmail: string;
  subject: string;
  preview: string;
};

function LaunchButton({ count, canLaunch }: { count: number; canLaunch: boolean }) {
  const { pending } = useFormStatus();
  return <button className="primary" type="submit" disabled={count !== 10 || pending || !canLaunch}>
    {pending ? "Création du lot…" : count === 10 ? "Lancer la simulation sur ces 10 mails" : `Sélectionnez encore ${10 - count} mail${10 - count > 1 ? "s" : ""}`}
  </button>;
}

export function PilotCandidateSelector({ candidates, canLaunch = true, blockedReason = "" }: { candidates: PilotCandidate[]; canLaunch?: boolean; blockedReason?: string }) {
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>(() => candidates.slice(0, 10).map((candidate) => candidate.id));
  const normalizedQuery = query.trim().toLocaleLowerCase("fr");
  const candidatesById = useMemo(() => new Map(candidates.map((candidate) => [candidate.id, candidate])), [candidates]);
  const visibleCandidates = useMemo(() => normalizedQuery
    ? candidates.filter((candidate) => `${candidate.fromEmail} ${candidate.subject} ${candidate.preview}`.toLocaleLowerCase("fr").includes(normalizedQuery))
    : candidates, [candidates, normalizedQuery]);
  const selectedCandidates = selectedIds.map((selectedId) => candidatesById.get(selectedId)).filter((candidate): candidate is PilotCandidate => Boolean(candidate));

  function toggleCandidate(candidateId: string) {
    setSelectedIds((current) => current.includes(candidateId)
      ? current.filter((id) => id !== candidateId)
      : current.length < 10 ? [...current, candidateId] : current);
  }

  function selectOldestTen() {
    setSelectedIds(candidates.slice(0, 10).map((candidate) => candidate.id));
  }

  return <form action={startSelectedPilotBatchAction} className="pilot-candidate-form">
    <section className="pilot-selection-rack" aria-labelledby="pilot-selection-title">
      <div>
        <span className="eyebrow">Lot isolé</span>
        <h2 id="pilot-selection-title">Choisissez exactement 10 mails</h2>
        <p>Ces messages seront analysés ensemble et resteront identifiables comme un seul lot. Aucune proposition ne sera exécutée.</p>
      </div>
      <div className="pilot-slots" aria-label={`${selectedIds.length} mails sélectionnés sur 10`}>
        {Array.from({ length: 10 }, (_, index) => {
          const candidate = selectedCandidates[index];
          return <span className={candidate ? "filled" : ""} title={candidate?.subject} key={index}>{String(index + 1).padStart(2, "0")}</span>;
        })}
      </div>
      <div className="pilot-selection-commit">
        <span><LockKeyhole size={15}/> Simulation uniquement</span>
        <strong>{selectedIds.length}/10</strong>
        <LaunchButton count={selectedIds.length} canLaunch={canLaunch}/>
        {!canLaunch && blockedReason && <small role="alert">{blockedReason}</small>}
      </div>
    </section>

    <div className="pilot-candidate-toolbar">
      <label><Search size={16}/><input aria-label="Rechercher dans les mails éligibles" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher un expéditeur ou un objet"/></label>
      <button className="button secondary" type="button" onClick={selectOldestTen}>Sélectionner les 10 plus anciens</button>
      <span>{visibleCandidates.length} mail{visibleCandidates.length > 1 ? "s" : ""} affiché{visibleCandidates.length > 1 ? "s" : ""}</span>
    </div>

    <div className="pilot-candidate-list">
      {visibleCandidates.map((candidate) => {
        const selectedIndex = selectedIds.indexOf(candidate.id);
        const selected = selectedIndex >= 0;
        const disabled = !selected && selectedIds.length >= 10;
        return <label className={`pilot-candidate ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}`} key={candidate.id}>
          <input name="messageIds" value={candidate.id} type="checkbox" checked={selected} disabled={disabled} onChange={() => toggleCandidate(candidate.id)}/>
          <span className="pilot-candidate-check">{selected ? <><Check size={15}/>{selectedIndex + 1}</> : ""}</span>
          <span className="pilot-candidate-mail">
            <small>{candidate.receivedLabel}</small>
            <strong>{candidate.subject}</strong>
            <span>{candidate.fromEmail}</span>
            <p>{candidate.preview || "Aucun aperçu disponible"}</p>
          </span>
        </label>;
      })}
      {!visibleCandidates.length && <div className="empty"><Search size={20}/><strong>Aucun mail ne correspond à cette recherche.</strong></div>}
    </div>
  </form>;
}
