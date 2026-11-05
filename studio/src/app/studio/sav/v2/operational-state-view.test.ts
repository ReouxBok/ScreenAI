import { describe, expect, it } from "vitest";
import type { CaseOperationalEffect, CaseOperationalView } from "@/lib/sav/cases/case-operational-read";
import { describeOperationalState, readOperationalState, type OperationalReader } from "./operational-state-view";

// UX lot 10: the operator wording on pole C9's REAL view type (CaseOperationalView, sav-v2-case-operational-read.v1). The vertical probe on C9's real reader and
// writers is operational-state.compose.test.ts; this file pins the wording of each closed value, including the shapes the store cannot easily produce.
const CASE = "20000000-0000-4000-8000-000000000001", REPLY = "30000000-0000-4000-8000-000000000001", AT = "2026-11-01T10:00:00.000Z";
const page = { caseId: CASE, validationId: REPLY };
const date = (value: string) => `<${value}>`;
const effect = (over: Partial<CaseOperationalEffect> = {}): CaseOperationalEffect => ({ kind: "reply_send", state: "uncertain", dispatchedAt: AT, confirmedAt: null, nextVerificationAt: null, reconcileAttempts: 2,
  verification: { needsPerson: false, reason: null, audit: "none" }, ...over });
const view = (over: Partial<CaseOperationalView> = {}): CaseOperationalView => ({ schemaRevision: "sav-v2-case-operational-read.v1", observedAt: AT, caseId: CASE, validationId: REPLY, validation: "approved",
  parent: { state: "uncertain", reason: null }, verificationLimit: 5, reply: { status: "uncertain", effect: effect() }, note: { status: "no_recorded_note_effect", create: null, associate: null },
  needsPerson: false, auditRequired: false, complete: true, incomplete: [], ...over });
const show = (v: CaseOperationalView) => describeOperationalState({ state: "ok", view: v }, page, date);
const text = (v: CaseOperationalView) => show(v).lines.join(" | ");

describe("C9 operational view → operator wording", () => {
  it("needsPerson (from C): the limit sentence first, no number of the limit, no next date; tone danger", () => {
    const v = view({ needsPerson: true, reply: { status: "uncertain", effect: effect({ reconcileAttempts: 5, verification: { needsPerson: true, reason: "verification_limit", audit: "none" } }) } });
    const r = show(v);
    expect(r.lines[0]).toBe("Vérification arrivée à sa limite : une personne doit regarder. Aucun renvoi ni remise à zéro automatique.");
    expect(r.tone).toBe("danger");
    expect(text(v)).not.toMatch(/\b5\b|prochaine vérification/);
    // The same attempts without C's verdict is not the limit: the UI never infers it.
    expect(text(view({ reply: { status: "uncertain", effect: effect({ reconcileAttempts: 5 }) } }))).not.toContain("une personne doit regarder");
  });

  it("a scheduled check (C's nextVerificationAt) is shown; none when C gives none", () => {
    expect(text(view({ reply: { status: "uncertain", effect: effect({ nextVerificationAt: AT }) } }))).toContain(`Envoi : prochaine vérification le <${AT}>.`);
    expect(text(view())).not.toContain("prochaine vérification");
  });

  it("note created + association uncertain: its own sentence; the ledger-only scope is always stated; never 'note écrite'", () => {
    const v = view({ reply: { status: "confirmed", effect: effect({ state: "confirmed", confirmedAt: AT }) }, parent: { state: "confirmed", reason: null },
      note: { status: "association_uncertain", create: effect({ kind: "note_create", state: "confirmed" }), associate: effect({ kind: "note_associate", state: "uncertain" }) } });
    expect(text(v)).toContain("Note interne créée, rattachement au ticket à vérifier.");
    expect(text(v)).toContain("D’après le registre des effets seulement : ni la demande d’une note, ni son absence dans HubSpot ne sont prouvées.");
    expect(text(v)).not.toMatch(/note écrite|aucune note dans HubSpot/i);
    expect(text(view({ note: { status: "no_recorded_note_effect", create: null, associate: null } }))).toContain("Note interne : aucune étape de note enregistrée.");
  });

  it("C9 counter-review FAIL (issue-only): note.status unknown with complete=true is still shown 'non lisible' and never all-green", () => {
    const v = view({ reply: { status: "confirmed", effect: effect({ state: "confirmed" }) }, parent: { state: "confirmed", reason: null }, note: { status: "unknown", create: null, associate: null } });
    expect(text(v)).toContain("Note interne : état non lisible (lecture incomplète).");
    expect(show(v).tone).toBe("warning");
  });

  it("needs_audit, auditRequired and an incomplete read stay visible even with a confirmed reply", () => {
    const confirmed = { reply: { status: "confirmed" as const, effect: effect({ state: "confirmed" }) }, parent: { state: "confirmed" as const, reason: null } };
    const audit = view({ ...confirmed, auditRequired: true, complete: false, incomplete: ["contradiction", "zz_future"] as never });
    expect(text(audit)).toContain("Lecture contradictoire : à auditer, rien n’est réparé automatiquement.");
    expect(text(audit)).toContain("Lecture incomplète : données contradictoires, motif non reconnu.");
    expect(show(audit).tone).toBe("warning");
    expect(text(view({ ...confirmed, complete: false, incomplete: [] }))).toContain("Lecture incomplète.");
    expect(text(view({ ...confirmed, reply: { status: "confirmed", effect: effect({ state: "confirmed", verification: { needsPerson: false, reason: null, audit: "needs_audit" } }) } })))
      .toContain("Envoi : données contradictoires, à auditer");
  });

  it("parent refused shows no raw machine code; never queued; unknown parent, validation or reply are 'non lisible'", () => {
    expect(text(view({ parent: { state: "refused", reason: "SAV_CASE_EFFECT_CANCELLED_AI_NOTICE" } }))).not.toContain("SAV_CASE_EFFECT");
    expect(text(view({ parent: null, reply: { status: "no_recorded_effect", effect: null } }))).toContain("Pas en file d’envoi : aucune exécution enregistrée.");
    const unknown = view({ parent: { state: "unknown", reason: null }, validation: "unknown", reply: { status: "unknown", effect: null } });
    expect(text(unknown)).toContain("État d’exécution non lisible"); expect(text(unknown)).toContain("Envoi : état non lisible"); expect(show(unknown).tone).toBe("warning");
    for (const status of ["constructor", "__proto__"]) expect(text(view({ note: { status, create: null, associate: null } as never }))).toContain("Note interne : état non lisible");
  });

  it("another case or reply is rejected; another schema is not read; each failure state is distinct; nothing actionable", () => {
    expect(show(view({ caseId: "20000000-0000-4000-8000-000000000999" })).lines).toEqual(["Suivi des effets rejeté : il ne concerne pas cette réponse de ce dossier."]);
    expect(show(view({ validationId: "30000000-0000-4000-8000-000000000999" })).tone).toBe("danger");
    expect(show(view({ schemaRevision: "sav-v2-case-operational-read.v9" as never })).lines[0]).toContain("format que cette version ne lit pas");
    const at = (state: "absent" | "denied" | "invalid" | "not_found" | "unavailable") => describeOperationalState({ state }, page, date).lines[0];
    expect(new Set(["absent", "denied", "invalid", "not_found", "unavailable"].map(s => at(s as never))).size).toBe(5);
    expect(at("unavailable")).toContain("Ce n’est pas une liste vide.");
    expect(show(view()).actionable).toBe(false);
    expect(text(view())).toContain(`Lu le <${AT}> (heure du serveur, pas la fraîcheur de Gmail ni du CRM).`);
  });
});

describe("readOperationalState: the access callback comes from the staff check's result only", () => {
  it("passes { caseId, validationId } and an access callback that is true only for a staff result with an id; maps C9's refusals; a throw is unavailable", async () => {
    const calls: unknown[] = [];
    const reader: OperationalReader = async (input, deps) => { calls.push([input, deps.access()]); return { ok: false, code: "not_found" }; };
    expect(await readOperationalState(reader, { id: "20000000-0000-4000-8000-000000000003" } as never, CASE, REPLY)).toEqual({ state: "not_found" });
    expect(calls).toEqual([[{ caseId: CASE, validationId: REPLY }, true]]);
    calls.length = 0;
    await readOperationalState(reader, { id: "" } as never, CASE, REPLY);
    expect(calls).toEqual([[{ caseId: CASE, validationId: REPLY }, false]]);
    for (const code of ["access_denied", "invalid_input", "unavailable"] as const) expect((await readOperationalState(async () => ({ ok: false, code }), { id: "x" } as never, CASE, REPLY)).state).toBe(code === "access_denied" ? "denied" : code === "invalid_input" ? "invalid" : "unavailable");
    expect(await readOperationalState(async () => { throw Error("SYN_DOWN"); }, { id: "x" } as never, CASE, REPLY)).toEqual({ state: "unavailable" });
    expect(await readOperationalState(null, { id: "x" } as never, CASE, REPLY)).toEqual({ state: "absent" });
  });
});
