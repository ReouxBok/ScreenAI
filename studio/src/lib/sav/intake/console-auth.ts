import "server-only";
import { currentUser } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { staffUsers } from "@/db/schema";
import { canAccessSav } from "../access";
/** Read existing authoritative staff only; directory provisioning cannot revive
 * an operator as a side effect of opening the console. */
export async function requireIntakeConsoleStaff() {
  const user = await currentUser(), address = user?.primaryEmailAddress;
  if (!user || address?.verification?.status !== "verified") throw Error("SAV_INTAKE_CONSOLE_UNAUTHORIZED");
  const [staff] = await requireDb().select().from(staffUsers).where(and(
    eq(staffUsers.clerkId, user.id), eq(staffUsers.email, address.emailAddress.trim().toLowerCase())));
  if (!staff?.active || !canAccessSav(staff.email, staff.role)) throw Error("SAV_INTAKE_CONSOLE_UNAUTHORIZED");
  return staff;
}
