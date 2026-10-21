import "server-only";
import { currentUser } from "@clerk/nextjs/server";
import { getStaffDirectoryEntry, hasRole, normalizeStaffEmail } from "@/lib/access";

/** No getStaff()/persistStaff(): authenticating this read-only evaluation must
 * not provision or update an operational staff record. No dev-header bypass. */
export async function evaluationAdministrator() {
  const user = await currentUser();
  const email = normalizeStaffEmail(user?.primaryEmailAddress?.emailAddress, "");
  const directory = getStaffDirectoryEntry(email);
  if (!user || !user.primaryEmailAddress?.verification || user.primaryEmailAddress.verification.status !== "verified" || !directory || !hasRole(directory.role, "admin")) throw Error("SAV_EVAL_UNAUTHORIZED");
  return email;
}
