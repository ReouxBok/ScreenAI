"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, GitBranch, Plus, Trash2 } from "lucide-react";
import { saveOnboardingTemplateAction } from "@/app/studio/trame/actions";

type ContentOption = { id: string; title: string; summary: string; type: "article" | "onboarding"; agentKey: string };
type TemplateNode = { id: string; contentItemId: string; depth: 0 | 1 | 2; trigger: string; optional: boolean };
type Definition = { name: string; openingPrompt: string; fallbackPrompt: string; nodes: TemplateNode[] };

const DEFAULT_OPENING = "Si l’utilisateur n’a pas encore formulé de besoin précis, demande-lui s’il souhaite traiter un sujet particulier aujourd’hui, puis attends sa réponse.";
const DEFAULT_FALLBACK = "S’il n’a pas d’idée, propose les premières étapes de cette trame qui correspondent à son activité. Pose une seule question à la fois et laisse-le rediriger la conversation à tout moment.";

export function OnboardingTemplateEditor({ options, initialDefinition }: { options: ContentOption[]; initialDefinition?: Definition }) {
  const [name, setName] = useState(initialDefinition?.name ?? "Onboarding principal Charly");
  const [openingPrompt, setOpeningPrompt] = useState(initialDefinition?.openingPrompt ?? DEFAULT_OPENING);
  const [fallbackPrompt, setFallbackPrompt] = useState(initialDefinition?.fallbackPrompt ?? DEFAULT_FALLBACK);
  const [nodes, setNodes] = useState<TemplateNode[]>(initialDefinition?.nodes ?? []);
  const [selectedId, setSelectedId] = useState(options[0]?.id ?? "");
  const optionMap = useMemo(() => new Map(options.map((option) => [option.id, option])), [options]);

  const updateNode = (id: string, patch: Partial<TemplateNode>) => setNodes((current) => current.map((node) => node.id === id ? { ...node, ...patch } : node));
  const move = (index: number, direction: -1 | 1) => setNodes((current) => {
    const target = index + direction;
    if (target < 0 || target >= current.length) return current;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    if (next[0].depth !== 0) next[0] = { ...next[0], depth: 0 };
    return next;
  });
  const changeDepth = (index: number, delta: -1 | 1) => setNodes((current) => {
    const node = current[index];
    if (!node) return current;
    const maxDepth = index === 0 ? 0 : Math.min(2, current[index - 1].depth + 1);
    const depth = Math.max(0, Math.min(maxDepth, node.depth + delta)) as 0 | 1 | 2;
    return current.map((item, itemIndex) => itemIndex === index ? { ...item, depth } : item);
  });
  const add = () => {
    const option = optionMap.get(selectedId);
    if (!option) return;
    setNodes((current) => [...current, {
      id: crypto.randomUUID(),
      contentItemId: option.id,
      depth: 0,
      trigger: `Quand l’utilisateur veut ${option.title.toLocaleLowerCase("fr")}`,
      optional: false,
    }]);
  };
  const definition = { name, openingPrompt, fallbackPrompt, nodes };

  return <form action={saveOnboardingTemplateAction} className="template-editor">
    <input type="hidden" name="definition" value={JSON.stringify(definition)}/>
    <section className="template-foundation card">
      <div><span className="eyebrow">Point de départ</span><h2>Le cadre de la conversation</h2><p>Charly suit cette ligne directrice uniquement quand le membre n’arrive pas avec une demande précise.</p></div>
      <div className="field"><label htmlFor="template-name">Nom interne</label><input id="template-name" value={name} onChange={(event) => setName(event.target.value)} required/></div>
      <div className="field"><label htmlFor="opening-prompt">Première approche</label><textarea id="opening-prompt" value={openingPrompt} onChange={(event) => setOpeningPrompt(event.target.value)} required/></div>
      <div className="field"><label htmlFor="fallback-prompt">Si le membre n’a pas d’idée</label><textarea id="fallback-prompt" value={fallbackPrompt} onChange={(event) => setFallbackPrompt(event.target.value)} required/></div>
    </section>

    <div className="template-builder">
      <section className="template-library card" aria-labelledby="content-library-title">
        <span className="eyebrow">Bibliothèque</span><h2 id="content-library-title">Ajouter un contenu validé</h2>
        <p>Les modifications futures du contenu seront reprises automatiquement par la trame.</p>
        {options.length ? <><div className="field"><label htmlFor="template-content">Contenu disponible</label><select id="template-content" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{options.map((option) => <option value={option.id} key={option.id}>{option.title} · {option.type === "onboarding" ? "Parcours" : "Article"}</option>)}</select></div><button className="secondary template-add" type="button" onClick={add}><Plus size={16}/> Ajouter à la trame</button></> : <div className="empty compact">Publiez d’abord un contenu pour pouvoir l’ajouter.</div>}
      </section>

      <section className="template-sequence" aria-labelledby="template-sequence-title">
        <div className="section-heading"><div><span className="eyebrow">Ordre de référence</span><h2 id="template-sequence-title">La trame suivie par Charly</h2></div><span className="sequence-count">{nodes.length} étape{nodes.length > 1 ? "s" : ""}</span></div>
        {nodes.length === 0 ? <div className="template-empty card"><GitBranch size={28}/><strong>La trame est vide</strong><p>Ajoutez les parcours que Charly doit proposer quand le membre ne sait pas par où commencer.</p></div> : <ol className="template-node-list">{nodes.map((node, index) => {
          const option = optionMap.get(node.contentItemId);
          if (!option) return null;
          return <li className={`template-node depth-${node.depth}`} key={node.id}>
            <span className="template-connector" aria-hidden="true"/>
            <article className="card">
              <div className="template-node-order"><span>{String(index + 1).padStart(2, "0")}</span>{node.depth > 0 ? <small>Branche niveau {node.depth}</small> : <small>Étape principale</small>}</div>
              <div className="template-node-content"><strong>{option.title}</strong><small>{option.type === "onboarding" ? "Parcours" : "Article"} · {option.agentKey}</small><label><span>À proposer…</span><input value={node.trigger} onChange={(event) => updateNode(node.id, { trigger: event.target.value })} required/></label><label className="template-optional"><input type="checkbox" checked={node.optional} onChange={(event) => updateNode(node.id, { optional: event.target.checked })}/> Cette étape peut être ignorée sans bloquer la suite</label></div>
              <div className="template-node-actions">
                <button type="button" aria-label={`Monter ${option.title}`} title="Monter" onClick={() => move(index, -1)} disabled={index === 0}><ArrowUp size={15}/></button>
                <button type="button" aria-label={`Descendre ${option.title}`} title="Descendre" onClick={() => move(index, 1)} disabled={index === nodes.length - 1}><ArrowDown size={15}/></button>
                <button type="button" aria-label={`Réduire le niveau de ${option.title}`} title="Réduire le niveau" onClick={() => changeDepth(index, -1)} disabled={node.depth === 0}><ArrowLeft size={15}/></button>
                <button type="button" aria-label={`Placer ${option.title} comme branche`} title="Créer une branche" onClick={() => changeDepth(index, 1)} disabled={index === 0 || node.depth >= Math.min(2, nodes[index - 1].depth + 1)}><ArrowRight size={15}/></button>
                <button className="remove" type="button" aria-label={`Retirer ${option.title}`} title="Retirer" onClick={() => setNodes((current) => current.filter((item) => item.id !== node.id))}><Trash2 size={15}/></button>
              </div>
            </article>
          </li>;
        })}</ol>}
      </section>
    </div>

    <section className="template-save card"><div><span className="eyebrow">Brouillon</span><h2>Enregistrer cette organisation</h2><p>La version publiée reste active tant que l’administrateur ne valide pas ce nouveau brouillon.</p></div><div className="field"><label htmlFor="template-change-note">Ce qui change</label><input id="template-change-note" name="changeNote" required placeholder="Ex. LinkedIn devient le premier parcours proposé"/></div><button className="primary" disabled={!nodes.length}>Enregistrer le brouillon</button></section>
  </form>;
}
