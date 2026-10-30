import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import type { SavClerkUser } from "@/lib/sav/intake/console-auth";
import { resolveStudioMcpToken } from "./tokens";

export class StudioMcpAuthError extends Error {
  constructor(readonly code: "MCP_TOKEN_MISSING" | "MCP_TOKEN_INVALID") { super(code); }
}
type Clerk = { users: { getUser(id: string): Promise<NonNullable<SavClerkUser>> } };
/** Personal Studio key -> its staff member's current Clerk user. Only identifies the
 * person: the console staff checks run afterwards, exactly as for the UI. A banned,
 * locked or deleted Clerk account stops the key. No session cookie, no bypass. */
export async function resolveStudioMcpUser(request: Request, clerk: () => Promise<Clerk> = clerkClient,
  resolveToken: typeof resolveStudioMcpToken = resolveStudioMcpToken): Promise<NonNullable<SavClerkUser>> {
  const header = /^Bearer (\S{1,512})$/.exec(request.headers.get("authorization") ?? "");
  if (!header) throw new StudioMcpAuthError("MCP_TOKEN_MISSING");
  const token = await resolveToken(header[1]);
  if (!token) throw new StudioMcpAuthError("MCP_TOKEN_INVALID");
  const user = await (await clerk()).users.getUser(token.clerkId).catch(() => null);
  if (!user || user.id !== token.clerkId || (user as { banned?: boolean }).banned || (user as { locked?: boolean }).locked) throw new StudioMcpAuthError("MCP_TOKEN_INVALID");
  return user;
}
