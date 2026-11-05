import { createHash } from "node:crypto";
import { z } from "zod";

// Rehearsal of the V2 cases (UX side): how the console reads pole B's simulated-run report, contract `common-1` revision 2 (B's
// CONTRACT_SIMULATION_REPORT_B_UX; envelope `proposal-1` kept). B owns the bench, the format and the SYN fixture; this reader applies
// the same gates as B's reference check (`checkCommonSimulationReport`), fail closed:
// - the whole report is rejected unless it is bounded (bytes, cases, every string at any depth), synthetic and simulated end to end
//   (provenance, every executor and action, one "0 network call" proof and no paid call per case), with unique SYN case refs, an exact
//   cohort count and a real send distribution per reply key (`sendsByReplyKey: [{ replyKey, count }]`, or all null when unknown);
// - a case is invalid unless its expectation is exactly what was frozen and hashed: hash, case, scenario, timeline, compared fields
//   plus explicit unknowns being the five fields once each, each compared expectation equal to the frozen value, and the observed
//   refusals and total sends equal to the case's refusals and to the executor's count;
// - frozen strictly before the run started and the run started no later than the proposal (the phases B measures), else not probative;
// - no expectation or any unknown field is not comparable; refusals pass as expected only when the frozen expectation lists them;
//   a declared verdict that differs from the recomputed one is inconsistent; more than one send is never a match.

export const SAV_V2_SIMULATION_REPORT_KIND = "sav-v2-simulation-report.proposal-1";
export const SAV_V2_SIMULATION_REPORT_CONTRACT = "sav-v2-simulation-report.common-1";
export const SIMULATION_REPORT_LIMITS = { bytes: 256 * 1024, cases: 500, string: 20_000, fields: 50 } as const;
const code = z.string().min(1).max(200);
const text = z.string().max(SIMULATION_REPORT_LIMITS.string);
const instant = z.string().max(40).refine(value => Number.isFinite(Date.parse(value)), "instant");
const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`));
const caseRef = z.string().regex(/^SYN-[A-Z0-9-]{1,40}$/);
const count = z.number().int().nonnegative();
const simulatedAction = z.object({
  kind: code, simulated: z.literal(true),
  // What C's executor did on the synthetic Gmail: never a real send.
  outcome: z.enum(["would_send", "held", "cancelled", "refused", "uncertain"]), reason: code.nullable(),
});
// The five compared fields and the key of the frozen expectation each one must equal.
const FROZEN_FIELD = { "reply.purpose": "purpose", "effect.final": "final", "effect.reason": "reason", "sends.total": "sends", refusals: "refusals" } as const;
type FrozenField = keyof typeof FROZEN_FIELD;
const frozenExpected = z.object({ purpose: z.unknown(), final: z.unknown(), reason: z.unknown(), sends: z.unknown(), refusals: z.unknown() }).strict();
const reportCase = z.object({
  caseRef, scenario: text,
  expected: z.object({ frozenAt: instant, hash: hex(64) }).nullable(),
  expectedMeta: z.object({
    canonicalization: z.literal("sorted-keys-json-utf8-sha256"), frozenBy: code.nullable(), b7Policy: code,
    frozen: z.object({ caseRef, scenario: text, timeline: z.array(code).max(50), expected: frozenExpected }).strict(),
  }).nullable(),
  proposedAt: instant.nullable(),
  fields: z.array(z.object({ field: code, expected: z.unknown(), proposed: z.unknown() })).max(SIMULATION_REPORT_LIMITS.fields),
  notComparable: z.array(z.object({ field: code, reason: code })).max(SIMULATION_REPORT_LIMITS.fields),
  declaredVerdict: code,
  refusals: z.array(code).max(50),
  // Raw here: an action or executor not marked simulated must reject the report, not vanish in a parse error of one case.
  actions: z.array(z.unknown()).max(50),
  executor: z.unknown(),
  proofs: z.array(z.object({ kind: code, ref: text })).max(50),
  cost: z.object({ modelCalls: count, paidCalls: count }),
  latencyMs: z.number().nonnegative().nullable(),
  timeline: z.array(code).max(50),
});
// R2: a real distribution per reply key (B's `sendsByReplyKey`), never a mean nor a scalar; or all three null when the executor never ran.
const executorSchema = z.union([
  z.object({ simulated: z.literal(true), syntheticSends: count, replyKeys: count, sendsByReplyKey: z.array(z.object({ replyKey: z.string().min(1).max(300), count })).max(50) })
    .refine(e => e.sendsByReplyKey.length === e.replyKeys && new Set(e.sendsByReplyKey.map(k => k.replyKey)).size === e.replyKeys
      && e.sendsByReplyKey.reduce((sum, k) => sum + k.count, 0) === e.syntheticSends),
  z.object({ simulated: z.literal(true), syntheticSends: z.null(), replyKeys: z.null(), sendsByReplyKey: z.null() }),
]);
const report = z.object({
  kind: z.literal(SAV_V2_SIMULATION_REPORT_KIND),
  run: z.object({
    id: code, startedAt: instant, expectationsFrozenAt: instant, base: z.object({ sha: hex(40), tree: hex(40) }), synthetic: z.literal(true),
    provenance: z.object({
      contract: z.literal(SAV_V2_SIMULATION_REPORT_CONTRACT), generator: code, executor: z.literal("simulated"),
      provider: z.literal("synthetic-gmail-no-socket"), model: z.literal("synthetic-double"),
      policy: z.object({ admission: code, executionPolicyHash: code, knowledge: code, rules: code, playbook: code, prompt: code }),
      cohort: z.object({ id: code, kind: z.literal("synthetic"), cases: count, selection: text }),
    }),
  }),
  cases: z.array(reportCase).max(SIMULATION_REPORT_LIMITS.cases),
}).refine(r => r.run.provenance.cohort.cases === r.cases.length && new Set(r.cases.map(c => c.caseRef)).size === r.cases.length);

const verdictLabels = {
  match: "Conforme à l’attendu", mismatch: "Différent de l’attendu", refused_as_expected: "Refus attendu, refus obtenu",
  not_comparable: "Non comparable : ne compte pas comme conforme", not_probative: "Non probant : attendu non figé avant le départ du passage, ou proposition avant le départ",
  invalid: "Invalide : ne compte pas", inconsistent: "Verdict déclaré incohérent avec le recalcul",
} as const;
export type SimulationVerdict = keyof typeof verdictLabels;
const actionLabels: Record<z.infer<typeof simulatedAction>["outcome"], string> = {
  would_send: "Aurait été envoyée (Gmail synthétique : rien n’est parti)", held: "Aurait été retenue", cancelled: "Aurait été annulée", refused: "Aurait été refusée",
  uncertain: "Envoi incertain simulé : vérification seule, aucun renvoi",
};

/** Read-only wording of a store refusal the report lists (C's codes). An unlabelled code is shown as is; no wording offers a resend. */
const refusalLabels: Readonly<Record<string, string>> = {
  situation_already_answered: "Situation déjà répondue : une autre réponse est déjà validée, en file ou partie pour ce même mail du client ; refus, rien n’est renvoyé",
};

/** The JSON domain B's canonicalization is defined on: strings, safe integers, booleans, null, arrays and plain objects. */
const inDomain = (value: unknown, depth = 0): boolean => depth <= 20 && (value === null || typeof value === "string" || typeof value === "boolean"
  || (typeof value === "number" && Number.isSafeInteger(value))
  || (Array.isArray(value) ? value.every(item => inDomain(item, depth + 1))
    : typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Object.values(value as object).every(item => inDomain(item, depth + 1))));
/** B's method: JSON with keys sorted at every depth, no spaces, UTF-8, then SHA-256. Only called on values `inDomain`. */
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
  : JSON.stringify(value) ?? "null";
const sha256 = (value: unknown) => createHash("sha256").update(canonical(value), "utf8").digest("hex");
const same = (a: unknown, b: unknown) => inDomain(a) && inDomain(b) && canonical(a) === canonical(b);
const shown = (value: unknown) => value === undefined ? "absent" : inDomain(value) ? canonical(value) : "valeur hors format";
/** Every string at any depth, keys included, within the contract's bound (values typed unknown included). */
const longString = (value: unknown, depth = 0): boolean => depth > 40 || (typeof value === "string" ? value.length > SIMULATION_REPORT_LIMITS.string
  : Array.isArray(value) ? value.some(item => longString(item, depth + 1))
  : value !== null && typeof value === "object" ? Object.entries(value).some(([key, item]) => longString(key) || longString(item, depth + 1)) : false);

export type SimulationCaseDisplay = Readonly<{
  caseRef: string; scenario: string; verdict: SimulationVerdict; verdictLabel: string; declared: string; problems: readonly string[];
  diff: readonly Readonly<{ field: string; expected: string; proposed: string }>[]; notComparable: readonly string[]; refusals: readonly string[]; refusalLines: readonly string[]; actions: readonly string[];
  sends: Readonly<{ label: string; double: boolean; perKey: readonly string[]; duplicateKeys: readonly string[] }>; expectation: string; proofs: readonly string[]; cost: string;
}>;
export type SimulationReportRead =
  | { state: "invalid"; reason: string }
  | { state: "ok"; runId: string; phases: string; base: string; sourceHash: string; provenance: readonly string[]; cases: readonly SimulationCaseDisplay[];
      totals: Readonly<Record<SimulationVerdict, number>>; doubleSends: number; paidCalls: number };

type Case = z.infer<typeof reportCase>;
type Executor = z.infer<typeof executorSchema>;
type Run = z.infer<typeof report>["run"];
function judge(row: Case, executor: Executor, run: Run) {
  const problems: string[] = [];
  const diff = row.fields.filter(f => !same(f.expected, f.proposed)).map(f => ({ field: f.field, expected: shown(f.expected), proposed: shown(f.proposed) }));
  // Total per case and sends per key are two measures: [1,1] (two keys, B7) and [2,0] (one key twice) are told apart. More than one
  // send for a situation is always a gap, whatever was frozen. Unknown sends (executor never ran) are unmeasured, never zero.
  const perKey = executor.sendsByReplyKey ?? [], double = (executor.syntheticSends ?? 0) > 1, duplicateKeys = perKey.filter(k => k.count > 1).map(k => `${k.replyKey} : ${k.count}`);
  if (double) diff.push({ field: "envois", expected: "au plus 1", proposed: `${executor.syntheticSends} au total, ${duplicateKeys.length ? `dont ${duplicateKeys.length} clé${duplicateKeys.length > 1 ? "s" : ""} envoyée${duplicateKeys.length > 1 ? "s" : ""} plusieurs fois` : "une fois par clé"}` });
  const unknownSends = executor.syntheticSends === null;
  if (unknownSends && !row.notComparable.some(n => n.field === "sends.total")) problems.push("envois inconnus mais comparés");
  const sendsField = row.fields.find(f => f.field === "sends.total");
  if (sendsField && sendsField.proposed !== executor.syntheticSends) problems.push("total d’envois comparé différent du compteur de l’exécuteur");
  const result = (computed: SimulationVerdict, expectation: string) =>
    ({ verdict: problems.length ? "invalid" as const : computed, problems, diff, double, duplicateKeys, expectation, declaredMatches: row.declaredVerdict === computed });
  if (!row.expected) {
    if (row.expectedMeta || row.fields.length || row.notComparable.length) problems.push("dossier sans attendu figé mais avec des champs ou un objet figé");
    return result("not_comparable", "Aucun attendu figé.");
  }
  const meta = row.expectedMeta;
  if (!meta) problems.push("attendu sans l’objet figé : empreinte non vérifiable");
  else if (!inDomain(meta.frozen)) problems.push("attendu figé hors du format haché (nombre non entier ou valeur non JSON)");
  else {
    if (sha256(meta.frozen) !== row.expected.hash) problems.push("empreinte de l’attendu différente de l’objet figé");
    if (meta.frozen.caseRef !== row.caseRef || meta.frozen.scenario !== row.scenario || !same(meta.frozen.timeline, row.timeline)) problems.push("attendu figé pour un autre dossier, scénario ou déroulé");
    // Gate 3: compared fields plus explicit unknowns are exactly the five fields, once each; each compared expectation IS the frozen value.
    const names = [...row.fields.map(f => f.field), ...row.notComparable.map(n => n.field)];
    for (const name of new Set(names)) {
      if (!(name in FROZEN_FIELD)) problems.push(`champ ${name} inconnu`);
      else if (names.filter(n => n === name).length > 1) problems.push(`champ ${name} présent deux fois`);
    }
    for (const field of Object.keys(FROZEN_FIELD)) if (!names.includes(field)) problems.push(`champ figé ${field} ni comparé ni déclaré non comparable`);
    for (const f of row.fields) { const key = FROZEN_FIELD[f.field as FrozenField]; if (key && !same(f.expected, meta.frozen.expected[key])) problems.push(`attendu du champ ${f.field} différent de l’attendu figé`); }
    const refusals = row.fields.find(f => f.field === "refusals");
    if (refusals && !same(refusals.proposed, row.refusals)) problems.push("refus du dossier différents des refus comparés");
  }
  const expectation = meta && !problems.some(p => p.startsWith("empreinte") || p.startsWith("attendu figé hors"))
    ? `Empreinte recalculée par la console : identique (figé le ${row.expected.frozenAt}, par ${meta.frozenBy ?? "rôle non décidé"}).` : "Empreinte non vérifiée par la console.";
  if (row.notComparable.length) return result("not_comparable", expectation);
  // R1: B's phases. Frozen strictly before the run started (all expectations at the run's freeze instant), run started no later than the proposal.
  const frozenAt = Date.parse(row.expected.frozenAt), startedAt = Date.parse(run.startedAt);
  if (row.expected.frozenAt !== run.expectationsFrozenAt || frozenAt >= startedAt || !row.proposedAt || Date.parse(row.proposedAt) < startedAt) return result("not_probative", expectation);
  const frozenRefusals = meta?.frozen.expected.refusals;
  return result(diff.length ? "mismatch" : Array.isArray(frozenRefusals) && frozenRefusals.length ? "refused_as_expected" : "match", expectation);
}

export function readSimulationReport(input: unknown): SimulationReportRead {
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(input) ?? "", "utf8"); } catch { return { state: "invalid", reason: "Rapport illisible : rien n’est affiché comme résultat." }; }
  if (size > SIMULATION_REPORT_LIMITS.bytes) return { state: "invalid", reason: "Rapport trop volumineux pour cette page : refusé, pas tronqué." };
  if (longString(input)) return { state: "invalid", reason: "Texte trop long dans le rapport : refusé, pas tronqué." };
  const parsed = report.safeParse(input);
  if (!parsed.success) return { state: "invalid", reason: "Format de rapport non reconnu par cette version (common-1 synthétique et simulé attendu) : rien n’est affiché comme résultat." };
  const { run } = parsed.data, totals = Object.fromEntries(Object.keys(verdictLabels).map(key => [key, 0])) as Record<SimulationVerdict, number>;
  const cases: SimulationCaseDisplay[] = [];
  for (const row of parsed.data.cases) {
    const reject = (why: string) => ({ state: "invalid" as const, reason: `${why} dans ${row.caseRef} : rapport rejeté, rien n’est présenté comme envoyé ou réussi.` });
    const actions = row.actions.map(action => simulatedAction.safeParse(action)), executor = executorSchema.safeParse(row.executor);
    if (!executor.success || actions.some(action => !action.success)) return reject("Exécuteur ou action non marqué simulé, ou envois par clé absents ou incohérents");
    const network = row.proofs.filter(p => p.kind === "networkCalls");
    if (network.length !== 1 || network[0]!.ref !== "0") return reject("Preuve « 0 appel réseau » absente ou différente de 0");
    if (row.cost.paidCalls !== 0) return reject("Appel payant");
    const judged = judge(row, executor.data, run), e = executor.data;
    // The declaration is checked last: an invalid or not probative case stays so (a bad clock is not hidden behind a bad declaration);
    // otherwise a contradicted declaration is inconsistent.
    const verdict: SimulationVerdict = judged.verdict === "invalid" || judged.verdict === "not_probative" || judged.declaredMatches ? judged.verdict : "inconsistent";
    totals[verdict] += 1;
    cases.push({
      caseRef: row.caseRef, scenario: row.scenario, verdict, verdictLabel: verdictLabels[verdict], declared: row.declaredVerdict, problems: judged.problems,
      diff: judged.diff, notComparable: row.notComparable.map(n => `${n.field} : ${n.reason}`), refusals: row.refusals,
      refusalLines: row.refusals.map(code => refusalLabels[code] ? `${refusalLabels[code]} (${code})` : code),
      actions: actions.map(action => { const a = action.data!; return `${a.kind} : ${actionLabels[a.outcome]}${a.reason ? ` (${a.reason})` : ""}`; }),
      sends: {
        double: judged.double, duplicateKeys: judged.duplicateKeys, perKey: (e.sendsByReplyKey ?? []).map(k => `${k.replyKey} : ${k.count}`),
        label: e.syntheticSends === null ? "Envois non mesurés : l’exécuteur n’a pas tourné."
          : `${e.syntheticSends} envoi${e.syntheticSends > 1 ? "s" : ""} synthétique${e.syntheticSends > 1 ? "s" : ""} sur ${e.replyKeys} clé${(e.replyKeys ?? 0) > 1 ? "s" : ""} de réponse`,
      },
      expectation: `${judged.expectation}${row.expectedMeta?.b7Policy === "undecided" ? " Règle B7 non décidée : au plus un envoi attendu." : ""}`,
      proofs: row.proofs.map(p => `${p.kind} ${p.ref}`),
      cost: `${row.cost.modelCalls} appel${row.cost.modelCalls > 1 ? "s" : ""} modèle synthétique, aucun payant${row.latencyMs === null ? ", latence non mesurée" : `, ${row.latencyMs} ms`}`,
    });
  }
  const p = run.provenance;
  return {
    state: "ok", runId: run.id, sourceHash: inDomain(input) ? sha256(input) : "non calculable",
    phases: `Attendus figés le ${run.expectationsFrozenAt}, passage lancé le ${run.startedAt} (horloge réelle, après le gel).`,
    base: `${run.base.sha} (arbre ${run.base.tree.slice(0, 8)}) : code exact qui a produit le rapport`,
    provenance: [`Contrat ${p.contract}`, `Exécuteur ${p.executor}, fournisseur ${p.provider}, modèle ${p.model}`, `Générateur ${p.generator}`,
      `Politique : admission ${p.policy.admission}, exécution ${p.policy.executionPolicyHash.slice(0, 12)}, connaissances ${p.policy.knowledge}, règles ${p.policy.rules}, playbook ${p.policy.playbook}, prompt ${p.policy.prompt}`,
      `Cohorte ${p.cohort.id} (${p.cohort.kind}, ${p.cohort.cases} dossiers) : ${p.cohort.selection}`],
    cases, totals, doubleSends: cases.filter(c => c.sends.double).length, paidCalls: 0,
  };
}
