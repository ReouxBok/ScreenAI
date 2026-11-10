import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fixture from "./simulation-fixtures/syn-rehearsal-report.common-1.r2.json";
import { readSimulationReport } from "./simulation-report";

// Pole B's synthetic SYN report, common-1 r2, exactly as delivered (sha256 400f5326…f907e), and in-memory variants that each break
// one rule. Nothing adapts the fixture to the reader: no customer data, no expectation invented.
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = (): Json => structuredClone(fixture) as Json;
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Json)[k])}`).join(",")}}` : JSON.stringify(v);
const rehash = (c: Json) => { c.expected.hash = createHash("sha256").update(canonical(c.expectedMeta.frozen), "utf8").digest("hex"); };
const byRef = (report: Json, ref: string) => report.cases.find((c: Json) => c.caseRef === ref);
const ok = (input: unknown) => { const read = readSimulationReport(input); if (read.state !== "ok") throw Error(read.reason); return read; };
const edited = (ref: string, edit: (c: Json, r: Json) => void) => { const r = clone(); edit(byRef(r, ref), r); return ok(r).cases.find(c => c.caseRef === ref)!; };
const rejected = (edit: (r: Json) => void) => { const r = clone(); edit(r); return readSimulationReport(r); };

describe("simulation report reader on B's common-1 r2 fixture, as delivered", () => {
  it("reads the real fixture: verdicts recomputed, 9 hashes identical, B08 a real double send over two keys, B09 and B10 not comparable, B10 sends unmeasured", () => {
    const read = ok(fixture);
    expect(read.cases.map(c => [c.caseRef, c.verdict])).toEqual([
      ["SYN-B01", "match"], ["SYN-B02", "refused_as_expected"], ["SYN-B03", "match"], ["SYN-B04", "match"], ["SYN-B05", "match"], ["SYN-B06", "match"], ["SYN-B07", "match"],
      ["SYN-B08", "mismatch"], ["SYN-B09", "not_comparable"], ["SYN-B10", "not_comparable"],
    ]);
    expect(read.totals).toEqual({ match: 6, mismatch: 1, refused_as_expected: 1, not_comparable: 2, not_probative: 0, invalid: 0, inconsistent: 0 });
    expect(read.cases.filter(c => c.expectation.startsWith("Empreinte recalculée par la console : identique"))).toHaveLength(9);
    expect(read.cases.every(c => c.problems.length === 0)).toBe(true);
    expect(read.cases[7]!.sends).toMatchObject({ double: true, duplicateKeys: [], label: "2 envois synthétiques sur 2 clés de réponse" });
    expect(read.cases[7]!.diff).toEqual([{ field: "sends.total", expected: "1", proposed: "2" }, { field: "envois", expected: "au plus 1", proposed: "2 au total, une fois par clé" }]);
    expect(read.cases[9]!).toMatchObject({ notComparable: ["effect.final : executor_not_run", "effect.reason : executor_not_run", "sends.total : executor_not_run"],
      sends: { label: "Envois non mesurés : l’exécuteur n’a pas tourné.", perKey: [], double: false } });
    expect(read.doubleSends).toBe(1);
    expect(read.phases).toBe("Attendus figés le 2026-10-31T00:29:59.309Z, passage lancé le 2026-10-31T00:29:59.316Z (horloge réelle, après le gel).");
    expect(read.base).toBe("19ef4900a9e95c8008de94c60b4bc8b9dfffb827 (arbre 1f757e6c) : code exact qui a produit le rapport");
    expect(read.cases[0]!.expectation).toContain("par rôle non décidé");
    expect(read.cases[0]!.expectation).toContain("Règle B7 non décidée : au plus un envoi attendu.");
  });

  it("F1/R2: only B's distribution sendsByReplyKey is read; a scalar or mean, the old name, or an inconsistent distribution rejects the report", () => {
    for (const edit of [
      (r: Json) => { byRef(r, "SYN-B01").executor.sendsByReplyKey = 1; },
      (r: Json) => { const e = byRef(r, "SYN-B01").executor; e.perReplyKey = e.sendsByReplyKey; delete e.sendsByReplyKey; },
      (r: Json) => { byRef(r, "SYN-B08").executor.sendsByReplyKey[1].replyKey = byRef(r, "SYN-B08").executor.sendsByReplyKey[0].replyKey; },
      (r: Json) => { byRef(r, "SYN-B08").executor.sendsByReplyKey[1].count = 2; },
      (r: Json) => { byRef(r, "SYN-B08").executor.replyKeys = 3; },
      (r: Json) => { byRef(r, "SYN-B08").executor.sendsByReplyKey = [{ replyKey: "k1", count: 1.5 }, { replyKey: "k2", count: 0.5 }]; },
      (r: Json) => { byRef(r, "SYN-B01").executor.sendsByReplyKey[0].count = -1; byRef(r, "SYN-B01").executor.syntheticSends = -1; },
      (r: Json) => { byRef(r, "SYN-B10").executor.replyKeys = 0; },
    ]) expect(rejected(edit).state).toBe("invalid");
    // [2,0] and [1,1] have the same total and mean: told apart.
    const twice = edited("SYN-B08", c => { c.executor.sendsByReplyKey[0].count = 2; c.executor.sendsByReplyKey[1].count = 0; });
    expect(twice.sends).toMatchObject({ double: true, duplicateKeys: [`${byRef(fixture, "SYN-B08").executor.sendsByReplyKey[0].replyKey} : 2`] });
    expect(twice.diff.at(-1)).toEqual({ field: "envois", expected: "au plus 1", proposed: "2 au total, dont 1 clé envoyée plusieurs fois" });
    // Unknown sends must be declared not comparable: compared, the case is invalid, never zero.
    expect(edited("SYN-B01", c => { c.executor = { simulated: true, syntheticSends: null, replyKeys: null, sendsByReplyKey: null }; }).problems)
      .toEqual(["envois inconnus mais comparés", "total d’envois comparé différent du compteur de l’exécuteur"]);
  });

  it("F3: the compared total of sends is bound to the executor's count; zero sent but one compared is invalid, never a match", () => {
    const zero = edited("SYN-B01", c => { c.executor.syntheticSends = 0; c.executor.sendsByReplyKey[0].count = 0; });
    expect(zero).toMatchObject({ verdict: "invalid", problems: ["total d’envois comparé différent du compteur de l’exécuteur"] });
  });

  it("F2/R1: frozen strictly before the run started and the run started no later than the proposal; equality or a reversed order is not probative", () => {
    expect(edited("SYN-B01", (c, r) => { r.run.startedAt = r.run.expectationsFrozenAt; }).verdict).toBe("not_probative");
    expect(edited("SYN-B01", c => { c.proposedAt = "2026-10-31T00:29:59.312Z"; }).verdict).toBe("not_probative");
    expect(edited("SYN-B01", c => { c.proposedAt = fixture.run.startedAt; }).verdict).toBe("match");
    expect(edited("SYN-B01", c => { c.expected.frozenAt = "2026-10-31T00:29:59.310Z"; }).verdict).toBe("not_probative");
    expect(edited("SYN-B01", (c, r) => { r.run.startedAt = "2026-10-31T00:29:59.300Z"; }).verdict).toBe("not_probative");
  });

  it("gate 3: the five fields, compared or declared unknown, once each, each expectation exactly the frozen hashed value", () => {
    expect(edited("SYN-B01", c => { c.expected.hash = "f".repeat(64); })).toMatchObject({ verdict: "invalid", expectation: "Empreinte non vérifiée par la console. Règle B7 non décidée : au plus un envoi attendu." });
    expect(edited("SYN-B01", c => { c.expectedMeta.frozen.expected.sends = 2; rehash(c); }).problems).toEqual(["attendu du champ sends.total différent de l’attendu figé"]);
    expect(edited("SYN-B01", c => { c.fields = c.fields.filter((f: Json) => f.field !== "sends.total" && f.field !== "refusals"); }).problems)
      .toEqual(["champ figé sends.total ni comparé ni déclaré non comparable", "champ figé refusals ni comparé ni déclaré non comparable"]);
    expect(edited("SYN-B01", c => { c.fields.push({ ...c.fields[0] }); }).problems).toEqual(["champ reply.purpose présent deux fois"]);
    expect(edited("SYN-B01", c => { c.fields.push({ field: "reply.tone", expected: "x", proposed: "x" }); }).problems).toEqual(["champ reply.tone inconnu"]);
    expect(edited("SYN-B10", c => { c.notComparable.push({ field: "reply.tone", reason: "unknown" }); }).problems).toEqual(["champ reply.tone inconnu"]);
    expect(edited("SYN-B01", c => { c.notComparable = [{ field: "effect.reason", reason: "unknown" }]; }).problems).toEqual(["champ effect.reason présent deux fois"]);
    expect(edited("SYN-B10", c => { c.notComparable = c.notComparable.filter((n: Json) => n.field !== "effect.reason"); }).problems).toEqual(["champ figé effect.reason ni comparé ni déclaré non comparable"]);
    expect(edited("SYN-B01", c => { c.expectedMeta.frozen.caseRef = "SYN-B02"; rehash(c); }).problems).toEqual(["attendu figé pour un autre dossier, scénario ou déroulé"]);
    expect(edited("SYN-B01", c => { c.expectedMeta.frozen.expected.sends = 1.5; c.fields[3].expected = 1.5; rehash(c); }).problems[0]).toBe("attendu figé hors du format haché (nombre non entier ou valeur non JSON)");
    expect(edited("SYN-B01", c => { c.refusals = ["recipient_changed"]; }).problems).toEqual(["refus du dossier différents des refus comparés"]);
    expect(edited("SYN-B09", c => { c.fields = [{ field: "reply.purpose", expected: "answer", proposed: "answer" }]; }).problems).toEqual(["dossier sans attendu figé mais avec des champs ou un objet figé"]);
    expect(rejected(r => { byRef(r, "SYN-B01").expectedMeta.frozen.expected.extra = 1; }).state).toBe("invalid");
  });

  it("verdict recomputed: refusals pass as expected only when frozen; a contradicted declaration is inconsistent, for every verdict", () => {
    expect(edited("SYN-B01", c => { c.fields[4].proposed = ["recipient_changed"]; c.refusals = ["recipient_changed"]; c.declaredVerdict = "refused_as_expected"; }).verdict).toBe("inconsistent");
    expect(edited("SYN-B01", c => { c.fields[4].proposed = ["recipient_changed"]; c.refusals = ["recipient_changed"]; c.declaredVerdict = "mismatch"; }).verdict).toBe("mismatch");
    expect(edited("SYN-B02", c => { c.declaredVerdict = "match"; }).verdict).toBe("inconsistent");
    expect(edited("SYN-B08", c => { c.declaredVerdict = "match"; }).verdict).toBe("inconsistent");
    expect(edited("SYN-B09", c => { c.declaredVerdict = "match"; }).verdict).toBe("inconsistent");
    expect(edited("SYN-B10", c => { c.declaredVerdict = "match"; }).verdict).toBe("inconsistent");
  });

  it("gate 1: anything not bounded, synthetic and simulated end to end rejects the whole report", () => {
    for (const edit of [
      (r: Json) => { byRef(r, "SYN-B03").executor.simulated = false; }, (r: Json) => { delete byRef(r, "SYN-B03").executor.simulated; },
      (r: Json) => { byRef(r, "SYN-B01").actions[0].simulated = false; }, (r: Json) => { delete byRef(r, "SYN-B01").actions[0].simulated; },
      (r: Json) => { r.run.provenance.executor = "real"; }, (r: Json) => { r.run.provenance.provider = "synthetic-other"; }, (r: Json) => { r.run.provenance.model = "claude-opus-5-5"; },
      (r: Json) => { r.run.synthetic = false; }, (r: Json) => { r.run.provenance.cohort.kind = "customer"; }, (r: Json) => { r.run.provenance.cohort.cases = 11; },
      (r: Json) => { delete r.run.provenance; }, (r: Json) => { delete r.run.expectationsFrozenAt; },
      (r: Json) => { r.run.provenance.contract = "sav-v2-simulation-report.common-2"; }, (r: Json) => { r.kind = "other"; },
      (r: Json) => { byRef(r, "SYN-B02").proofs[1].ref = "1"; }, (r: Json) => { byRef(r, "SYN-B02").proofs = byRef(r, "SYN-B02").proofs.filter((p: Json) => p.kind !== "networkCalls"); },
      (r: Json) => { byRef(r, "SYN-B02").cost.paidCalls = 1; }, (r: Json) => { byRef(r, "SYN-B02").caseRef = "CLIENT-42"; }, (r: Json) => { byRef(r, "SYN-B02").caseRef = "SYN-B01"; },
    ]) expect(rejected(edit).state).toBe("invalid");
  });

  it("F4 and bounds: a string over 20,000 characters at any depth (compared values and keys included), oversize or too many cases is refused, not truncated", () => {
    const long = "x".repeat(20_001), tooLong = { state: "invalid", reason: "Texte trop long dans le rapport : refusé, pas tronqué." };
    expect(rejected(r => { byRef(r, "SYN-B01").fields[0].proposed = long; })).toEqual(tooLong);
    expect(rejected(r => { const c = byRef(r, "SYN-B01"); c.expectedMeta.frozen.expected.purpose = long; c.fields[0].expected = long; rehash(c); })).toEqual(tooLong);
    expect(rejected(r => { byRef(r, "SYN-B01").fields[0].proposed = { [long]: 1 }; })).toEqual(tooLong);
    expect(rejected(r => { r.cases = Array.from({ length: 14 }, () => r.cases).flat().map((c: Json, i: number) => ({ ...c, caseRef: `SYN-X${i}`, scenario: "z".repeat(19_000) })); r.run.provenance.cohort.cases = r.cases.length; }))
      .toEqual({ state: "invalid", reason: "Rapport trop volumineux pour cette page : refusé, pas tronqué." });
    expect(rejected(r => { const b09 = byRef(r, "SYN-B09"); r.cases = Array.from({ length: 501 }, (_, i) => ({ ...b09, caseRef: `SYN-X${i}` })); r.run.provenance.cohort.cases = 501; }).state).toBe("invalid");
  });

  it("imports only zod and node:crypto: no reader, writer, model, CRM, Gmail or filesystem module", () => {
    const imports = readFileSync(path.join(__dirname, "simulation-report.ts"), "utf8").split("\n").filter(line => line.startsWith("import"));
    expect(imports).toEqual(['import { createHash } from "node:crypto";', 'import { z } from "zod";']);
  });
});

describe("store refusals listed by a report: read-only wording, never a resend", () => {
  it("situation_already_answered (C's one-situation-one-send refusal) reads as already answered, code kept; another code is shown as is", () => {
    const b02 = edited("SYN-B02", c => { c.refusals = ["situation_already_answered", "trigger_already_approved"]; c.fields.find((f: Json) => f.field === "refusals").proposed = c.refusals; });
    expect(b02.refusals).toEqual(["situation_already_answered", "trigger_already_approved"]);
    expect(b02.refusalLines).toEqual(["Situation déjà répondue : une autre réponse est déjà validée, en file ou partie pour ce même mail du client ; refus, rien n’est renvoyé (situation_already_answered)", "trigger_already_approved"]);
    expect(b02.refusalLines.join(" ")).not.toMatch(/renvoyer|réessayer|resend|retry/i);
  });
});
