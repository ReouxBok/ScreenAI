/**
 * SAV-92 (stuck dossiers): follow-ups declared incomplete on a raw-HTML length, and context waits shown "unclassified".
 * Synthetic data only: no real CRM, no real mail.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSavObservationSources } from "../observation-source";
import { observationConsoleCoverage, observationCoverage, observationLimitsLabel, splitObservationSourceErrors } from "../observation-coverage";
import { intakeBlockedSubCause, intakeContextReadReason } from "./console-presentation";
import { SAV_INTAKE_PUBLIC_DIAGNOSTIC_CODES } from "./run-diagnostics";
import { intakeResumeConfirmation, intakeResumeProbeEarly, SAV_INTAKE_RESUME_REVISION, SAV_INTAKE_RESUME_TEAM_AFTER_HOLDS, type IntakeResumeProof } from "./resume-progress";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** A synthetic HubSpot ticket with one associated email whose body is given. */
function crm(email: { hs_email_text?: string | null; hs_email_html?: string | null }) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST" && !u.endsWith("/batch/read")) throw Error("Unexpected fixture mutation");
    if (u.includes("/objects/tickets/123?")) return Response.json({ id: "123", updatedAt: "2026-11-16T08:00:00Z", properties: { subject: "Fictif", hs_pipeline: "0", hs_pipeline_stage: "2" },
      propertiesWithHistory: { hs_pipeline_stage: [{ value: "2", timestamp: "2026-11-16T08:00:00Z" }] } });
    if (u.includes("/pipelines/tickets/0")) return Response.json({ stages: [{ id: "2", metadata: { isClosed: false } }] });
    if (u.includes("/associations/emails")) return Response.json({ results: [{ toObjectId: 999 }] });
    if (u.includes("/associations/")) return Response.json({ results: [] });
    if (u.endsWith("/emails/batch/read")) return Response.json({ status: "COMPLETE", results: [{ id: "999", updatedAt: "2026-11-16T08:00:00Z",
      properties: { hs_email_direction: "INCOMING_EMAIL", hs_timestamp: "2026-11-16T08:00:00Z", hs_email_from_email: "client@example.invalid", ...email } }] });
    return Response.json({ results: [] });
  });
}
async function collect(email: Parameters<typeof crm>[0]) {
  vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "fixture"); vi.stubGlobal("fetch", crm(email));
  return collectSavObservationSources("123");
}

describe("A — truncation measured on the cleaned text", () => {
  it("an HTML mail of 9 000 characters holding 500 characters of text is not truncated: no error, text kept whole", async () => {
    const text = "Bonjour, la connexion fictive échoue. ".repeat(13).slice(0, 500);
    const html = `<html><head><style>${".c{color:red}".repeat(700)}</style></head><body><div class="c">${text}</div></body></html>`;
    expect(html.length).toBeGreaterThan(9_000);
    const source = await collect({ hs_email_text: null, hs_email_html: html });
    expect(source.errors).toEqual([]);
    expect(source.events.find(e => e.sourceRef === "hubspot:emails:999")?.text).toBe(text.trim());
  });
  it("a real text of 9 000 characters stays a truncation error (learning gates unchanged)", async () => {
    const source = await collect({ hs_email_text: "a".repeat(9_000) });
    expect(source.errors).toContain("emails:body_truncated");
    expect(source.events.find(e => e.sourceRef === "hubspot:emails:999")?.text).toHaveLength(8_000);
    // The gates read the raw codes: still a real error, the observation coverage stays incomplete.
    expect(splitObservationSourceErrors(source.errors).errors.map(e => e.code)).toEqual(["hubspot_body_truncated_8000"]);
    expect(observationCoverage(source.errors)).toBe("incomplete");
  });
  it("the console shows a real body truncation as a named partial follow-up; a read failure stays incomplete", () => {
    for (const cut of ["emails:body_truncated", "gmail:18c0synthetic:truncated_8000", "notes:body_truncated"]) {
      expect(observationCoverage([cut])).toBe("incomplete");
      expect(observationConsoleCoverage([cut])).toBe("partial");
      expect(observationLimitsLabel([cut])).toMatch(/^Suivi partiel : un corps dépasse 8 000 caractères\..*non qualifiable « résolu »/);
    }
    expect(observationLimitsLabel(["studio:review_truncated_8000", "emails:association_limit_100"])).toMatch(/^Suivi partiel : une correction Studio dépasse 8 000 caractères ; plus de 100 éléments associés/);
    // Any real read error keeps the console follow-up pending (SOURCE_UNAVAILABLE, pipeline, unknown code), even next to a truncation.
    for (const errors of [["SOURCE_UNAVAILABLE"], ["emails:body_truncated", "pipeline:HUBSPOT_HTTP_503"], ["mystery:code"]]) expect(observationConsoleCoverage(errors)).toBe("incomplete");
    expect(observationConsoleCoverage(["emails:association_limit_100"])).toBe("partial");
    expect(observationConsoleCoverage([])).toBe("complete");
    expect(observationLimitsLabel(["SOURCE_UNAVAILABLE"])).toBeNull();
  });
});

describe("B — context waits are classified", () => {
  it.each(["history_body_unavailable", "wrong_contact"])("a technical wait on %s is « contexte à compléter », never unclassified", reason => {
    expect(intakeBlockedSubCause({ blockedCause: "technical_wait", status: "waiting", reason })).toBe("context_required");
  });
  it("every CRM read fault of the intake readers is covered by the console classification and the public diagnostic codes", () => {
    const source = readFileSync(path.join(__dirname, "hubspot-readers.ts"), "utf8");
    const faults = [...source.matchAll(/new ReadFault\("(partial|failed)", "([a-z_]+)"\)/g)].map(m => ({ status: m[1], code: m[2] }));
    expect(faults.length).toBeGreaterThan(15);
    expect(faults.map(f => f.code)).toEqual(expect.arrayContaining(["history_body_unavailable", "wrong_contact"]));
    // Partial reads leave V1 without context: the team completes it.
    expect(faults.filter(f => f.status === "partial" && !intakeContextReadReason(f.code)).map(f => f.code)).toEqual([]);
    // Every fault is a public diagnostic code (never dropped to "no code").
    expect(faults.filter(f => !SAV_INTAKE_PUBLIC_DIAGNOSTIC_CODES.has(f.code)).map(f => f.code)).toEqual([]);
    expect(SAV_INTAKE_PUBLIC_DIAGNOSTIC_CODES.has("resume_team_required")).toBe(true);
  });
  it("the hand-over counts only scheduled confirmations of the same deterministic fault, on a proof with partial (never failed) reads", () => {
    const read = (status: "complete" | "partial" | "failed") => ({ method: "ticketHistory" as const, arg: "201", status, digest: "0".repeat(64) });
    const proof = (...statuses: Array<"complete" | "partial" | "failed">): IntakeResumeProof =>
      ({ revision: SAV_INTAKE_RESUME_REVISION, configHash: "c".repeat(64), sourceHash: "s", incomplete: "history_body_unavailable", truncated: false, reads: statuses.map(read) });
    const n = SAV_INTAKE_RESUME_TEAM_AFTER_HOLDS, now = new Date("2026-11-16T12:00:00Z"), past = "2026-11-16T11:00:00.000Z", future = "2026-11-16T13:00:00.000Z";
    const body = "history_body_unavailable", p = proof("complete", "partial");
    const prior = (confirmations: number, fault: string | null = body, nextProbeAt = past) => ({ sameProof: true, fault, confirmations, nextProbeAt });
    expect(intakeResumeConfirmation(p, "no_progress", body, prior(n - 1), now)).toEqual({ fault: body, confirmations: n, team: true });
    expect(intakeResumeConfirmation(p, "no_progress", body, prior(n - 2), now)).toEqual({ fault: body, confirmations: n - 1, team: false });
    // Unavailable/unchecked: no count, no reset.
    expect(intakeResumeConfirmation(p, "probe_unavailable", null, prior(n - 1), now)).toEqual({ fault: body, confirmations: n - 1, team: false });
    // Another fault restarts; a non-deterministic one never hands over; no observed fault is no confirmation.
    expect(intakeResumeConfirmation(p, "no_progress", "history_date_unknown", prior(n - 1), now)).toEqual({ fault: "history_date_unknown", confirmations: 1, team: false });
    expect(intakeResumeConfirmation(p, "no_progress", "partial_batch", prior(n + 5), now)).toEqual({ fault: "partial_batch", confirmations: 0, team: false });
    expect(intakeResumeConfirmation(p, "no_progress", null, prior(n - 1), now)).toEqual({ fault: null, confirmations: 0, team: false });
    // Before the scheduled look (operator click): held, not counted.
    expect(intakeResumeConfirmation(p, "no_progress", body, prior(n - 1, body, future), now)).toEqual({ fault: body, confirmations: n - 1, team: false });
    // The due time is checked before any counting: a new deterministic fault seen early resets, never confirms.
    expect(intakeResumeConfirmation(p, "no_progress", "history_date_unknown", prior(n - 1, body, future), now)).toEqual({ fault: "history_date_unknown", confirmations: 0, team: false });
    expect(intakeResumeProbeEarly({ sameProof: true, nextProbeAt: future }, now)).toBe(true);
    expect(intakeResumeProbeEarly({ sameProof: true, nextProbeAt: past }, now)).toBe(false);
    expect(intakeResumeProbeEarly({ sameProof: false, nextProbeAt: future }, now)).toBe(false);
    expect(intakeResumeProbeEarly({ sameProof: true, state: "team_required", nextProbeAt: future }, now)).toBe(false);
    // Another proof starts from zero; a failed read in the proof never hands over.
    expect(intakeResumeConfirmation(p, "no_progress", body, { ...prior(n - 1), sameProof: false }, now)).toEqual({ fault: body, confirmations: 1, team: false });
    expect(intakeResumeConfirmation(proof("partial", "failed"), "no_progress", body, prior(n - 1), now).team).toBe(false);
  });
});
