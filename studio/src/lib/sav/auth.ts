import "server-only";
import { redirect } from "next/navigation";
import { requireApiStaff, requireStaff } from "@/lib/auth";
import { canAccessSav } from "./access";

// Scoped to SAV. The directory, roles and other Studio routes stay unchanged.
export async function requireSavStaff(required: "admin" = "admin") {
  void required;
  const staff = await requireStaff("member");
  if (!canAccessSav(staff.email, staff.role)) redirect("/studio?reason=forbidden");
  return staff;
}
export async function requireSavApiStaff(required: "admin" = "admin") {
  void required;
  const staff = await requireApiStaff("member");
  if (!canAccessSav(staff.email, staff.role)) throw new Error("SAV_ACCESS_FORBIDDEN");
  return staff;
}
