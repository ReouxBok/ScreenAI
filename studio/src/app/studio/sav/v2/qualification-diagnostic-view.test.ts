import { describe, expect, it } from "vitest";
import { describeQualificationDiagnostic, QUALIFICATION_DIAGNOSTIC_REVISION, type ProposedQualificationDiagnostic } from "./qualification-diagnostic-view";

// UX lot 6 — NOT COMPOSED: DTO facts of pole A's PROPOSED qualification diagnostic (A/lot5/OBS1_PLAN.md §2). No reader of A exists in this tree; these tests
// pin the operator wording the page will use once ROOT composes A6's real reader under the page's access check.
const CASE = "20000000-0000-4000-8000-000000000001", SINCE = "2026-10-31T09:30:00.000Z";
const page = { caseId: CASE, version: 5 };
const date = (value: string) => `<${value}>`;
const dto = (over: Partial<Record<keyof ProposedQualificationDiagnostic, unknown>> = {}): ProposedQualificationDiagnostic =>
  ({ revision: QUALIFICATION_DIAGNOSTIC_REVISION, caseId: CASE, caseVersion: 5, state: "stale_ready", inputVersion: 5, since: SINCE, block: null, nature: null, ...over });
const show = (d: ProposedQualificationDiagnostic) => describeQualificationDiagnostic({ state: "ok", diagnostic: d }, page, date);
const text = (d: ProposedQualificationDiagnostic) => { const r = show(d); return `${r.title} ${r.detail ?? ""}`; };

describe("qualification diagnostic (proposed A6 DTO) → operator wording, NOT COMPOSED", () => {
  it("stale_ready: the input must be requalified; since is the input's arrival; nothing is proven and no action follows", () => {
    const r = show(dto());
    expect(r).toMatchObject({ tone: "warning", title: "À requalifier : la dernière entrée est un mail relayé lisible, la qualification doit repasser.", actionable: false });
    expect(r.detail).toContain(`Entrée à requalifier reçue le <${SINCE}>.`);
    expect(r.detail).toContain("Cette lecture ne prouve ni l’identité, ni les familles, ni l’admission, ni l’attribution ; aucune action n’en découle.");
    expect(`${r.title} ${r.detail}`).not.toMatch(/bloqué depuis|panne depuis|en panne|\badmis\b|prêt à traiter/i);
  });

  it("stale_blocked with a deterministic contract code: its closed sentence; the same date wording, never 'blocked since'", () => {
    for (const [block, words] of [["handback_unproven", "rendu par une personne"], ["acknowledgement_input", "accusé de réception"], ["relay_proof_invalid", "preuve de relais"],
      ["v1_source_mismatch", "source V1"], ["v1_requests_mismatch", "décision V1"], ["rule_invalid", "règle de qualification"]] as const) {
      const r = show(dto({ state: "stale_blocked", block, nature: "contract_blocked" }));
      expect(r.title, block).toContain("À requalifier, bloqué par le contrat :"); expect(r.title).toContain(words);
      expect(r.detail).toContain(`Entrée à requalifier reçue le <${SINCE}>.`);
      expect(`${r.title} ${r.detail}`).not.toMatch(/depuis/);
    }
  });

  it("a technical cause is never shown as recorded: 'cause technique non enregistrée', no past failure reconstructed", () => {
    for (const d of [dto({ state: "stale_blocked", block: "v1_context_unavailable", nature: "technical" }), dto({ state: "stale_blocked", block: "policy_unavailable", nature: "contract_blocked" }),
      dto({ state: "stale_blocked", block: "rule_invalid", nature: "technical" })]) {
      expect(show(d).title).toBe("À requalifier : cause technique non enregistrée (une panne passée n’est pas conservée).");
    }
  });

  it("stale_unknown, current and no_customer_input read as such; current carries no 'since'", () => {
    expect(show(dto({ state: "stale_unknown" })).title).toBe("À requalifier : la dernière entrée n’est pas un mail ; la cause n’est pas déterminée par cette lecture.");
    expect(show(dto({ state: "current" }))).toMatchObject({ tone: "neutral", title: "Qualification à jour : l’admission porte sur l’entrée la plus récente.", detail: null });
    expect(show(dto({ state: "no_customer_input" })).title).toBe("Aucune entrée client à qualifier.");
  });

  it("unknown state, revision, code or inherited key is unknown and never echoed", () => {
    expect(show(dto({ state: "zz_state" })).title).toBe("État de qualification non reconnu par cette version.");
    expect(show(dto({ revision: "sav-case-qualification-diagnostic.v9" })).title).toBe("Diagnostic de qualification dans un format que cette version ne lit pas.");
    for (const block of ["zz_private_code", "constructor", "__proto__", "toString", 7, null]) {
      const t = text(dto({ state: "stale_blocked", block, nature: "contract_blocked" }));
      expect(t, String(block)).toContain("À requalifier : cause non reconnue par cette version.");
      expect(t).not.toMatch(/zz_private_code|constructor|__proto__|toString/);
    }
    expect(text(dto({ state: "zz_state" }))).not.toContain("zz_state");
  });

  it("a diagnostic of another case is rejected; a stale case version is stated; a missing or bad date is 'non enregistrée'", () => {
    expect(show(dto({ caseId: "20000000-0000-4000-8000-000000000999" }))).toMatchObject({ tone: "danger", title: "Diagnostic de qualification rejeté : il ne concerne pas ce dossier." });
    expect(show(dto({ caseVersion: 4 })).detail).toContain("Établi sur la version 4 ; le dossier est en version 5.");
    for (const since of [null, undefined, "hier", 42]) expect(show(dto({ since })).detail, String(since)).toContain("Date de l’entrée à requalifier non enregistrée.");
  });

  it("absent reader, failed read and unknown case are three distinct states, none read as 'à jour'", () => {
    const at = (state: "absent" | "unavailable" | "not_found") => describeQualificationDiagnostic({ state }, page, date).title;
    expect(at("absent")).toContain("non branché dans cette version"); expect(at("unavailable")).toContain("la lecture a échoué"); expect(at("not_found")).toContain("Aucun diagnostic");
    for (const state of ["absent", "unavailable", "not_found"] as const) expect(at(state)).toContain("à jour");
    for (const state of ["absent", "unavailable", "not_found"] as const) expect(at(state)).not.toMatch(/^Qualification à jour/);
  });

  it("extra fields (ids, messages, PII) are never part of the wording; no state is actionable", () => {
    const leaky = { ...dto({ state: "stale_blocked", block: "relay_proof_invalid", nature: "contract_blocked" }), sourceRef: "gm-private-123", email: "client@example.test", causeCode: "SAV_V1_CONTEXT_DOWN", message: "ZodError" } as ProposedQualificationDiagnostic;
    const t = text(leaky);
    expect(t).not.toMatch(/gm-private|client@example|SAV_V1_CONTEXT|ZodError/);
    for (const state of ["current", "no_customer_input", "stale_ready", "stale_unknown", "stale_blocked", "zz"]) expect(show(dto({ state })).actionable).toBe(false);
  });
});
