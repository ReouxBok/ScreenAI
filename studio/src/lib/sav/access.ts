export function canAccessSav(email: string, role: string) {
  const normalized = email.trim().toLowerCase();
  return normalized === "contact@limova.ai" && ["member", "admin", "owner"].includes(role)
    || ["admin", "owner"].includes(role) && ["ugo@limova.ai", "reouven@limova.ai"].includes(normalized);
}

export function assertSavActor(email: string) {
  if (!["ugo@limova.ai", "reouven@limova.ai", "contact@limova.ai"].includes(email.trim().toLowerCase())) throw new Error("SAV_ACCESS_FORBIDDEN");
}
