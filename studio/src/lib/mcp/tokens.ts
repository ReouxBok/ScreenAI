import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, not } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, staffUsers, studioMcpTokens } from "@/db/schema";

/** Personal Studio MCP keys: `stm_` + 32 random bytes (base64url). Only the SHA-256 is
 * stored. A key never grants anything by itself: it names its staff member, whose
 * Clerk account and staff row are checked again on every request. */
export const STUDIO_MCP_TOKEN = { prefix: "stm_", maxActive: 5, days: [7, 30, 90], defaultDays: 30 } as const;
const SECRET = /^stm_[A-Za-z0-9_-]{43}$/;
const hash = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");
type Owner = { id: string; email: string };
const inputSchema = z.object({ name: z.string().trim().min(3).max(80), days: z.union(STUDIO_MCP_TOKEN.days.map(d => z.literal(d)) as [z.ZodLiteral<7>, z.ZodLiteral<30>, z.ZodLiteral<90>]) }).strict();

/** Creates a key for the authenticated staff member themselves. The secret is returned once. */
export async function createStudioMcpToken(owner: Owner, raw: unknown, now = new Date()) {
  const input = inputSchema.parse(raw), secret = STUDIO_MCP_TOKEN.prefix + randomBytes(32).toString("base64url");
  return requireDb().transaction(async tx => {
    // Serialized per staff member so the active-key bound cannot be raced.
    const [staff] = await tx.select().from(staffUsers).where(eq(staffUsers.id, owner.id)).for("update");
    if (!staff?.active || staff.email !== owner.email) throw Error("SAV_MCP_TOKEN_UNAUTHORIZED");
    const active = await tx.select({ id: studioMcpTokens.id }).from(studioMcpTokens)
      .where(and(eq(studioMcpTokens.staffId, owner.id), isNull(studioMcpTokens.revokedAt), gt(studioMcpTokens.expiresAt, now)));
    if (active.length >= STUDIO_MCP_TOKEN.maxActive) throw Error("SAV_MCP_TOKEN_LIMIT");
    const [row] = await tx.insert(studioMcpTokens).values({ staffId: owner.id, name: input.name, tokenHash: hash(secret), prefix: secret.slice(0, 12),
      createdAt: now, expiresAt: new Date(now.getTime() + input.days * 86_400_000) }).returning();
    await tx.insert(auditLogs).values({ actorEmail: owner.email, action: "studio_mcp_token_created", entityType: "studio_mcp_token", entityId: row.id,
      technicalMetadata: { prefix: row.prefix, expiresAt: row.expiresAt.toISOString() } });
    return { id: row.id, name: row.name, prefix: row.prefix, expiresAt: row.expiresAt, secret };
  });
}
/** The staff member's own keys with their state at `now`; never the hash or secret. Every
 * active key is always listed, whatever the history size, so each one stays revocable; only
 * the inactive history (revoked or expired) is bounded to the 50 most recent. */
export const STUDIO_MCP_TOKEN_HISTORY = 50;
export async function listStudioMcpTokens(owner: Owner, now = new Date()) {
  const columns = { id: studioMcpTokens.id, name: studioMcpTokens.name, prefix: studioMcpTokens.prefix, createdAt: studioMcpTokens.createdAt,
    expiresAt: studioMcpTokens.expiresAt, revokedAt: studioMcpTokens.revokedAt, lastUsedAt: studioMcpTokens.lastUsedAt };
  const active = and(isNull(studioMcpTokens.revokedAt), gt(studioMcpTokens.expiresAt, now));
  const db = requireDb(), mine = eq(studioMcpTokens.staffId, owner.id);
  const [current, history] = await Promise.all([
    db.select(columns).from(studioMcpTokens).where(and(mine, active)).orderBy(desc(studioMcpTokens.createdAt)),
    db.select(columns).from(studioMcpTokens).where(and(mine, not(active!))).orderBy(desc(studioMcpTokens.createdAt)).limit(STUDIO_MCP_TOKEN_HISTORY),
  ]);
  return [...current, ...history].map(row => ({ ...row, state: row.revokedAt ? "revoked" as const : row.expiresAt <= now ? "expired" as const : "active" as const }));
}
/** Revokes one of the staff member's own keys, immediately and for good. */
export async function revokeStudioMcpToken(owner: Owner, id: string, now = new Date()) {
  z.uuid().parse(id);
  return requireDb().transaction(async tx => {
    const [row] = await tx.select().from(studioMcpTokens).where(and(eq(studioMcpTokens.id, id), eq(studioMcpTokens.staffId, owner.id))).for("update");
    if (!row) throw Error("SAV_MCP_TOKEN_NOT_FOUND");
    if (row.revokedAt) return { id, alreadyRevoked: true };
    await tx.update(studioMcpTokens).set({ revokedAt: now }).where(eq(studioMcpTokens.id, id));
    await tx.insert(auditLogs).values({ actorEmail: owner.email, action: "studio_mcp_token_revoked", entityType: "studio_mcp_token", entityId: id,
      technicalMetadata: { prefix: row.prefix } });
    return { id, alreadyRevoked: false };
  });
}
/** Secret -> Clerk id of an active, unexpired, unrevoked key's staff member, or null. */
export async function resolveStudioMcpToken(secret: string, now = new Date()) {
  if (!SECRET.test(secret)) return null;
  const db = requireDb();
  const [row] = await db.select({ id: studioMcpTokens.id, expiresAt: studioMcpTokens.expiresAt, revokedAt: studioMcpTokens.revokedAt, lastUsedAt: studioMcpTokens.lastUsedAt,
    clerkId: staffUsers.clerkId, active: staffUsers.active }).from(studioMcpTokens).innerJoin(staffUsers, eq(staffUsers.id, studioMcpTokens.staffId))
    .where(eq(studioMcpTokens.tokenHash, hash(secret)));
  if (!row || row.revokedAt || row.expiresAt <= now || !row.active) return null;
  // Usage trace, at most every five minutes per key.
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 300_000)
    await db.update(studioMcpTokens).set({ lastUsedAt: now }).where(eq(studioMcpTokens.id, row.id));
  return { tokenId: row.id, clerkId: row.clerkId };
}
