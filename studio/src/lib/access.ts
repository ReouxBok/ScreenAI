export type StaffRole = "member" | "admin" | "owner";

type StaffDirectoryEntry = { name: string; role: StaffRole };

export const STAFF_DIRECTORY = {
  "reouven@limova.ai": { name: "Reouven", role: "owner" },
  "ugo@limova.ai": { name: "Ugo", role: "admin" },
  "contact@limova.ai": { name: "Contact Limova", role: "member" },
  "arnaud@limova.ai": { name: "Arnaud", role: "member" },
  "matheo@limova.ai": { name: "Mathéo", role: "member" },
  "cyril@limova.ai": { name: "Cyril", role: "member" },
  "lea@limova.ai": { name: "Léa", role: "member" },
  "novalie@limova.ai": { name: "Novalie", role: "member" },
  "mehdi@limova.ai": { name: "Mehdi", role: "member" },
  "yannis@limova.ai": { name: "Yannis", role: "member" },
} as const satisfies Record<string, StaffDirectoryEntry>;

const roleOrder: StaffRole[] = ["member", "admin", "owner"];

export function hasRole(actual: StaffRole, required: StaffRole) {
  return roleOrder.indexOf(actual) >= roleOrder.indexOf(required);
}

export function normalizeStaffEmail(email: string | undefined, fallback = "reouven@limova.ai") {
  const normalized = String(email ?? "").trim().toLowerCase();
  return normalized.includes("@") ? normalized : fallback;
}

export function getStaffDirectoryEntry(email: string | undefined): StaffDirectoryEntry | null {
  const normalized = normalizeStaffEmail(email, "");
  return STAFF_DIRECTORY[normalized as keyof typeof STAFF_DIRECTORY] ?? null;
}

export function isAllowedStaffEmail(email: string) {
  return getStaffDirectoryEntry(email) !== null;
}

export function canManageProduction(role: StaffRole) {
  return hasRole(role, "admin");
}

export function canCreateTraining(role: StaffRole) {
  return hasRole(role, "member");
}

export function canManageTraining(role: StaffRole, actorEmail: string, createdBy: string) {
  return canManageProduction(role)
    || normalizeStaffEmail(actorEmail, "") === normalizeStaffEmail(createdBy, "");
}

export function canEditContent(role: StaffRole, publishedVersionId: string | null) {
  return !publishedVersionId || canManageProduction(role);
}

export function staffRoleLabel(role: StaffRole) {
  return role === "owner" ? "Owner" : role === "admin" ? "Administrateur" : "Membre";
}
