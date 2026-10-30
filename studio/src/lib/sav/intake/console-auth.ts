import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { currentUser } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { staffUsers } from "@/db/schema";
import { canAccessSav } from "../access";
/** The Clerk user as both the browser session and a verified MCP token resolve it. */
export type SavClerkUser = Awaited<ReturnType<typeof currentUser>>;
const requestUser = new AsyncLocalStorage<NonNullable<SavClerkUser>>();
/** Runs `work` as the user resolved from a verified Studio MCP key: the console's own
 * server functions then authenticate that person exactly as they would a browser session. */
export function withSavRequestUser<T>(user: NonNullable<SavClerkUser>, work: () => Promise<T>) {
  return requestUser.run(user, work);
}
/** The MCP caller inside withSavRequestUser, otherwise the browser session. */
export async function savRequestUser(): Promise<SavClerkUser> {
  return requestUser.getStore() ?? currentUser();
}
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
  return authorizeSavStaffUser(await savRequestUser(), "SAV_INTAKE_CONSOLE_UNAUTHORIZED");
}
