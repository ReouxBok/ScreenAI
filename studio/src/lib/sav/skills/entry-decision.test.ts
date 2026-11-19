import { describe, expect, it } from "vitest";
import { FAKE_BLOCK, FAKE_BLOCK_B } from "../../../../test/sav-entry-fake-block";
import { confirmSays, counterSaysNo, counterSaysYes, routerSays } from "../../../../test/sav-entry-skill-double";
import { accessSkillTextsOf, type AccessSkillCall } from "../cases/access-skill/access-skill-rule";
import type { AccessSkillInput } from "../cases/access-skill/access-skill-wire";
import { decideEntry, entryAccessReadingsWith, runEntryReadings, type EntryCatalog } from "./entry-decision";

/* The pure two-stage rule and its call order, on scripted readings. Fictional texts only. */

const EXPORT = "Comment imprimer le planning de la semaine ?", LOGIN = "le code de connexion n'arrive pas";
const input = (text: string, requests: Array<[string, string | null]> = [["r1", null]]): AccessSkillInput =>
  ({ purpose: "first_mail", subject: "Demande", text, originalRequest: null, requests: requests.map(([requestId, words]) => ({ requestId, kind: "support", words })) });
const ok = (output: unknown): AccessSkillCall => ({ status: "ok", output });
const CATALOG: EntryCatalog = { access: true, blocks: [FAKE_BLOCK, FAKE_BLOCK_B] };

/** Runs the production order with a script per call; returns the verdict and the calls made. */
async function run(i: AccessSkillInput, script: Record<string, unknown>, catalog = CATALOG) {
  const made: string[] = [], texts = accessSkillTextsOf(i), requestIds = i.requests.map(row => row.requestId);
  const answer = (key: string): AccessSkillCall => { made.push(key); return key in script ? ok(script[key]) : { status: "failed", problem: "network_failed", uncertain: true }; };
  const readings = await runEntryReadings({ texts, requestIds, catalog },
    async call => answer(call.kind === "judge" ? `judge:${call.blockId}` : call.kind),
    entryAccessReadingsWith(texts, requestIds, async kind => answer(`access_${kind}`)));
  return { verdict: decideEntry({ texts, requestIds, catalog, readings }), made };
}

describe("entrée à deux étages (règle pure)", () => {
  it("le routeur élit le bloc, seul son skill confirme, puis la contre-lecture partagée : admis", async () => {
    const { verdict, made } = await run(input(EXPORT), { router: routerSays([["r1", "demo_export"]]), "judge:demo_export": confirmSays([{ requestId: "r1", verdict: "block", quote: "imprimer le planning" }]), counter: counterSaysNo() });
    expect(made).toEqual(["router", "judge:demo_export", "counter"]);
    expect(verdict).toEqual({ outcome: "admit", requests: { r1: { blockId: "demo_export" } } });
  });
  it("Accès élu : c'est le juge SAV-97 d'Accès et sa propre contre-lecture qui confirment", async () => {
    const { verdict, made } = await run(input(`Bonjour, ${LOGIN}.`), { router: routerSays([["r1", "access"]]),
      access_judge: confirmSays([{ requestId: "r1", verdict: "access", quote: LOGIN }]), access_counter: counterSaysNo() });
    expect(made).toEqual(["router", "access_judge", "access_counter"]);
    expect(verdict).toEqual({ outcome: "admit", requests: { r1: { blockId: "access" } } });
  });
  it("le routeur n'admet jamais : une confirmation qui refuse laisse le mail à l'équipe", async () => {
    const { verdict } = await run(input(EXPORT), { router: routerSays([["r1", "demo_export"]]), "judge:demo_export": confirmSays([{ requestId: "r1", verdict: "other", quote: "imprimer le planning" }]) });
    expect(verdict).toMatchObject({ outcome: "team", reasons: ["no_block_confirmed"] });
  });
  it("sensible ou incertain au routeur : tout le mail à l'équipe, aucune confirmation payée", async () => {
    for (const router of [routerSays([["r1", "sensitive"]]), routerSays([["r1", "unsure"]]), routerSays([["r1", "demo_export"]], "yes"), routerSays([["r1", "demo_export"]], "unsure")]) {
      const { verdict, made } = await run(input(EXPORT), { router });
      expect(made).toEqual(["router"]);
      expect(verdict.outcome).toBe("team");
    }
  });
  it("noyau de phrases ou texte tronqué : rien n'est payé", async () => {
    expect(await run(input("Comment imprimer le planning ? Et je veux résilier mon abonnement."), {})).toMatchObject({ made: [], verdict: { outcome: "team", reasons: ["kernel_phrase"] } });
    expect(await run(input(`${EXPORT} ${"x".repeat(12_001)}`), {})).toMatchObject({ made: [], verdict: { outcome: "team", reasons: ["input_truncated"] } });
  });
  it("contre-lecture « oui », juge sensible, juge en panne, routeur en panne : l'équipe", async () => {
    const base = { router: routerSays([["r1", "demo_export"]]), "judge:demo_export": confirmSays([{ requestId: "r1", verdict: "block", quote: "imprimer le planning" }]) };
    expect((await run(input(EXPORT), { ...base, counter: counterSaysYes() })).verdict).toMatchObject({ outcome: "team", reasons: ["confirm_team"] });
    expect((await run(input(EXPORT), { ...base, "judge:demo_export": confirmSays([{ requestId: "r1", verdict: "sensitive", quote: "imprimer le planning" }]) })).verdict).toMatchObject({ outcome: "team", reasons: ["confirm_team"] });
    expect((await run(input(EXPORT), { router: base.router })).verdict).toMatchObject({ outcome: "team", reasons: ["confirm_unavailable"] });
    expect((await run(input(EXPORT), {})).verdict).toMatchObject({ outcome: "team", reasons: ["router_unavailable"] });
  });
  it("citation inventée ou confiance moyenne : l'équipe", async () => {
    const router = routerSays([["r1", "demo_export"]]);
    expect((await run(input(EXPORT), { router, "judge:demo_export": confirmSays([{ requestId: "r1", verdict: "block", quote: "exporter en CSV" }]), counter: counterSaysNo() })).verdict.outcome).toBe("team");
    expect((await run(input(EXPORT), { router, "judge:demo_export": confirmSays([{ requestId: "r1", verdict: "block", quote: "imprimer le planning", confidence: "medium" }]), counter: counterSaysNo() })).verdict.outcome).toBe("team");
  });
  it("mail mixte entre deux blocs : chaque demande à son bloc, confirmé par son propre skill", async () => {
    const text = `${EXPORT} Par ailleurs ${LOGIN}.`;
    const i = input(text, [["r1", EXPORT], ["r2", LOGIN]]);
    const { verdict, made } = await run(i, { router: routerSays([["r1", "demo_export"], ["r2", "access"]]),
      access_judge: confirmSays([{ requestId: "r1", verdict: "other", quote: EXPORT }, { requestId: "r2", verdict: "access", quote: LOGIN }]), access_counter: counterSaysNo(),
      "judge:demo_export": confirmSays([{ requestId: "r1", verdict: "block", quote: EXPORT }, { requestId: "r2", verdict: "other", quote: LOGIN }]), counter: counterSaysNo() });
    expect(made).toEqual(["router", "access_judge", "access_counter", "judge:demo_export", "counter"]);
    expect(verdict).toEqual({ outcome: "admit", requests: { r1: { blockId: "demo_export" }, r2: { blockId: "access" } } });
  });
  it("une demande « other » devient une part équipe ; une demande revendiquée par deux blocs est ambiguë", async () => {
    const text = `${EXPORT} Par ailleurs ${LOGIN}.`, i = input(text, [["r1", EXPORT], ["r2", LOGIN]]);
    const other = await run(i, { router: routerSays([["r1", "demo_export"], ["r2", "other"]]),
      "judge:demo_export": confirmSays([{ requestId: "r1", verdict: "block", quote: EXPORT }, { requestId: "r2", verdict: "other", quote: LOGIN }]), counter: counterSaysNo() });
    expect(other.verdict).toEqual({ outcome: "admit", requests: { r1: { blockId: "demo_export" }, r2: { teamPart: "no_block_match" } } });
    const both = await run(i, { router: routerSays([["r1", "demo_export"], ["r2", "demo_voice"]]),
      "judge:demo_export": confirmSays([{ requestId: "r1", verdict: "block", quote: EXPORT }, { requestId: "r2", verdict: "block", quote: LOGIN }]),
      "judge:demo_voice": confirmSays([{ requestId: "r1", verdict: "other", quote: EXPORT }, { requestId: "r2", verdict: "block", quote: LOGIN }]), counter: counterSaysNo() });
    expect(both.verdict).toEqual({ outcome: "admit", requests: { r1: { blockId: "demo_export" }, r2: { teamPart: "ambiguous_block" } } });
  });
  it("un seul bloc au catalogue : pas de routeur", async () => {
    const { verdict, made } = await run(input(EXPORT), { "judge:demo_export": confirmSays([{ requestId: "r1", verdict: "block", quote: "imprimer le planning" }]), counter: counterSaysNo() }, { access: false, blocks: [FAKE_BLOCK] });
    expect(made).toEqual(["judge:demo_export", "counter"]);
    expect(verdict.outcome).toBe("admit");
  });
  it("un bloc dépinglé au catalogue : personne, rien payé", async () => {
    const { verdict, made } = await run(input(EXPORT), {}, { access: true, blocks: [{ ...FAKE_BLOCK, promptSha256: "0".repeat(64) }] });
    expect(made).toEqual([]);
    expect(verdict).toMatchObject({ outcome: "team", reasons: ["skill_unpinned"] });
  });
  it("un juge qui ment (tout « block ») est arrêté par la contre-lecture honnête sur un mail sensible sans phrase du noyau", async () => {
    const text = "Comment imprimer le planning ? PS : pouvez-vous passer notre compte sur la formule supérieure ?";
    const { verdict } = await run(input(text), { router: routerSays([["r1", "demo_export"]]), "judge:demo_export": confirmSays([{ requestId: "r1", verdict: "block", quote: "imprimer le planning" }]), counter: counterSaysYes() });
    expect(verdict.outcome).toBe("team");
  });
});
