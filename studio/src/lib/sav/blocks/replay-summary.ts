import type { SavReplayReport } from "./block-replay";
import type { SavReplaySpendTotals } from "./replay-decision";

/*
 * SAV-92 harness, phase 1b: the short French summary of a replay report, for Ugo. Pure. It counts and quotes what the report holds
 * (blocks taken, team, questions, refusals, cost) and shows at most `replies` replies the agent would have sent, cut; never a raw mail.
 */

const usd = (value: number) => `${value.toFixed(4)} USD`;
const SCOPE_LABELS: Record<string, string> = { approved: "périmètre approuvé (valeurs de production fournies)", draft: "brouillon du bloc converti en périmètre (ses fiches à la version retrouvée)" };
/** M1: which block scope the decisions were checked against; a decision without one is said NOT checked, never hidden. */
function scopeLine(scopes: readonly string[]): string {
  if (!scopes.length) return "aucune décision calculée.";
  const unchecked = scopes.filter(scope => scope === "not_checked").length;
  const kinds = [...new Set(scopes.filter(scope => scope !== "not_checked"))].map(scope => SCOPE_LABELS[scope] ?? scope);
  return `${kinds.length ? `vérifié par le chemin de production (${kinds.join(" ; ")})` : ""}${unchecked ? `${kinds.length ? " ; " : ""}**non vérifié pour ${unchecked} décision(s)** : ne pas s'en servir pour activer le bloc` : ""}.`;
}
const cut = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

export function savReplayMarkdownSummary(report: SavReplayReport, context: Readonly<{ blockId: string; model: string; transport: "stub" | "live"; spend: SavReplaySpendTotals; replies?: number }>): string {
  const items = report.items, done = items.flatMap(item => item.decision.status === "done" && item.decision.detail ? [{ item, detail: item.decision.detail }] : []);
  const count = (predicate: (detail: (typeof done)[number]["detail"]) => boolean) => done.filter(row => predicate(row.detail)).length;
  const outcomes = Object.entries(report.totals.byOutcome).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key} : ${value}`).join(" ; ") || "aucun";
  const refusals = new Map<string, number>();
  for (const row of done) for (const code of new Set(row.detail.refusals.flatMap(refusal => refusal.codes))) refusals.set(code, (refusals.get(code) ?? 0) + 1);
  const lines = [
    `# Rejeu du bloc « ${context.blockId} »`,
    "",
    `- Aucun effet : aucun mail, aucune écriture HubSpot, aucun Slack, aucun dossier modifié, aucun registre de production écrit.`,
    `- Modèle : ${context.transport === "live" ? `réel (${context.model})` : "bouchon déterministe (aucun appel au modèle)"}.`,
    `- Éléments rejoués : ${report.totals.items} ; échecs de lecture ou de recherche : ${report.totals.failures}.`,
    `- Attribution : ${outcomes}.`,
    `- Décisions calculées : ${done.length} ; réponses : ${count(detail => detail.action === "answer")} ; questions : ${count(detail => detail.action === "ask")} ; équipe : ${count(detail => detail.action === "team" || detail.action === "handoff")} ; sans réponse : ${count(detail => detail.reply === null && detail.action !== "team" && detail.action !== "handoff")}.`,
    `- Refus du validateur : ${refusals.size ? [...refusals].map(([code, value]) => `${code} (${value})`).join(", ") : "aucun"}.`,
    `- Coût : estimé ${usd(report.totals.decisionEstimatedUsd)}, réel ${usd(context.spend.actualUsd)}, plafond ${usd(context.spend.runCapUsd)} par rejeu et ${usd(context.spend.mailCapUsd)} par mail ; appels refusés par le plafond : ${context.spend.refused}.`,
    `- Recherche de fiches : ${context.spend.embeddingCalls} appel(s) d'embedding (${context.spend.embeddingQueries} requête(s)), estimé ${usd(context.spend.embeddingEstimatedUsd)}, compté dans le plafond${context.spend.embeddingRefused ? ` ; ${context.spend.embeddingRefused} refusé(s) par le plafond` : ""}.`,
    `- Périmètre du bloc : ${scopeLine(done.map(row => row.detail.scope))}`,
    ...(report.totals.budgetStopped ? ["- **Plafond atteint : le rejeu a cessé de décider.** Les éléments suivants sont marqués « skipped_budget »."] : []),
    "",
    "## Réponses que l'agent aurait envoyées",
  ];
  const shown = done.filter(row => row.detail.reply).slice(0, context.replies ?? 5);
  if (!shown.length) lines.push("", "Aucune.");
  for (const { item, detail } of shown) {
    lines.push("", `### ${item.ref} — ${detail.action}${detail.requests.length > 1 ? ` (${detail.requests.length} demandes : ${detail.requests.map(row => `${row.id} ${row.action}`).join(", ")})` : ""}`, "",
      ...cut(detail.reply!.text, 1500).split("\n").map(line => `> ${line}`));
  }
  return `${lines.join("\n")}\n`;
}
