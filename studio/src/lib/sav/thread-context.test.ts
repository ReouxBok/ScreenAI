import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../test/sav-db";
import { savActions, savAgentRuns, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { encryptSavPayload } from "./crypto";
import { getSavRelatedThreads } from "./thread-context";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let mailboxId: string;
const customerEmail = "client@example.com";

async function thread(input: { mailboxId?: string; customerEmail?: string; subject?: string; lastMessageAt?: Date } = {}) {
  const [created] = await fixture.db.insert(savThreads).values({
    mailboxId: input.mailboxId ?? mailboxId, customerEmail: input.customerEmail ?? customerEmail,
    gmailThreadId: crypto.randomUUID(), subject: input.subject ?? "Question de facturation",
    lastMessageAt: input.lastMessageAt ?? new Date("2026-10-02T12:01:00Z"),
  }).returning();
  return created;
}

async function message(target: typeof savThreads.$inferSelect, headers?: Record<string, string>, input: {
  direction?: "inbound" | "outbound"; fromEmail?: string; toEmails?: string[]; bodyCiphertext?: string; receivedAt?: Date;
} = {}) {
  const [created] = await fixture.db.insert(savMessages).values({
    mailboxId: target.mailboxId, threadId: target.id, gmailMessageId: crypto.randomUUID(),
    direction: input.direction ?? "inbound", fromEmail: input.fromEmail ?? target.customerEmail,
    toEmails: input.toEmails ?? ["contact@limova.ai"], subject: target.subject,
    bodyCiphertext: input.bodyCiphertext ?? encryptSavPayload({ text: "Email confidentiel fictif", headers }),
    receivedAt: input.receivedAt ?? target.lastMessageAt,
  }).returning();
  return created;
}

beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-thread-context-encryption-key");
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  mailboxId = mailbox.id;
});

describe("SAV related conversations (read-only RFC context)", () => {
  it("finds the original conversation using a reply header across Gmail thread IDs", async () => {
    const original = await thread({ subject: "Conversation d’origine", lastMessageAt: new Date("2026-01-01T12:00:00Z") });
    const current = await thread({ customerEmail: " CLIENT@EXAMPLE.COM ", subject: "Nouvel objet" });
    const historicalMessage = await message(original, { "Message-ID": "<original@Example.COM>" });
    await message(current, { "message-id": "<reply@example.com>", "in-reply-to": "<original@example.com>" });
    const messagesBefore = await fixture.db.select().from(savMessages);

    expect(await getSavRelatedThreads(current.id)).toEqual([{
      id: original.id, subject: original.subject, lastMessageAt: original.lastMessageAt,
      relationLabel: "Conversation d’origine",
    }]);
    expect(await fixture.db.select().from(savMessages)).toEqual(messagesBefore);
    expect(historicalMessage.processedAt).toBeNull();
    expect(await fixture.db.select().from(savAgentRuns)).toHaveLength(0);
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
  });

  it("finds a later reply and an ancestor shared by two separate threads", async () => {
    const source = await thread();
    await message(source, { "message-id": "<source@example.com>", references: "<ancestor@example.com>" });
    const reply = await thread({ lastMessageAt: new Date("2026-10-02T12:03:00Z") });
    await message(reply, { "message-id": "<reply@example.com>", "in-reply-to": "<source@example.com>" });
    const sibling = await thread({ lastMessageAt: new Date("2026-10-02T12:02:00Z") });
    await message(sibling, { "message-id": "<sibling@example.com>", references: "<ancestor@example.com>" });
    expect((await getSavRelatedThreads(source.id)).map((result) => [result.id, result.relationLabel])).toEqual([
      [reply.id, "Réponse dans un autre fil"], [sibling.id, "Référence de réponse commune"],
    ]);
  });

  it("never links another customer or mailbox, even with the same RFC references", async () => {
    const source = await thread();
    await message(source, { "in-reply-to": "<original@example.com>" });
    const otherCustomer = await thread({ customerEmail: "other@example.com" });
    await message(otherCustomer, { "message-id": "<original@example.com>" });
    const [otherMailbox] = await fixture.db.insert(savMailboxes).values({ email: "other@limova.ai" }).returning();
    const otherMailboxThread = await thread({ mailboxId: otherMailbox.id });
    await message(otherMailboxThread, { "message-id": "<original@example.com>" });
    const foreignSender = await thread();
    await message(foreignSender, { "message-id": "<original@example.com>" }, { fromEmail: "other@example.com" });
    expect(await getSavRelatedThreads(source.id)).toEqual([]);
  });

  it("can link a customer reply to an outbound message addressed to that same customer", async () => {
    const source = await thread();
    await message(source, { "in-reply-to": "<support@example.com>" });
    const previous = await thread();
    await message(previous, { "message-id": "<support@example.com>" }, {
      direction: "outbound", fromEmail: "contact@limova.ai", toEmails: ["CLIENT@EXAMPLE.COM"],
    });
    const foreignRecipient = await thread();
    await message(foreignRecipient, { "message-id": "<support@example.com>" }, {
      direction: "outbound", fromEmail: "contact@limova.ai", toEmails: ["other@example.com"],
    });
    expect((await getSavRelatedThreads(source.id)).map((result) => result.id)).toEqual([previous.id]);
  });

  it("does not infer relationships from subject, copied bodies, or absent headers", async () => {
    const source = await thread();
    await message(source, { "message-id": "<source@example.com>" });
    const sameSubject = await thread();
    await message(sameSubject);
    const invalidReference = await thread();
    await message(invalidReference, { "in-reply-to": "source@example.com" });
    const unreadable = await thread();
    await message(unreadable, undefined, { bodyCiphertext: "corrupt-payload" });
    expect(await getSavRelatedThreads(source.id)).toEqual([]);
  });

  it("does not trust conflicting repeated Message-ID headers or a malformed source", async () => {
    const source = await thread();
    await message(source, { "in-reply-to": "<original@example.com>" });
    const ambiguous = await thread();
    await message(ambiguous, { "message-id": "<original@example.com>", "Message-ID": "<different@example.com>" });
    const malformed = await thread();
    await message(malformed, { "message-id": "<original@example.com> <another@example.com>" });
    expect(await getSavRelatedThreads(source.id)).toEqual([]);
  });

  it("returns each related thread only once and limits the sidebar to ten recent results", async () => {
    const source = await thread();
    await message(source, { "message-id": "<source@example.com>" });
    const targets = [];
    for (let index = 0; index < 12; index += 1) {
      const target = await thread({ lastMessageAt: new Date(Date.parse("2026-10-02T12:02:00Z") + index * 1_000) });
      targets.push(target);
      await message(target, { "in-reply-to": "<source@example.com>" });
      await message(target, { references: "<source@example.com>" });
    }
    const result = await getSavRelatedThreads(source.id);
    expect(result).toHaveLength(10);
    expect(new Set(result.map((entry) => entry.id)).size).toBe(10);
    expect(result.map((entry) => entry.id)).toEqual(targets.slice(2).reverse().map((entry) => entry.id));
    expect(result[0]).not.toHaveProperty("bodyCiphertext");
    expect(result[0]).not.toHaveProperty("customerEmail");
  });

  it("rejects invalid IDs before accessing the database and tolerates a missing UUID", async () => {
    const realDb = state.db;
    state.db = null;
    try {
      expect(await getSavRelatedThreads("not-a-uuid")).toEqual([]);
      expect(await getSavRelatedThreads("' OR 1=1 --")).toEqual([]);
    } finally { state.db = realDb; }
    expect(await getSavRelatedThreads(crypto.randomUUID())).toEqual([]);
  });
});
