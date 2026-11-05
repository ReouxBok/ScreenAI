import { randomUUID } from "node:crypto";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown, dbReads: 0, decrypted: [] as string[], staff: vi.fn(), calls: [] as unknown[][], redirectCaseId: null as string | null }));
vi.mock("@/db", () => ({ requireDb: () => { state.dbReads += 1; if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("@/lib/sav/crypto", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/sav/crypto")>();
  return { ...real, decryptSavPayload: (ciphertext: string) => { state.decrypted.push(ciphertext); return real.decryptSavPayload(ciphertext); } };
});
// The REAL A6 reader runs; the wrapper only records its arguments, and (one probe) asks it about another case to show the page refuses that DTO.
vi.mock("@/lib/sav/cases/case-store", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/sav/cases/case-store")>();
  return { ...real, readCaseQualificationDiagnostic: (caseId: string, caller: Parameters<typeof real.readCaseQualificationDiagnostic>[1]) => {
    state.calls.push([caseId, caller]); return real.readCaseQualificationDiagnostic(state.redirectCaseId ?? caseId, caller);
  } };
});
vi.mock("@/lib/sav/intake/console-auth", () => ({ requireIntakeConsoleStaff: state.staff }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); }, usePathname: () => "/studio/sav/v2/1", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ back: vi.fn(), refresh: vi.fn() }) }));
import { savMailboxes, savMessages, savThreads } from "@/db/schema";
import { formatParisDateTime } from "@/lib/paris-date";
import { encryptSavPayload } from "@/lib/sav/crypto";
import { appendCaseEvent, listCaseEvents, openCaseEvent, readCase, transitionCaseOwner } from "@/lib/sav/cases/case-store";
import { caseDedupeKey } from "@/lib/sav/cases/case-types";
import CasePage from "./[ticketId]/page";

// UX lot 7 on the PRIVATE composition 2ae402f (A6 8ab6507 + B 52575 + C 62acd + UX 513d333), PGlite with the real migrations: the V2 case page calls pole A6's
// REAL readCaseQualificationDiagnostic after the staff check, with the caller built from that check's result. States are produced with pole A's real writers
// (openCaseEvent, appendCaseEvent, transitionCaseOwner), as A6's own tests do. Doubles: the staff check, the db handle (counted), decryption (spied). Synthetic
// data only; fetch throws; no V1, CRM, provider or model.
type Db = Awaited<ReturnType<typeof createSavTestDb>>;
const STAFF = "20000000-0000-4000-8000-000000000003", AT = "2026-10-27T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
let ticket = 9_950_000;
async function seed(f: Db) {
  const mailboxId = (await f.db.insert(savMailboxes).values({ email: `support-${randomUUID()}@example.invalid` }).returning())[0]!.id;
  const gmailMessageId = `gm-${randomUUID()}`, ticketId = String(ticket++);
  const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: `t-${randomUUID()}`, customerEmail: "customer@example.invalid" }).returning())[0]!;
  await f.db.insert(savMessages).values({ threadId: thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synthetic", bodyCiphertext: encryptSavPayload({ text: "Synthetic.", headers: { "message-id": "<in@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z") });
  const { case: opened } = await openCaseEvent({ ticketId, threadId: thread.id, admission: ADMITTED, kind: "inbound_confirmed",
    dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
  return { caseId: opened.caseId, ticketId };
}
/** A second relayed customer mail (A's real writer), with the relay proof the journal check reads. */
async function relayedMail(caseId: string, relay: (messageId: string) => Record<string, unknown>, detailMessageId?: string) {
  const gmail = `gm-${randomUUID()}`, messageId = randomUUID(), occurredAt = new Date(Date.now() - 60_000).toISOString();
  await appendCaseEvent({ caseId, kind: "inbound_confirmed", direction: "customer_inbound", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt,
    detail: { messageId: detailMessageId ?? messageId, relay: relay(messageId) } } as never);
  return occurredAt;
}
const crmChange = async (caseId: string, ticketId: string) => {
  const occurredAt = new Date(Date.now() - 30_000).toISOString();
  await appendCaseEvent({ caseId, kind: "crm_observed", direction: "internal", dedupeKey: `crm:${ticketId}:${randomUUID()}`, sourceRef: { type: "hubspot_object", id: ticketId }, occurredAt, detail: { crmChange: "unknown" } } as never);
  return occurredAt;
};
const render = async (ticketId: string) => renderToStaticMarkup(await CasePage({ params: Promise.resolve({ ticketId }), searchParams: Promise.resolve({}) }));
const snapshotAll = async (f: Db) => {
  const tables = (await f.client.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'sav' AND table_type = 'BASE TABLE' ORDER BY 1")).rows;
  const out: Record<string, string> = {};
  for (const { name } of tables) out[name] = JSON.stringify((await f.client.query(`SELECT * FROM sav."${name}" ORDER BY 1`)).rows);
  return out;
};
/** Renders and proves the render wrote nothing (every row of every sav table), called no network, offered no form, and leaked no internal id. */
async function readOnly(f: Db, ticketId: string) {
  const before = await snapshotAll(f), html = await render(ticketId);
  expect(await snapshotAll(f)).toEqual(before);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  expect(html).not.toMatch(/<form|<button|type="submit"|in:[0-9a-f-]{36}|back:[0-9a-f-]{36}|staff_session_verified/);
  return html;
}
const section = (html: string) => html.slice(html.indexOf('id="v2-qualification"'), html.indexOf("</div>", html.indexOf('id="v2-qualification"')));
const input = async (caseId: string) => { const s = (await readCase(caseId))!; return (await listCaseEvents(caseId)).find(e => e.caseVersion === s.admissionInputVersion)!; };

beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); vi.stubEnv("SAV_CASE_EFFECTS", "supervised");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  state.staff.mockReset(); state.staff.mockResolvedValue({ id: STAFF, email: "operateur@example.test", role: "member", active: true });
  state.calls = []; state.redirectCaseId = null;
});

describe("A6 qualification diagnostic on the V2 case page (real reader, after the staff check)", () => {
  let f: Db;
  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
  afterAll(async () => { state.db = null; await f.client.close(); });

  it("a refused staff check reads nothing: no database access, no decryption, no A6 call", async () => {
    const s = await seed(f);
    state.dbReads = 0; state.decrypted = [];
    state.staff.mockRejectedValueOnce(Error("SAV_INTAKE_CONSOLE_UNAUTHORIZED"));
    await expect(render(s.ticketId)).rejects.toThrow("SAV_INTAKE_CONSOLE_UNAUTHORIZED");
    expect(state.dbReads).toBe(0); expect(state.decrypted).toEqual([]); expect(state.calls).toEqual([]);
  });

  it("the caller is built from the staff check's result only, for the case the page read; an admitted case reads 'à jour'", async () => {
    const s = await seed(f);
    const html = await readOnly(f, s.ticketId);
    expect(state.calls).toEqual([[s.caseId, { kind: "staff_session_verified", staffUserId: STAFF }]]);
    expect(section(html)).toContain("Qualification à jour : l’admission porte sur l’entrée la plus récente.");
    expect(section(html)).not.toContain("reçue le");
  });

  it("stale_ready: since = the new relayed mail's occurrence (never the admission decision); nothing proven; runtime cause not recorded", async () => {
    const s = await seed(f);
    const admittedAt = (await readCase(s.caseId))!.admission!.decidedAt;
    const occurredAt = await relayedMail(s.caseId, messageId => ({ kind: "intake_effects_confirmed", messageId, executionId: randomUUID(), intakeRunId: null, intakeRunVersion: 1 }));
    expect((await input(s.caseId)).occurredAt).toBe(occurredAt);
    const q = section(await readOnly(f, s.ticketId));
    expect(q).toContain("À requalifier : la dernière entrée est un mail relayé lisible, la qualification doit repasser.");
    expect(q).toContain(`Entrée à requalifier reçue le ${formatParisDateTime(new Date(occurredAt))}.`);
    expect(q).not.toContain(formatParisDateTime(new Date(admittedAt)));
    expect(q).toContain("ne prouve ni l’identité, ni les familles, ni l’admission, ni l’attribution ; aucune action n’en découle.");
    expect(q).toContain("Cause éventuellement vue lors d’un passage : non enregistrée.");
    expect(q).not.toMatch(/bloqué depuis|en panne/i);
  });

  it("stale_blocked from the journal: acknowledgement, invalid relay proof and hand-back each read their closed sentence", async () => {
    const ack = await seed(f);
    await relayedMail(ack.caseId, messageId => ({ kind: "acknowledgement_on_case_thread", messageId, intakeRunId: randomUUID(), intakeRunVersion: 1, sourceHash: "syn-ack-source" }));
    expect(section(await readOnly(f, ack.ticketId))).toContain("À requalifier, bloqué par le contrat : la dernière entrée est un accusé de réception relayé, sans exécution V1.");
    const bad = await seed(f);
    await relayedMail(bad.caseId, messageId => ({ kind: "intake_effects_confirmed", messageId, executionId: randomUUID(), intakeRunId: null, intakeRunVersion: 1 }), randomUUID());
    expect(section(await readOnly(f, bad.ticketId))).toContain("À requalifier, bloqué par le contrat : la preuve de relais de la dernière entrée est illisible ou incohérente.");
    const back = await seed(f);
    await transitionCaseOwner({ caseId: back.caseId, expectedVersion: (await readCase(back.caseId))!.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `ux7-take-${back.caseId}`, reason: "syn_take" });
    await transitionCaseOwner({ caseId: back.caseId, expectedVersion: (await readCase(back.caseId))!.version, transition: "hand_back", actor: { type: "human", staffUserId: STAFF }, commandKey: `ux7-back-${back.caseId}`, reason: "syn_back",
      to: "agent", admission: { policy: ADMITTED.policy, qualification: (await readCase(back.caseId))!.admission!.qualification } } as never);
    await crmChange(back.caseId, back.ticketId);
    expect(section(await readOnly(f, back.ticketId))).toContain("À requalifier, bloqué par le contrat : la dernière entrée est un dossier rendu par une personne, sans entrée V1 désignée.");
  });

  it("stale_unknown: a newer non-mail input; since = that input", async () => {
    const s = await seed(f);
    const occurredAt = await crmChange(s.caseId, s.ticketId);
    const q = section(await readOnly(f, s.ticketId));
    expect(q).toContain("À requalifier : la dernière entrée n’est pas un mail ; la cause n’est pas déterminée par cette lecture.");
    expect(q).toContain(`Entrée à requalifier reçue le ${formatParisDateTime(new Date(occurredAt))}.`);
  });

  it("a caller A6 refuses (a staff check result without a valid id) and a DTO of another case: unavailable / rejected, never 'à jour', still 0 writes", async () => {
    const s = await seed(f), other = await seed(f);
    state.staff.mockResolvedValueOnce({ id: "not-a-uuid", email: "operateur@example.test", role: "member", active: true });
    expect(section(await readOnly(f, s.ticketId))).toContain("Diagnostic de qualification indisponible : la lecture a échoué. Ce n’est pas un état « à jour ».");
    state.redirectCaseId = other.caseId;
    const q = section(await readOnly(f, s.ticketId));
    expect(q).toContain("Diagnostic de qualification rejeté : il ne concerne pas ce dossier.");
    expect(q).not.toContain("Qualification à jour");
  });
});
