import type { SmartReading, SmartTeamNote } from "./smart-contract";
import { SAV_SMART_FALLBACK_REASONS } from "./smart-contract";
import type { SmartCaseMemory } from "./smart-memory";
import { smartMask } from "./smart-net";

/*
 * Agent SAV intelligent (20/11, HARNAIS 4): the structured handoff note. Pure: no model, network, database or clock.
 *
 * Even when the knowledge falls short, the agent starts the investigation and hands the team something concrete: the need, what was understood,
 * what was checked and its source, what was tried and its result, the hypotheses and their state, THE next check, what the customer was told.
 *   render    the note as plain text for the team (Besoin / Compris / Vérifié (source) / Essayé → résultat / Hypothèses / À vérifier en premier /
 *             Dit au client), addresses, secrets and links removed. The Slack wiring (`case-handoff-notice.ts`) belongs to `smart-act`, not here.
 *   fallback  when the model could not write it (failure, budget, no progress, exchange cap): composed by the server from the memory and the reading.
 * A sensitive mail has no investigation note: only its families and « tout le mail à l'équipe » (`smartSensitiveNote`).
 */

const URL = /\bhttps?:\/\/\S+|\bwww\.\S+/giu;
const clean = (value: string | null | undefined) => smartMask(String(value ?? "")).replace(URL, "[lien retiré]").replace(/\s+/g, " ").trim();
const STATUS: Record<string, string> = { open: "ouverte", ouverte: "ouverte", ruled_out: "écartée", ecartee: "écartée", "écartée": "écartée", confirmed: "confirmée", confirmee: "confirmée", "confirmée": "confirmée" };

/** The note as text for the team. Never an address, a secret or a link. */
export function renderSmartTeamNote(note: SmartTeamNote): string {
  const lines = [`Raison : ${note.raison}`, `Besoin : ${clean(note.besoin)}`];
  if (note.compris.trim()) lines.push(`Compris : ${clean(note.compris)}`);
  if (note.verifie.length) lines.push("Vérifié :", ...note.verifie.map(row => `- ${clean(row.fait)}${row.source.trim() ? ` (source : ${clean(row.source)})` : ""}`));
  if (note.essaye.length) lines.push("Essayé :", ...note.essaye.map(row => `- ${clean(row.quoi)} → ${clean(row.resultat) || "résultat inconnu"}`));
  if (note.hypotheses.length) lines.push("Hypothèses :", ...note.hypotheses.map(row => `- ${clean(row.texte)} (${STATUS[row.statut.trim().toLowerCase()] ?? clean(row.statut)})`));
  lines.push(`À vérifier en premier : ${clean(note.prochaineVerification) || "à définir par l'équipe"}`);
  if (note.ditAuClient?.trim()) lines.push(`Dit au client : ${clean(note.ditAuClient)}`);
  return lines.join("\n");
}

export type SmartFallbackReason = typeof SAV_SMART_FALLBACK_REASONS[number];

/** The server's note when the model could not write one: everything the memory and the reading know, nothing invented. */
export function smartFallbackNote(input: Readonly<{ reason: SmartTeamNote["raison"]; reading: SmartReading | null; memory: SmartCaseMemory; modelNote?: SmartTeamNote | null }>): SmartTeamNote {
  const { memory, reading } = input;
  const needs = reading?.needs.length ? reading.needs.map(need => need.ask) : memory.needs.map(need => need.ask);
  const model = input.modelNote ?? null;
  const next = model?.prochaineVerification?.trim() || (input.reason === "pas_de_progres" || input.reason === "trop_d_echanges"
    ? "Reprendre le dossier avec le client : les essais proposés n'ont pas résolu le problème."
    : "Relire le dernier mail du client et vérifier le point qui bloque sur son compte.");
  return {
    raison: input.reason,
    besoin: (model?.besoin?.trim() || needs.join(" ; ") || "Demande du client à relire").slice(0, 600),
    compris: (model?.compris ?? memory.facts.filter(row => row.from === "client").map(row => row.text).join(" ; ")).slice(0, 800),
    verifie: [...(model?.verifie ?? []), ...memory.facts.filter(row => row.from !== "client").map(row => ({ fait: row.text, source: row.ref }))].slice(0, 6),
    essaye: [...(model?.essaye ?? []), ...memory.trials.map(row => ({ quoi: row.what, resultat: row.result === "worked" ? "réussi" : row.result === "failed" ? "échec" : "en attente" }))].slice(0, 6),
    hypotheses: [...(model?.hypotheses ?? []), ...memory.hypotheses.map(row => ({ texte: row.text, statut: STATUS[row.status] ?? row.status }))].slice(0, 6),
    prochaineVerification: next.slice(0, 400),
    ditAuClient: model?.ditAuClient ?? null,
  };
}

/** A sensitive mail: no investigation, only the families and the whole mail to the team. */
export const smartSensitiveNote = (families: readonly string[]) =>
  `Sujet sensible (${families.length ? families.join(", ") : "à qualifier"}) : tout le mail est transmis à l'équipe, sans réponse de l'assistant.`;
