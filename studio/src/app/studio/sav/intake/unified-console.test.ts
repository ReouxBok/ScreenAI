import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/sav/intake/executor", () => ({ readIntakeExecutionProgress: vi.fn() }));
vi.mock("@/lib/sav/cases/case-store", () => ({ readCaseByTicket: vi.fn() }));
vi.mock("../v2/case-replies-port", () => ({ caseReplyReaders: null }));
import { replyFromItems, unifiedConsoleLine } from "./unified-console-model";
import { readUnifiedLines, replyOf, ticketOf } from "./unified-console-read";
const row = (over: Partial<{ view: string | null; status: string; blockedCause: string | null }> = {}) => ({ threadId: "t1", view: null, status: "processing", blockedCause: null, ...over });
const found = (over: Partial<{ ticketId: string; owner: "agent" | "human" | "system_hold"; phase: string }> = {}) => ({ state: "found" as const, ticketId: "201", owner: "agent" as const, phase: "acting", updatedAt: "2026-11-10T10:00:00Z", ...over });
const confirmed = { state: "confirmed" as const, ticketId: "201" };
describe("unified console line", () => {
  it("joins V2 only on the exact confirmed ticket, never another ticket of the contact", () => {
    expect(unifiedConsoleLine(row(), confirmed, found()).v2Href).toBe("/studio/sav/v2/201");
    const other = unifiedConsoleLine(row(), confirmed, found({ ticketId: "199" }));
    expect(other.v2Href).toBeNull(); expect(other.bucket).toBe("ticket_linked");
  });
  it("a created ticket without case is linked, never resolved", () => {
    const l = unifiedConsoleLine(row(), confirmed, { state: "absent" });
    expect(l.bucket).toBe("ticket_linked"); expect(l.stage).not.toMatch(/résolu|traité/i); expect(l.owner).toBe("Pas de dossier V2 pour ce ticket");
  });
  it("uncertain ticket or unreadable case goes to verify, without inventing a case", () => {
    expect(unifiedConsoleLine(row(), { state: "uncertain", ticketId: "201" }, { state: "absent" })).toMatchObject({ bucket: "to_verify", v2Href: null });
    expect(unifiedConsoleLine(row(), confirmed, { state: "unavailable" })).toMatchObject({ bucket: "to_verify", owner: "Dossier V2 : lecture indisponible", v2Href: null });
    expect(unifiedConsoleLine(row(), { state: "unavailable" }, { state: "absent" }).bucket).toBe("to_verify");
  });
  it("human ownership and handoff route to the team; awaiting customer and resolved are distinct", () => {
    expect(unifiedConsoleLine(row(), confirmed, found({ owner: "human", phase: "human_owned" })).bucket).toBe("team");
    expect(unifiedConsoleLine(row(), confirmed, found({ phase: "handoff_pending" })).bucket).toBe("team");
    expect(unifiedConsoleLine(row(), confirmed, found({ phase: "awaiting_customer" })).bucket).toBe("awaiting_customer");
    expect(unifiedConsoleLine(row(), confirmed, found({ phase: "resolved" })).bucket).toBe("completed");
    expect(unifiedConsoleLine(row(), confirmed, found({ phase: "blocked_reconcile" })).bucket).toBe("to_verify");
    expect(unifiedConsoleLine(row(), confirmed, found()).bucket).toBe("agent");
  });
  it("pauses are surfaced and never suggest a resend or reset", () => {
    const l = unifiedConsoleLine(row({ blockedCause: "agent_paused" }), { state: "none" }, { state: "absent" });
    expect(l.paused).toBe(true); expect(l.bucket).toBe("to_handle"); expect(l.next).toMatch(/reprise humaine/);
    expect(unifiedConsoleLine(row({ status: "human_hold", view: "to_validate" }), { state: "none" }, { state: "absent" })).toMatchObject({ bucket: "team", paused: true });
    for (const phase of ["queued", "acting", "reconciling", "resolved", "human_owned", "deferred_budget", "technical_wait"]) expect(unifiedConsoleLine(row(), confirmed, found({ phase })).next.replace(/ne rien renvoyer|ne pas relancer ni réinitialiser/g, "")).not.toMatch(/renvoy|reset|relanc|réinitialis/i);
  });
});
describe("unified reader", () => {
  const effects = (states: string[]) => states.map((state, i) => ({ id: `e${i}`, kind: i ? "email_associate" : "ticket_create", state }));
  it("ticket confirmation needs confirmed ticket effects, not only an id", () => {
    expect(ticketOf(null)).toEqual({ state: "none" });
    expect(ticketOf({ ticketId: "201", confirmed: false, effects: effects(["uncertain"]) } as never)).toEqual({ state: "uncertain", ticketId: "201" });
    expect(ticketOf({ ticketId: "201", confirmed: false, effects: effects(["confirmed", "uncertain"]) } as never)).toEqual(confirmed);
  });
  it("reads only the page, isolates failures per row and never queries a case for an unconfirmed ticket", async () => {
    const caseByTicket = vi.fn(async (id: string) => id === "201" ? { ticketId: "201", owner: "agent", phase: "awaiting_customer", updatedAt: "x" } : null);
    const progress = vi.fn(async (m: string) => { if (m === "boom") throw Error("db"); return m === "m1" ? { ticketId: "201", confirmed: true, effects: [] } : m === "m2" ? { ticketId: "202", confirmed: false, effects: effects(["pending"]) } : null; });
    const rows = [{ ...row(), threadId: "a", messageId: "m1" }, { ...row(), threadId: "b", messageId: "m2" }, { ...row(), threadId: "c", messageId: "boom" }, { ...row(), threadId: "d", messageId: null }];
    const lines = await readUnifiedLines(rows, { progress, caseByTicket, replies: async () => ({ state: "ok", items: [], next: null }) } as never);
    expect(lines.a).toMatchObject({ bucket: "awaiting_customer", v2Href: "/studio/sav/v2/201" });
    expect(lines.b.bucket).toBe("to_verify"); expect(lines.c.ticket).toBe("Ticket : lecture indisponible"); expect(lines.d.bucket).toBe("to_handle");
    expect(caseByTicket).toHaveBeenCalledTimes(1); expect(progress).toHaveBeenCalledTimes(3);
    caseByTicket.mockRejectedValueOnce(Error("down"));
    expect((await readUnifiedLines([rows[0]], { progress, caseByTicket, replies: async () => ({ state: "ok", items: [], next: null }) } as never)).a).toMatchObject({ bucket: "to_verify", v2Href: null });
  });
});
describe("prepared / sent / ended / uncertain replies of the exact case", () => {
  const item = (code: string, sent: string) => ({ status: { code, sent } });
  const withReply = (items: ReturnType<typeof item>[], over = {}) => unifiedConsoleLine(row(), confirmed, found({ ...over, reply: replyFromItems(items) } as never));
  it("distinguishes prepared, sent, ended and uncertain from the latest reply", () => {
    expect(replyFromItems([])).toEqual({ state: "none" });
    expect(replyFromItems([item("awaiting_validation", "no")])).toMatchObject({ state: "prepared" });
    expect(replyFromItems([item("queued", "no")])).toMatchObject({ state: "prepared" });
    expect(replyFromItems([item("sent_confirmed", "yes")])).toMatchObject({ state: "sent" });
    expect(replyFromItems([item("cancelled", "no")])).toMatchObject({ state: "ended" });
    expect(replyFromItems([item("declined", "no")])).toMatchObject({ state: "ended" });
    expect(replyFromItems([item("sending", "maybe")])).toMatchObject({ state: "uncertain", uncertainCount: 1 });
    expect(replyFromItems([item("send_unconfirmed", "unknown")])).toMatchObject({ state: "uncertain" });
  });
  it("routes to the reply bucket, to verify on any uncertain send, and never calls a send a resolution", () => {
    const prepared = withReply([item("awaiting_validation", "no")]);
    expect(prepared).toMatchObject({ bucket: "reply", stage: "Réponse préparée", reply: "Réponse préparée, en attente de validation humaine" });
    const sent = withReply([item("sent_confirmed", "yes")]);
    expect(sent).toMatchObject({ bucket: "reply", stage: "Réponse envoyée" }); expect(sent.next).toMatch(/ne résout pas/);
    expect(withReply([item("cancelled", "no")])).toMatchObject({ bucket: "agent", reply: "Réponse non envoyée : refusée, annulée, retirée ou remplacée" });
    const older = withReply([item("sent_confirmed", "yes"), item("sending", "maybe")]);
    expect(older.bucket).toBe("to_verify"); expect(older.next).toMatch(/ne rien renvoyer/);
    // Team ownership and awaiting customer keep precedence over a prepared reply.
    expect(withReply([item("awaiting_validation", "no")], { owner: "human", phase: "human_owned" }).bucket).toBe("team");
    expect(withReply([item("sent_confirmed", "yes")], { phase: "awaiting_customer" }).bucket).toBe("awaiting_customer");
  });
  it("an unreadable or unwired registry is said, never shown as no reply", () => {
    expect(replyOf({ state: "unavailable" })).toEqual({ state: "unavailable" });
    expect(replyOf({ state: "absent" })).toEqual({ state: "absent" });
    expect(unifiedConsoleLine(row(), confirmed, found({ reply: { state: "unavailable" } } as never))).toMatchObject({ bucket: "to_verify", reply: "Réponses : lecture impossible, on ne sait pas si une réponse est partie" });
  });
  it("reads replies once per exact case (one list call), none for other rows, isolating its failure", async () => {
    const replies = vi.fn(async () => ({ state: "ok" as const, items: [item("sending", "maybe"), item("queued", "no")], next: null }));
    const caseByTicket = vi.fn(async () => ({ caseId: "c-201", ticketId: "201", owner: "agent", phase: "acting", updatedAt: "x" }));
    const progress = vi.fn(async (m: string) => m === "m1" ? { ticketId: "201", confirmed: true, effects: [] } : null);
    const rows = [{ ...row(), threadId: "a", messageId: "m1" }, { ...row(), threadId: "b", messageId: "m2" }];
    const lines = await readUnifiedLines(rows, { progress, caseByTicket, replies } as never);
    expect(replies).toHaveBeenCalledTimes(1); expect(replies).toHaveBeenCalledWith("c-201"); expect(lines.a.bucket).toBe("to_verify"); expect(lines.b.reply).toBeNull();
    replies.mockRejectedValueOnce(Error("down"));
    expect((await readUnifiedLines([rows[0]], { progress, caseByTicket, replies } as never)).a.reply).toMatch(/lecture impossible/);
    caseByTicket.mockResolvedValueOnce({ caseId: "c-x", ticketId: "999", owner: "agent", phase: "acting", updatedAt: "x" });
    expect((await readUnifiedLines([rows[0]], { progress, caseByTicket, replies } as never)).a).toMatchObject({ v2Href: null, reply: null });
  });
});
describe("review d2c903a: V1 protections first, exhaustive V2 phases", () => {
  it("I-C1: V1 pause, human hold or team decision wins over an exact V2 case owned by the agent", async () => {
    for (const r of [row({ status: "human_hold", view: "to_validate" }), row({ status: "paused" }), row({ blockedCause: "agent_paused" }), row({ view: "to_validate", status: "human_choice" }), row({ status: "human_refused", view: "to_validate" })]) {
      const l = unifiedConsoleLine(r, confirmed, found({ phase: "acting" }));
      expect(["team", "to_handle"]).toContain(l.bucket); expect(l.next).not.toMatch(/aucune action manuelle/); expect(l.v2Href).toBe("/studio/sav/v2/201");
    }
    expect(unifiedConsoleLine(row({ blockedCause: "agent_paused" }), confirmed, found()).next).toMatch(/reprise humaine/);
  });
  it("I-C2: every real SAV_CASE_PHASES value is mapped; waits are never active follow-up", async () => {
    const { SAV_CASE_PHASES } = await vi.importActual<typeof import("@/lib/sav/cases/case-types")>("@/lib/sav/cases/case-types");
    for (const phase of SAV_CASE_PHASES) {
      const l = unifiedConsoleLine(row(), confirmed, found({ phase }));
      expect(l.stage).not.toBe("Phase V2 non reconnue par cette version");
      if (phase !== "acting") expect(l.bucket).not.toBe("agent");
    }
    expect(unifiedConsoleLine(row(), confirmed, found({ phase: "queued" })).bucket).toBe("to_handle");
    expect(unifiedConsoleLine(row(), confirmed, found({ phase: "deferred_budget" }))).toMatchObject({ bucket: "to_verify", stage: "Reporté : budget" });
    expect(unifiedConsoleLine(row(), confirmed, found({ phase: "technical_wait" }))).toMatchObject({ bucket: "to_verify", stage: "Attente technique" });
    expect(unifiedConsoleLine(row(), confirmed, found({ phase: "needs_review" })).bucket).toBe("team");
    expect(unifiedConsoleLine(row(), confirmed, found({ phase: "future_phase" }))).toMatchObject({ bucket: "to_verify", stage: "Phase V2 non reconnue par cette version" });
  });
  it("a prepared reply only moves an acting case; a wait phase keeps its honest bucket", () => {
    const prepared = replyFromItems([{ status: { code: "awaiting_validation", sent: "no" } }]);
    expect(unifiedConsoleLine(row(), confirmed, found({ phase: "technical_wait", reply: prepared } as never)).bucket).toBe("to_verify");
    expect(unifiedConsoleLine(row(), confirmed, found({ phase: "acting", reply: prepared } as never)).bucket).toBe("reply");
  });
});
describe("review I-C3/I-C4: cross table protections × SAV_CASE_PHASES × owners × uncertain/unreadable replies", () => {
  it("never agent nor completed under a V1 protection, an uncertain send or an unverifiable reply registry", async () => {
    const { SAV_CASE_PHASES, SAV_CASE_OWNERS } = await vi.importActual<typeof import("@/lib/sav/cases/case-types")>("@/lib/sav/cases/case-types");
    const v1 = [row(), row({ status: "human_hold", view: "to_validate" }), row({ status: "paused" }), row({ blockedCause: "agent_paused" }), row({ view: "to_validate", status: "human_choice" })];
    const replies = [{ state: "unavailable" }, { state: "absent" }, replyFromItems([{ status: { code: "sent_confirmed", sent: "yes" } }, { status: { code: "sending", sent: "maybe" } }]), replyFromItems([{ status: { code: "send_unconfirmed", sent: "unknown" } }])];
    let n = 0;
    for (const r of v1) for (const phase of SAV_CASE_PHASES) for (const owner of SAV_CASE_OWNERS) for (const reply of replies) {
      const l = unifiedConsoleLine(r, confirmed, found({ phase, owner, reply } as never)); n++;
      expect(["agent", "completed", "reply"], `${r.status}/${r.blockedCause}/${phase}/${owner}/${reply.state}`).not.toContain(l.bucket);
      expect(l.next).not.toMatch(/aucune action/i);
    }
    expect(n).toBe(v1.length * SAV_CASE_PHASES.length * SAV_CASE_OWNERS.length * replies.length);
  });
  it("I-C3: a resolved, team or awaiting-customer case still surfaces an uncertain send", () => {
    const uncertain = replyFromItems([{ status: { code: "sent_confirmed", sent: "yes" } }, { status: { code: "sending", sent: "maybe" } }]);
    for (const [phase, owner] of [["resolved", "agent"], ["closed_no_reply", "agent"], ["human_owned", "human"], ["awaiting_customer", "agent"]] as const)
      expect(unifiedConsoleLine(row(), confirmed, found({ phase, owner, reply: uncertain } as never))).toMatchObject({ bucket: "to_verify", stage: "Envoi d’une réponse incertain" });
  });
  it("I-C4: unavailable or absent reply registry gives À vérifier, a read empty list keeps the phase", () => {
    for (const state of ["unavailable", "absent"]) expect(unifiedConsoleLine(row(), confirmed, found({ reply: { state } } as never)).bucket).toBe("to_verify");
    expect(unifiedConsoleLine(row(), confirmed, found({ reply: { state: "none" } } as never)).bucket).toBe("agent");
    expect(unifiedConsoleLine(row(), confirmed, found({ phase: "resolved", reply: { state: "none" } } as never)).bucket).toBe("completed");
  });
});

describe("bounded page enrichment", () => {
  it("deduplicates each read key, including failures, and limits active reads to two", async () => {
    let active=0, peak=0;
    const wait=async<T>(value:T)=>{ active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return value; };
    const progress=vi.fn(async()=>wait({ticketId:"201",confirmed:true,effects:[]}));
    const caseByTicket=vi.fn(async()=>wait({ticketId:"201",caseId:"c1",owner:"agent",phase:"acting",updatedAt:"x"}));
    const replies=vi.fn(async()=>wait({state:"ok",items:[],next:null}));
    const rows=Array.from({length:25},(_,i)=>({...row(),threadId:`t${i}`,messageId:`m${i%3}`}));
    const result=await readUnifiedLines(rows,{progress,caseByTicket,replies} as never);
    expect(Object.keys(result)).toHaveLength(25);expect(progress).toHaveBeenCalledTimes(3);expect(caseByTicket).toHaveBeenCalledTimes(1);expect(replies).toHaveBeenCalledTimes(1);expect(peak).toBeLessThanOrEqual(2);
    progress.mockRejectedValue(Error("unavailable"));progress.mockClear();
    const failed=await readUnifiedLines(rows,{progress,caseByTicket,replies} as never);
    expect(progress).toHaveBeenCalledTimes(3);expect(Object.values(failed).every(line=>line.bucket==="to_verify")).toBe(true);
  });
  it("does not read beyond the page or retain another request's evidence",async()=>{
    const progress=vi.fn(async()=>null),caseByTicket=vi.fn(),replies=vi.fn();
    const rows=Array.from({length:26},(_,i)=>({...row(),threadId:`t${i}`,messageId:`m${i}`}));
    expect(Object.keys(await readUnifiedLines(rows,{progress,caseByTicket,replies}))).toHaveLength(25);
    expect(progress).toHaveBeenCalledTimes(25);await readUnifiedLines([rows[0]],{progress,caseByTicket,replies});expect(progress).toHaveBeenCalledTimes(26);
    expect(await readUnifiedLines([],{progress,caseByTicket,replies})).toEqual({});expect(caseByTicket).not.toHaveBeenCalled();expect(replies).not.toHaveBeenCalled();
  });
});

it("does not infer absence of an older uncertain send from a partial reply page",()=>{
 expect(replyOf({state:"ok",items:[],next:"next-page"})).toEqual({state:"unavailable"});
 const protectedLine=unifiedConsoleLine(row({status:"human_hold"}),confirmed,found());
 expect(protectedLine.owner).toBe("Équipe (protection V1)");expect(protectedLine.bucket).toBe("team");
});
