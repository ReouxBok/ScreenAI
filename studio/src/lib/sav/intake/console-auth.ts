import "server-only";
import { currentUser } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { staffUsers } from "@/db/schema";
import { canAccessSav } from "../access";
/** The Clerk user as both the browser session and a verified MCP token resolve it. */
export type SavClerkUser = Awaited<ReturnType<typeof currentUser>>;
/** Read existing authoritative staff only; directory provisioning cannot revive
 * an operator as a side effect of opening the console. Shared by the session
 * and the MCP token, so both apply exactly the same checks. */
export async function authorizeSavStaffUser(user: SavClerkUser, code: string) {
  const address = user?.primaryEmailAddress;
  if (!user || address?.verification?.status !== "verified") throw Error(code);
  const [staff] = await requireDb().select().from(staffUsers).where(and(
    eq(staffUsers.clerkId, user.id), eq(staffUsers.email, address.emailAddress.trim().toLowerCase())));
  if (!staff?.active || !canAccessSav(staff.email, staff.role)) throw Error(code);
  return staff;
}
export async function requireIntakeConsoleStaff() {
  return authorizeSavStaffUser(await currentUser(), "SAV_INTAKE_CONSOLE_UNAUTHORIZED");
}
