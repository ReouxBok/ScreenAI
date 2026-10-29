import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, staffUsers, studioMcpTokens } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => { throw Error("NO_SESSION_ON_MCP"); }, clerkClient: async () => { throw Error("NO_REAL_CLERK"); } }));
import { createStudioMcpToken, listStudioMcpTokens, resolveStudioMcpToken, revokeStudioMcpToken, STUDIO_MCP_TOKEN } from "./tokens";
import { resolveStudioMcpUser, StudioMcpAuthError } from "./identity";
import { handleStudioMcpRequest, resetStudioMcpRateLimit } from "./server";

/** Personal Studio keys: hashed at rest, bounded, revocable, and never stronger than the staff row. Synthetic users only. */
let f: Awaited<ReturnType<typeof createSavTestDb>>, ugo: typeof staffUsers.$inferSelect, contact: typeof staffUsers.$inferSelect;
const clerkUsers: Record<string, Record<string, unknown>> = {};
const clerk = async () => ({ users: { getUser: async (id: string) => { if (!clerkUsers[id]) throw Error("not found"); return clerkUsers[id] as never; } } });
const bearer = (secret: string) => new Request("https://studio.example.invalid/api/mcp", { headers: { authorization: `Bearer ${secret}` } });
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  await f.client.exec("TRUNCATE public.staff_users, public.audit_logs CASCADE");
  [ugo, contact] = await f.db.insert(staffUsers).values([{ clerkId: "user_ugo", email: "ugo@limova.ai", name: "Ugo", role: "admin" },
    { clerkId: "user_contact", email: "contact@limova.ai", name: "Contact", role: "member" }]).returning();
  for (const [id, email] of [["user_ugo", "ugo@limova.ai"], ["user_contact", "contact@limova.ai"]])
    clerkUsers[id] = { id, banned: false, locked: false, primaryEmailAddress: { emailAddress: email, verification: { status: "verified" } } };
  resetStudioMcpRateLimit(); vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

it("MCP-KEY a created key is shown once and only its SHA-256 is stored, with an audit entry", async () => {
  const created = await createStudioMcpToken(ugo, { name: "Claude Code — portable", days: 30 });
  expect(created.secret).toMatch(/^stm_[A-Za-z0-9_-]{43}$/); expect(created.prefix).toBe(created.secret.slice(0, 12));
  const stored = JSON.stringify(await f.db.select().from(studioMcpTokens)) + JSON.stringify(await f.db.select().from(auditLogs));
  expect(stored).not.toContain(created.secret);
  const [row] = await f.db.select().from(studioMcpTokens);
  expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/); expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(30 * 86_400_000);
  expect(await f.db.select().from(auditLogs)).toMatchObject([{ actorEmail: "ugo@limova.ai", action: "studio_mcp_token_created", entityId: row.id }]);
  expect(await listStudioMcpTokens(ugo)).toMatchObject([{ state: "active", prefix: created.prefix }]); expect(JSON.stringify(await listStudioMcpTokens(ugo))).not.toContain(row.tokenHash); expect(await listStudioMcpTokens(contact)).toHaveLength(0);
});
it("MCP-KEY malformed requests and a staff row that is inactive or not the caller are refused", async () => {
  for (const input of [{ name: "ab", days: 30 }, { name: "valide", days: 365 }, { name: "valide", days: 30, staffId: contact.id }])
    await expect(createStudioMcpToken(ugo, input)).rejects.toThrow();
  await expect(createStudioMcpToken({ id: ugo.id, email: "contact@limova.ai" }, { name: "usurpation", days: 7 })).rejects.toThrow("SAV_MCP_TOKEN_UNAUTHORIZED");
  await f.db.update(staffUsers).set({ active: false }).where(eq(staffUsers.id, ugo.id));
  await expect(createStudioMcpToken(ugo, { name: "inactif", days: 7 })).rejects.toThrow("SAV_MCP_TOKEN_UNAUTHORIZED");
  expect(await f.db.select().from(studioMcpTokens)).toHaveLength(0);
});
it("MCP-KEY at most five active keys, even under concurrent creations; revoked and expired keys do not count", async () => {
  const results = await Promise.allSettled(Array.from({ length: STUDIO_MCP_TOKEN.maxActive + 2 }, (_, i) => createStudioMcpToken(ugo, { name: `clé ${i}`, days: 7 })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(STUDIO_MCP_TOKEN.maxActive);
  expect(results.filter(r => r.status === "rejected").every(r => String((r as PromiseRejectedResult).reason).includes("SAV_MCP_TOKEN_LIMIT"))).toBe(true);
  const [first, second] = await f.db.select().from(studioMcpTokens);
  await revokeStudioMcpToken(ugo, first.id);
  await f.db.update(studioMcpTokens).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(studioMcpTokens.id, second.id));
  await createStudioMcpToken(ugo, { name: "après révocation", days: 7 }); await createStudioMcpToken(ugo, { name: "après expiration", days: 7 });
  await expect(createStudioMcpToken(ugo, { name: "de trop", days: 7 })).rejects.toThrow("SAV_MCP_TOKEN_LIMIT");
});
it("MCP-KEY only a valid, unrevoked, unexpired key of an active staff member resolves", async () => {
  const { secret, id } = await createStudioMcpToken(ugo, { name: "résolution", days: 7 });
  expect(await resolveStudioMcpToken(secret)).toEqual({ tokenId: id, clerkId: "user_ugo" });
  for (const wrong of ["", "stm_", `${secret}x`, secret.replace(/.$/, c => c === "A" ? "B" : "A"), secret.toUpperCase()]) expect(await resolveStudioMcpToken(wrong)).toBeNull();
  await f.db.update(staffUsers).set({ active: false }).where(eq(staffUsers.id, ugo.id));
  expect(await resolveStudioMcpToken(secret)).toBeNull();
  await f.db.update(staffUsers).set({ active: true }).where(eq(staffUsers.id, ugo.id));
  await f.db.update(studioMcpTokens).set({ expiresAt: new Date(Date.now() - 1) });
  expect(await resolveStudioMcpToken(secret)).toBeNull();
  await f.db.update(studioMcpTokens).set({ expiresAt: new Date(Date.now() + 86_400_000) });
  await revokeStudioMcpToken(ugo, id);
  expect(await resolveStudioMcpToken(secret)).toBeNull();
});
it("MCP-KEY usage time is recorded at most every five minutes", async () => {
  const { secret } = await createStudioMcpToken(ugo, { name: "usage", days: 7 }), t0 = new Date();
  await resolveStudioMcpToken(secret, t0);
  await resolveStudioMcpToken(secret, new Date(t0.getTime() + 60_000));
  expect((await f.db.select().from(studioMcpTokens))[0].lastUsedAt?.getTime()).toBe(t0.getTime());
  await resolveStudioMcpToken(secret, new Date(t0.getTime() + 301_000));
  expect((await f.db.select().from(studioMcpTokens))[0].lastUsedAt?.getTime()).toBe(t0.getTime() + 301_000);
});
it("MCP-KEY a staff member revokes only their own keys, once, with an audit entry", async () => {
  const mine = await createStudioMcpToken(ugo, { name: "à moi", days: 7 }), theirs = await createStudioMcpToken(contact, { name: "à contact", days: 7 });
  await expect(revokeStudioMcpToken(ugo, theirs.id)).rejects.toThrow("SAV_MCP_TOKEN_NOT_FOUND");
  expect(await revokeStudioMcpToken(ugo, mine.id)).toEqual({ id: mine.id, alreadyRevoked: false });
  expect(await revokeStudioMcpToken(ugo, mine.id)).toEqual({ id: mine.id, alreadyRevoked: true });
  expect((await f.db.select().from(auditLogs)).filter(a => a.action === "studio_mcp_token_revoked")).toHaveLength(1);
  expect(await resolveStudioMcpToken(theirs.secret)).not.toBeNull();
});
it("MCP-KEY the key stops when the Clerk account is banned, locked, deleted or no longer the same", async () => {
  const { secret } = await createStudioMcpToken(ugo, { name: "clerk", days: 7 });
  await expect(resolveStudioMcpUser(new Request("https://x.invalid"), clerk)).rejects.toMatchObject({ code: "MCP_TOKEN_MISSING" });
  expect((await resolveStudioMcpUser(bearer(secret), clerk)).id).toBe("user_ugo");
  for (const change of [{ banned: true }, { locked: true }, { id: "user_other" }]) {
    const saved = clerkUsers.user_ugo; clerkUsers.user_ugo = { ...saved, ...change };
    await expect(resolveStudioMcpUser(bearer(secret), clerk)).rejects.toBeInstanceOf(StudioMcpAuthError);
    clerkUsers.user_ugo = saved;
  }
  const saved = clerkUsers.user_ugo; delete clerkUsers.user_ugo;
  await expect(resolveStudioMcpUser(bearer(secret), clerk)).rejects.toMatchObject({ code: "MCP_TOKEN_INVALID" });
  clerkUsers.user_ugo = saved;
});
it("MCP-KEY end to end: a real key reads as its staff member, and revocation stops it at the next request", async () => {
  const { secret, id } = await createStudioMcpToken(contact, { name: "codex", days: 7 });
  const call = () => handleStudioMcpRequest(new Request("https://studio.example.invalid/api/mcp", { method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${secret}` } }),
  { env: { STUDIO_MCP_ENABLED: "true" }, resolveUser: request => resolveStudioMcpUser(request, clerk) });
  const first = await call();
  expect(first.status).toBe(200);
  expect(((await first.json()) as { result: { structuredContent: unknown } }).result.structuredContent).toMatchObject({ outcome: "done", data: { email: "contact@limova.ai", role: "member" } });
  // An unverified primary email is refused by the console's own check.
  (clerkUsers.user_contact.primaryEmailAddress as { verification: { status: string } }).verification.status = "unverified";
  expect((await call()).status).toBe(403);
  (clerkUsers.user_contact.primaryEmailAddress as { verification: { status: string } }).verification.status = "verified";
  await revokeStudioMcpToken(contact, id);
  expect((await call()).status).toBe(401);
});
