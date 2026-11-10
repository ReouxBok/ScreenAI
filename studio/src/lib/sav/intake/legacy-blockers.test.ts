import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savActions, savIntakeOccupations, savMailboxes, savMessages, savThreads } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { assertNoLegacyConflict } from "./execution-store";

// SAV-9: the retired V0 workers never touch a machine-authored row again. These tests pin what that leaves behind for V1 admission,
// so a stale row is a known, visible, audited case rather than a silent permanent block. No production data: synthetic rows only.
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string, messageId: string;
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  await f.client.exec("TRUNCATE sav.intake_occupations, sav.actions, sav.mailboxes CASCADE");
  [{ id: mailboxId }] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning();
  [{ id: threadId }] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid" }).returning();
  [{ id: messageId }] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "synthetic@example.invalid", gmailMessageId: randomUUID(),
    bodyCiphertext: "not-read", receivedAt: new Date() }).returning();
});
type Row = Partial<typeof savActions.$inferInsert>;
const action = async (row: Row) => (await f.db.insert(savActions).values({ threadId, messageId, kind: "create_ticket", status: "pending", actorType: "system", payload: {},
  idempotencyKey: randomUUID(), ...row }).returning())[0];
const admit = (keys = [`thread:${randomUUID()}`]) => f.db.transaction(tx => assertNoLegacyConflict(tx, keys));

it("an unrelated thread is admitted when no non-confirmed legacy row exists", async () => {
  await action({ status: "succeeded", actorType: "system" });
  await expect(admit()).resolves.toBeUndefined();
});
it("a machine row left pending by the retired V0 engine, with no occupation row, blocks V1 admission for EVERY thread", async () => {
  const stale = await action({ status: "pending", actorType: "system" });
  await expect(admit([`thread:${threadId}`])).rejects.toThrow("LEGACY_SCOPE_OCCUPIED");
  await expect(admit([`thread:${randomUUID()}`]), "an unrelated thread is blocked too: the check is global").rejects.toThrow("LEGACY_SCOPE_OCCUPIED");
  expect(stale.status).toBe("pending");
});
it("a running machine row blocks the same way, and a recorded occupation narrows the block to its own keys", async () => {
  const running = await action({ status: "running", actorType: "system", kind: "send_reply" });
  await expect(admit()).rejects.toThrow("LEGACY_SCOPE_OCCUPIED");
  await f.db.insert(savIntakeOccupations).values({ key: `thread:${threadId}`, ownerId: running.id, ownerKind: "legacy" });
  await expect(admit([`thread:${threadId}`])).rejects.toThrow("LEGACY_SCOPE_OCCUPIED");
  await expect(admit([`thread:${randomUUID()}`])).resolves.toBeUndefined();
});
it("a failed machine row blocks only when a send marker says it may have left the system", async () => {
  await action({ status: "failed", actorType: "system", payload: {} });
  await expect(admit()).resolves.toBeUndefined();
  for (const marker of ["ticketCreateDispatchedAt", "ticketReturnDispatchedAt", "replySendDispatchedAt", "forwardDispatchedAt", "intakeOccupationDispatchedAt"]) {
    const row = await action({ status: "failed", actorType: "system", payload: { [marker]: "2026-10-01T10:00:00.000Z" } });
    await expect(admit(), marker).rejects.toThrow("LEGACY_SCOPE_OCCUPIED");
    await f.db.delete(savActions).where(eq(savActions.id, row.id));
  }
});
it("kinds V1 does not own never block (a pending draft or follow-up is not a CRM scope)", async () => {
  for (const kind of ["draft_reply", "schedule_followup", "cancel_followup"] as const) await action({ status: "pending", actorType: "system", kind });
  await expect(admit()).resolves.toBeUndefined();
});
it("more than 200 unconfirmed rows make the scope unknown and block everything", async () => {
  await f.db.insert(savActions).values(Array.from({ length: 201 }, () => ({ threadId, messageId, kind: "create_note" as const, status: "pending" as const, actorType: "system" as const,
    payload: {}, idempotencyKey: randomUUID() })));
  await expect(admit()).rejects.toThrow("LEGACY_SCOPE_UNKNOWN");
});
it("a human row pending blocks exactly as before the retirement", async () => {
  await action({ status: "pending", actorType: "human" });
  await expect(admit()).rejects.toThrow("LEGACY_SCOPE_OCCUPIED");
});
