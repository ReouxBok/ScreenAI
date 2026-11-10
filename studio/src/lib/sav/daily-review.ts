import { z } from "zod";
import { monitorCodes } from "./monitor-contract";

/**
 * SAV-16 daily review. Pure, read-only: it groups already-collected metadata (monitor snapshot codes and
 * per-dossier stage timestamps, V1 and V2 alike) by cause, with exact coverage, age and a next action.
 * It never reads the DB, never repairs registry/budget/lease/clients, never sends anything.
 * Input carries no message body, email address or secret: ids are opaque and checked by pattern.
 */
const at = z.iso.datetime();
const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const stage = z.object({ requestedAt: at.nullable(), workerStartedAt: at.nullable(), workerFinishedAt: at.nullable(), effectAt: at.nullable(),
  workerTelemetryComplete: z.boolean().optional(), effectExpected: z.boolean().nullable().optional(),
  outcome: z.enum(["succeeded", "failed", "uncertain", "pending", "paused_by_human"]), errorCode: z.string().regex(/^[a-z0-9_.:-]{1,64}$/).nullable() }).strict();
const dossier = z.object({ id: opaqueId, engine: z.enum(["v1", "v2"]), stage }).strict();
export const dailyReviewInputSchema = z.object({
  window: z.object({ from: at, to: at }).strict(),
  monitor: z.object({ observedAt: at, complete: z.boolean(),
    issues: z.array(z.object({ code: z.enum(monitorCodes), count: z.number().int().nonnegative(), severity: z.enum(["warning", "critical"]) }).strict()).max(monitorCodes.length) }).strict().nullable(),
  dossiers: z.array(dossier).max(5000),
}).strict();
export type DailyReviewInput = z.infer<typeof dailyReviewInputSchema>;

/** Each stage is distinct: a platform request is not a worker start, a finish is not a client effect. */
export type DailyCause =
  | "no_pulse"            // requested, no worker start observed: execution remains unproven
  | "worker_unfinished"   // started, no finish: stalled or crashed, outcome unknown
  | "worker_failed"       // finished with an explicit failure code
  | "effect_missing"      // worker finished as succeeded but no client effect recorded
  | "effect_uncertain"    // effect state uncertain: verify only, never resend
  | "unknown"             // stage data incoherent or missing request: cannot classify
  | "paused_by_human"     // expected wait, not a failure
  | "succeeded";
export type CauseGroup = { cause: DailyCause; errorCode: string | null; count: number; byEngine: { v1: number; v2: number };
  oldestAgeSeconds: number; sampleIds: string[]; nextAction: string };
export type LocalTask = { cause: DailyCause; errorCode: string | null; repro: string; fixtureIds: string[]; allowedPaths: string[]; tests: string[]; stopIf: string[] };
export type DailyReview = { window: { from: string; to: string }; coverage: { dossiers: number; classified: number; unknown: number; byEngine: { v1: number; v2: number } };
  monitor: { state: "absent" | "partial" | "complete"; critical: string[]; warning: string[] };
  groups: CauseGroup[]; tasks: LocalTask[]; status: { patched: false; tested: false; reviewed: false; published: false; deployed: false } };

const NEXT: Record<DailyCause, string> = {
  no_pulse: "Vérifier le déclencheur et le cron (lecture des diagnostics) ; aucune relance globale.",
  worker_unfinished: "Lire les logs du run ; ne pas relancer, ne pas libérer le bail.",
  worker_failed: "Reproduire localement le code d'erreur avec une fixture synthétique.",
  effect_missing: "Comparer fin worker et journal d'effets ; aucun renvoi client.",
  effect_uncertain: "Vérification humaine seulement ; jamais de renvoi automatique.",
  unknown: "Compléter la collecte ; aucun rétablissement déduit.",
  paused_by_human: "Attente attendue (pause humaine) ; rien à faire.",
  succeeded: "Rien à faire.",
};
const MAX_SAMPLES = 5, MAX_TASKS = 2;

export function classifyStage(s: DailyReviewInput["dossiers"][number]["stage"]): DailyCause {
  if (s.outcome === "paused_by_human") return "paused_by_human";
  const order = [s.requestedAt, s.workerStartedAt, s.workerFinishedAt, s.effectAt];
  for (let i = 1; i < order.length; i++) for (let j = 0; j < i; j++)
    if (order[i] && order[j] && Date.parse(order[i]!) < Date.parse(order[j]!)) return "unknown";
  if (!s.requestedAt) return "unknown";
  if (s.outcome === "uncertain") return "effect_uncertain";
  if (!s.workerStartedAt) return s.workerFinishedAt || s.effectAt || !s.workerTelemetryComplete ? "unknown" : "no_pulse";
  if (!s.workerFinishedAt) return s.effectAt ? "unknown" : "worker_unfinished";
  if (s.outcome === "failed") return "worker_failed";
  if (s.outcome === "succeeded") return s.effectAt ? "succeeded" : s.effectExpected === true ? "effect_missing" : "unknown";
  return "unknown"; // a finish paired with pending is incoherent, never a failure
}

export function buildDailyReview(raw: unknown): DailyReview {
  const input = dailyReviewInputSchema.parse(raw);
  const to = Date.parse(input.window.to);
  if (to < Date.parse(input.window.from)) throw Error("DAILY_REVIEW_WINDOW_INVALID");
  const seen = new Set<string>(), groups = new Map<string, CauseGroup>(), byEngine = { v1: 0, v2: 0 };
  let unknown = 0;
  for (const d of input.dossiers) {
    const key0 = `${d.engine}:${d.id}`;
    if (seen.has(key0)) throw Error("DAILY_REVIEW_DUPLICATE_DOSSIER");
    seen.add(key0); byEngine[d.engine]++;
    const cause = classifyStage(d.stage);
    if (cause === "unknown") unknown++;
    const errorCode = cause === "worker_failed" ? d.stage.errorCode ?? "unspecified" : null;
    const key = `${cause}|${errorCode ?? ""}`;
    const g = groups.get(key) ?? { cause, errorCode, count: 0, byEngine: { v1: 0, v2: 0 }, oldestAgeSeconds: 0, sampleIds: [], nextAction: NEXT[cause] };
    g.count++; g.byEngine[d.engine]++;
    const since = d.stage.requestedAt ?? d.stage.workerStartedAt;
    if (since) g.oldestAgeSeconds = Math.max(g.oldestAgeSeconds, Math.max(0, Math.floor((to - Date.parse(since)) / 1000)));
    if (g.sampleIds.length < MAX_SAMPLES) g.sampleIds.push(key0);
    groups.set(key, g);
  }
  const rank: DailyCause[] = ["effect_uncertain", "worker_failed", "effect_missing", "worker_unfinished", "no_pulse", "unknown", "paused_by_human", "succeeded"];
  const sorted = [...groups.values()].sort((a, b) => rank.indexOf(a.cause) - rank.indexOf(b.cause) || b.count - a.count || (a.errorCode ?? "").localeCompare(b.errorCode ?? ""));
  // Only reproducible, locally fixable causes become agent tasks; uncertain/unknown/paused stop at a human.
  const tasks: LocalTask[] = sorted.filter(g => g.cause === "worker_failed" || g.cause === "effect_missing").slice(0, MAX_TASKS).map(g => ({
    cause: g.cause, errorCode: g.errorCode,
    repro: `Fixture synthétique example.invalid reproduisant ${g.cause}${g.errorCode ? ` (${g.errorCode})` : ""} sur ${g.byEngine.v1} V1 / ${g.byEngine.v2} V2.`,
    fixtureIds: g.sampleIds, allowedPaths: ["studio/src/lib/sav/daily-review*", "studio/src/lib/sav/intake/*.test.ts"],
    tests: ["node_modules/.bin/vitest run --maxWorkers=2 <test ciblé>"],
    stopIf: ["cause incertaine", "permission ou accès production requis", "régression d'un test existant", "réparation registre/budget/bail/client nécessaire"],
  }));
  const m = input.monitor;
  return { window: input.window,
    coverage: { dossiers: input.dossiers.length, classified: input.dossiers.length - unknown, unknown, byEngine },
    monitor: { state: !m ? "absent" : m.complete ? "complete" : "partial",
      critical: (m?.issues ?? []).filter(i => i.severity === "critical" && i.count > 0).map(i => `${i.code}:${i.count}`),
      warning: (m?.issues ?? []).filter(i => i.severity === "warning" && i.count > 0).map(i => `${i.code}:${i.count}`) },
    groups: sorted, tasks, status: { patched: false, tested: false, reviewed: false, published: false, deployed: false } };
}

/** French plain-text rendering: fixed vocabulary, opaque ids, integers only. */
export function renderDailyReview(r: DailyReview): string {
  const lines = [`Revue SAV quotidienne — ${r.window.from} → ${r.window.to}`,
    `Couverture : ${r.coverage.dossiers} dossiers (V1 ${r.coverage.byEngine.v1}, V2 ${r.coverage.byEngine.v2}), ${r.coverage.classified} classés, ${r.coverage.unknown} inconnus.`,
    `Surveillance : ${r.monitor.state === "absent" ? "aucun instantané" : r.monitor.state === "partial" ? "collecte partielle, aucun rétablissement déduit" : "collecte complète"}` +
      `${r.monitor.critical.length ? ` ; critiques ${r.monitor.critical.join(", ")}` : ""}${r.monitor.warning.length ? ` ; alertes ${r.monitor.warning.join(", ")}` : ""}.`, ""];
  for (const g of r.groups) lines.push(`• ${g.cause}${g.errorCode ? ` [${g.errorCode}]` : ""} : ${g.count} (V1 ${g.byEngine.v1}, V2 ${g.byEngine.v2}), plus ancien ${g.oldestAgeSeconds} s — ${g.nextAction}`);
  lines.push("", `Tâches locales proposées : ${r.tasks.length} (max ${MAX_TASKS}). Statut : non corrigé, non testé, non revu, non publié, non déployé.`);
  return lines.join("\n");
}
