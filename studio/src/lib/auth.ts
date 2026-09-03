import "server-only";

import { cache } from "react";
import { currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getDb } from "@/db";
import { staffUsers } from "@/db/schema";
import { getStaffDirectoryEntry, hasRole, normalizeStaffEmail, type StaffRole } from "./access";

export { hasRole } from "./access";
export type StaffIdentity = { actorId: string; email: string; name: string; role: StaffRole };

async function persistStaff(identity: StaffIdentity) {
  const db = getDb();
  if (!db) return;
  const [existing] = await db.select().from(staffUsers).where(eq(staffUsers.email, identity.email)).limit(1);
  if (!existing) {
    await db.insert(staffUsers).values({ clerkId: identity.actorId, email: identity.email, name: identity.name, role: identity.role });
    return;
  }
  if (existing.clerkId !== identity.actorId || existing.name !== identity.name || existing.role !== identity.role || !existing.active) {
    await db.update(staffUsers).set({
      clerkId: identity.actorId,
      name: identity.name,
      role: identity.role,
      active: true,
      updatedAt: new Date(),
    }).where(eq(staffUsers.id, existing.id));
  }
}

export const getStaff = cache(async (): Promise<StaffIdentity | null> => {
  const bypass = process.env.NODE_ENV !== "production" && process.env.DEV_AUTH_BYPASS === "true";
  if (bypass) {
    const requestedEmail = (await headers()).get("x-studio-test-user") || process.env.DEV_USER_EMAIL;
    const email = normalizeStaffEmail(requestedEmail);
    const directory = getStaffDirectoryEntry(email) ?? getStaffDirectoryEntry("reouven@limova.ai")!;
    return { actorId: "dev-user", email, name: directory.name, role: directory.role };
  }

  const user = await currentUser();
  const email = normalizeStaffEmail(user?.primaryEmailAddress?.emailAddress, "");
  const directory = getStaffDirectoryEntry(email);
  if (!user || !email || !directory) return null;

  const identity: StaffIdentity = {
    actorId: user.id,
    email,
    name: user.fullName?.trim() || directory.name,
    role: directory.role,
  };
  await persistStaff(identity);
  return identity;
});

export async function requireStaff(required: StaffRole = "member") {
  const staff = await getStaff();
  if (!staff) redirect("/connexion?reason=required");
  if (!hasRole(staff.role, required)) redirect("/studio?reason=forbidden");
  return staff;
}

export async function requireApiStaff(required: StaffRole = "member") {
  const staff = await getStaff();
  if (!staff || !hasRole(staff.role, required)) throw new Error("UNAUTHORIZED");
  return staff;
}
