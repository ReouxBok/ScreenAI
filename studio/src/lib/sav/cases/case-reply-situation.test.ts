import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { savMailboxes, savThreads } from "@/db/schema";
import { listCaseEvents, openCaseEvent, readCase, transitionCaseOwner } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { caseReplySituation } from "./case-reply-situation";

// B-7: the canonical "situation" a reply key answers (the mail itself), on the real SAV-5 case store (PGlite). The sentence it must keep true:
// two names of one situation map to ONE string; a different customer mail, a reminder timer, or an event that is not a hand back never does.
const STAFF = "20000000-0000-4000-8000-000000000003", POLICY = "policy-r1", AT = "2026-10-27T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const actor = { type: "human" as const, staffUserId: STAFF };
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", seq = 9_800_000;

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  f = await createSavTestDb(); state.db = f.db;
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0]!.id;
}, 60_000);
afterAll(async () => { state.db = null; vi.unstubAllEnvs(); await f.client.close(); });

const open = (ticketId: string, threadId: string, gmail: string) => openCaseEvent({ ticketId, threadId, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail),
  sourceRef: { type: "email", id: gmail }, occurredAt: AT });
async function handBack(caseId: string, tag: string) {
  await transitionCaseOwner({ caseId, expectedVersion: (await readCase(caseId))!.version, transition: "human_takeover", actor, commandKey: `sit-take-${tag}-${caseId}`, reason: "fixture" });
  await transitionCaseOwner({ caseId, expectedVersion: (await readCase(caseId))!.version, transition: "hand_back", actor, commandKey: `sit-back-${tag}-${caseId}`, reason: "fixture", to: "agent", admission: ADMITTED });
  return (await listCaseEvents(caseId)).filter(event => event.kind === "owner_changed").at(-1)!;
}
async function newCase() {
  const ticketId = String(++seq), thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: `gt-${randomUUID()}`, customerEmail: "customer@example.invalid" }).returning())[0]!;
  const m1 = `gm-${randomUUID()}`, opened = (await open(ticketId, thread.id, m1)).case;
  return { caseId: opened.caseId, ticketId, threadId: thread.id, m1 };
}
const situation = (caseId: string, trigger: string) => caseReplySituation(f.db as never, caseId, trigger);

describe("the situation a reply trigger answers", () => {
  it("a customer mail is its own situation; the hand back that returns to it is the SAME situation", async () => {
    const c = await newCase(), h1 = await handBack(c.caseId, "a");
    expect(await situation(c.caseId, `inbound:${c.m1}`)).toBe(`inbound:${c.m1}`);
    expect(await situation(c.caseId, `back:${h1.id}`)).toBe(`inbound:${c.m1}`);
  });

  it("a hand back is the situation of the latest mail BEFORE it: a second hand back after a second mail is a different situation from the first", async () => {
    const c = await newCase(), h1 = await handBack(c.caseId, "one");
    const m2 = `gm-${randomUUID()}`;
    await open(c.ticketId, c.threadId, m2);
    const h2 = await handBack(c.caseId, "two");
    expect(await situation(c.caseId, `back:${h1.id}`)).toBe(`inbound:${c.m1}`);
    expect(await situation(c.caseId, `back:${h2.id}`)).toBe(`inbound:${m2}`);
    expect(await situation(c.caseId, `inbound:${m2}`)).not.toBe(await situation(c.caseId, `inbound:${c.m1}`));
  });

  it("two hand backs with no mail between them stay one situation (no resend permission is hidden in a second hand back)", async () => {
    const c = await newCase(), h1 = await handBack(c.caseId, "x"), h2 = await handBack(c.caseId, "y");
    expect(h1.id).not.toBe(h2.id);
    expect(await situation(c.caseId, `back:${h1.id}`)).toBe(await situation(c.caseId, `back:${h2.id}`));
  });

  it("nothing is invented: a timer, an unknown or foreign event, an event that is not a hand back, or a free string answers no mail", async () => {
    const c = await newCase(), other = await newCase(), foreign = await handBack(other.caseId, "f");
    const mail = (await listCaseEvents(c.caseId)).find(event => event.kind === "inbound_confirmed")!;
    for (const trigger of [`timer:${randomUUID()}`, `back:${randomUUID()}`, `back:${foreign.id}`, `back:${mail.id}`, "made-up", "", `in:${mail.id}`]) expect(await situation(c.caseId, trigger), trigger).toBeNull();
  });
});
