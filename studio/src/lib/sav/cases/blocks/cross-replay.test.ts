import { describe, expect, it } from "vitest";
import type { CorpusCase, CorpusLabel } from "../../skills/corpus-contract";
import { decideEntry, entryAccessReadingsWith, runEntryReadings, type EntryCatalog, type EntryVerdict } from "../../skills/entry-decision";
import { SAV_ACCESS_SKILL_CORPUS } from "../access-skill/access-skill-corpus.fixture";
import { accessSkillEvalInput } from "../access-skill/access-skill-eval";
import { accessSkillTextsOf, type AccessSkillCall } from "../access-skill/access-skill-rule";
import type { AccessSkillInput } from "../access-skill/access-skill-wire";
import { CHARLY_MAX_BLIND_SET } from "./charly_max/charly-max-blind.fixture";
import { SAV_COLLABORATORS_BLIND_SET } from "./collaborators/collaborators-blind.fixture";
import { SAV_INTEGRATIONS_BLIND_SET } from "./integrations/integrations-blind.fixture";
import { SAV_ENTRY_SKILL_BLOCKS } from "./registry";

/*
 * Assembly of the « 3 blocs » (19/11): transverse consistency of the entry, deterministic, no model, network or money. Every corpus (the three blocks'
 * and Access's, plus the three frozen blind sets) goes through the REAL pure two-stage rule (`runEntryReadings` + `decideEntry`: kernel, truncation,
 * prompt-injection guard, router check, each elected block's confirmation, attribution of several requests, verbatim quotes, shared counter-read).
 * Only the model is simulated, HONESTLY from each case's labels: the router elects the labelled block when it is in the catalog (else `other`), names a
 * sensitive request `sensitive`; each confirmation says `block` for its own labelled requests, `sensitive` / `other` otherwise; the counter-read says
 * « yes » on a mail with a sensitive request. A second, MISROUTING router elects a wrong active block for every block request (confirmations honest).
 * Checked: no sensitive mail is ever admitted (not even in part); a request is only ever admitted to the block its label names (no cross admission);
 * the cross replay (a block's corpus with that block absent from the catalog) admits none of its requests.
 */

type Replay = Readonly<{ id: string; group: string; labels: ReadonlyMap<string, CorpusLabel>; input: AccessSkillInput }>;
const ALL = SAV_ENTRY_SKILL_BLOCKS;

function blockReplays(cases: readonly CorpusCase[], words?: Readonly<Record<string, Readonly<Record<string, string>>>>): Replay[] {
  return cases.map(row => ({ id: row.id, group: row.group, labels: new Map(row.requests.map(request => [request.requestId, request.expected])),
    input: { purpose: "first_mail", subject: row.subject ?? "", text: row.text, originalRequest: null,
      requests: row.requests.map(request => ({ requestId: request.requestId, kind: "support", words: row.requests.length > 1 ? words?.[row.id]?.[request.requestId] ?? null : null })) } }));
}
function accessReplays(): Replay[] {
  return SAV_ACCESS_SKILL_CORPUS.map(row => {
    const label = (verdict: "access" | "other" | "sensitive"): CorpusLabel => verdict === "access" ? { kind: "block", blockId: "access" } : verdict === "sensitive" ? { kind: "sensitive" } : { kind: "team" };
    const main = row.group === "access" ? "access" : row.group === "sensitive" ? "sensitive" : "other";
    const labels = new Map<string, CorpusLabel>([["r1", label(main)], ...(row.secondRequest ? [["r2", label(row.secondRequest.verdict)] as [string, CorpusLabel]] : [])]);
    return { id: row.id, group: row.group, labels, input: accessSkillEvalInput(row).input };
  });
}

const sensitiveCase = (replay: Replay) => replay.group === "sensitive" || [...replay.labels.values()].some(label => label.kind === "sensitive");
const labelBlock = (label: CorpusLabel | undefined) => label?.kind === "block" ? label.blockId : null;
/** Whole verbatim words of the mail (token boundaries kept), used as the quote when a request has no words of its own. */
const leadWords = (text: string) => text.trim().split(/\s+/).slice(0, 10).join(" ");

async function replay(row: Replay, catalog: EntryCatalog, router: "honest" | "misroute"): Promise<EntryVerdict> {
  const texts = accessSkillTextsOf(row.input), requestIds = row.input.requests.map(request => request.requestId);
  const ids = [...(catalog.access ? ["access"] : []), ...catalog.blocks.map(block => block.blockId)];
  const anySensitive = sensitiveCase(row);
  const quote = (requestId: string) => row.input.requests.find(request => request.requestId === requestId)?.words ?? leadWords(row.input.text);
  const ok = (output: unknown): AccessSkillCall => ({ status: "ok", output });
  const routeOf = (requestId: string) => {
    const label = row.labels.get(requestId), block = labelBlock(label);
    if (label?.kind === "sensitive") return "sensitive";
    if (router === "misroute" && block) return ids.find(id => id !== block) ?? "other";
    return block && ids.includes(block) ? block : "other";
  };
  const confirm = (blockId: string, own: string) => ok({
    mail: { sensitive: anySensitive ? "request" : "none", thirdParty: false, instructionLike: false },
    requests: requestIds.map(requestId => {
      const label = row.labels.get(requestId), sensitive = label?.kind === "sensitive";
      return { requestId, verdict: sensitive ? "sensitive" : labelBlock(label) === blockId ? own : "other", family: sensitive ? "finance" : null, confidence: "high", quote: quote(requestId), reason: "synthetic" };
    }),
    sensitiveMentions: [] });
  const counter = () => ok({ asksOrContestsSensitive: anySensitive ? "yes" : "no", families: anySensitive ? ["finance"] : [], quote: null, reason: "synthetic" });
  const readings = await runEntryReadings({ texts, requestIds, catalog },
    async call => call.kind === "router"
      ? ok({ mailSensitive: anySensitive ? "yes" : "no", requests: requestIds.map(requestId => ({ requestId, route: routeOf(requestId), reason: "synthetic" })) })
      : call.kind === "judge" ? confirm(call.blockId, "block") : counter(),
    entryAccessReadingsWith(texts, requestIds, async kind => kind === "judge" ? confirm("access", "access") : counter()));
  return decideEntry({ texts, requestIds, catalog, readings });
}

type Tally = { cases: number; admittedRequests: number; sensitiveAdmitted: string[]; crossAdmitted: string[]; byBlock: Record<string, number> };
async function tally(rows: readonly Replay[], catalog: EntryCatalog, router: "honest" | "misroute"): Promise<Tally> {
  const out: Tally = { cases: rows.length, admittedRequests: 0, sensitiveAdmitted: [], crossAdmitted: [], byBlock: {} };
  for (const row of rows) {
    const verdict = await replay(row, catalog, router);
    if (verdict.outcome !== "admit") continue;
    if (sensitiveCase(row)) out.sensitiveAdmitted.push(row.id);
    for (const [requestId, outcome] of Object.entries(verdict.requests)) {
      if (!("blockId" in outcome)) continue;
      out.admittedRequests += 1;
      out.byBlock[outcome.blockId] = (out.byBlock[outcome.blockId] ?? 0) + 1;
      if (labelBlock(row.labels.get(requestId)) !== outcome.blockId) out.crossAdmitted.push(`${row.id}/${requestId}->${outcome.blockId}`);
    }
  }
  return out;
}

const byId = (blockId: string) => ALL.find(block => block.blockId === blockId)!;
const CORPORA: ReadonlyArray<readonly [name: string, owner: string, rows: readonly Replay[]]> = [
  ["collaborators corpus", "collaborators", blockReplays(byId("collaborators").corpus, byId("collaborators").corpusRequestWords)],
  ["charly_max corpus", "charly_max", blockReplays(byId("charly_max").corpus, byId("charly_max").corpusRequestWords)],
  ["integrations corpus", "integrations", blockReplays(byId("integrations").corpus, byId("integrations").corpusRequestWords)],
  ["access corpus", "access", accessReplays()],
  ["collaborators blind", "collaborators", blockReplays(SAV_COLLABORATORS_BLIND_SET)],
  ["charly_max blind", "charly_max", blockReplays(CHARLY_MAX_BLIND_SET)],
  ["integrations blind", "integrations", blockReplays(SAV_INTEGRATIONS_BLIND_SET)],
];
/** Requests admitted per block by the honest chain, full catalog (measured at the assembly, 19/11; a change of a corpus or of the rule moves them). */
const HONEST_ADMISSIONS: Readonly<Record<string, Record<string, number>>> = {
  "collaborators corpus": { collaborators: 120, access: 18, charly_max: 11, integrations: 8 },
  "charly_max corpus": { charly_max: 120, access: 16, collaborators: 15, integrations: 16 },
  "integrations corpus": { integrations: 139, access: 23 },
  "access corpus": { access: 205 },
  "collaborators blind": { collaborators: 22, access: 4, charly_max: 3, integrations: 2 },
  "charly_max blind": { charly_max: 24, access: 4, collaborators: 3, integrations: 4 },
  "integrations blind": { integrations: 24, access: 3 },
};
const FULL: EntryCatalog = { access: true, blocks: ALL };

describe("cohérence transverse des 3 blocs et d'Accès (rejeu déterministe, simulateur honnête)", () => {
  it("les 3 blocs sont enregistrés, valides et différents", () => {
    expect(ALL.map(block => block.blockId)).toEqual(["collaborators", "charly_max", "integrations"]);
  });
  it.each(CORPORA)("%s, catalogue complet (Accès + 3 blocs), routeur honnête : 0 sensible admis, 0 admission croisée, des admissions réelles", async (_name, owner, rows) => {
    const result = await tally(rows, FULL, "honest");
    expect(result.sensitiveAdmitted).toEqual([]);
    expect(result.crossAdmitted).toEqual([]);
    // Not vacuous: the honest chain admits the block's own requests (and its neighbours' labelled requests to them). Exact, deterministic counts.
    expect(result.byBlock[owner] ?? 0).toBeGreaterThan(0);
    expect(result.byBlock).toEqual(HONEST_ADMISSIONS[_name]);
  });
  it.each(CORPORA)("%s, routeur qui se trompe de bloc (confirmations honnêtes) : 0 sensible admis, 0 admission croisée", async (_name, _owner, rows) => {
    const result = await tally(rows, FULL, "misroute");
    expect(result.sensitiveAdmitted).toEqual([]);
    expect(result.crossAdmitted).toEqual([]);
  });
  it.each(CORPORA.filter(([, owner]) => owner !== "access"))("%s, rejeu croisé (le bloc propriétaire retiré du catalogue) : aucune de ses demandes n'est admise ailleurs", async (_name, owner, rows) => {
    for (const router of ["honest", "misroute"] as const) {
      const result = await tally(rows, { access: true, blocks: ALL.filter(block => block.blockId !== owner) }, router);
      expect(result.byBlock[owner] ?? 0).toBe(0);
      expect(result.sensitiveAdmitted).toEqual([]);
      expect(result.crossAdmitted).toEqual([]);
    }
  });
  it("corpus d'Accès sans Accès au catalogue (les 3 blocs seuls) : aucune demande d'Accès admise par un bloc", async () => {
    const result = await tally(accessReplays(), { access: false, blocks: ALL }, "misroute");
    expect(result.byBlock.access ?? 0).toBe(0);
    expect(result.crossAdmitted).toEqual([]);
    expect(result.sensitiveAdmitted).toEqual([]);
  });
});
