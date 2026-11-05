import "server-only";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { canAccessSav } from "@/lib/sav/access";

/** The demonstration reads no real data: it uses the Studio session (the one the local preview can open) and the SAV access rule of the
 * Agent SAV menu. The real console keeps its own stricter check (requireIntakeConsoleStaff). Called only after the production 404. */
export async function requireDemoStaff() {
  const staff = await requireStaff();
  if (!canAccessSav(staff.email, staff.role)) notFound();
  return staff;
}
