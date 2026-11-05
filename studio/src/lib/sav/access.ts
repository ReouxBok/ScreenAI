import { SYN_EMAIL, synPreviewEnabled } from "./local-syn";
export function canAccessSav(email: string, role: string) {
  const normalized = email.trim().toLowerCase();
  if (synPreviewEnabled() && normalized === SYN_EMAIL && role === "admin") return true;
  return normalized === "contact@limova.ai" && ["member", "admin", "owner"].includes(role)
    || ["admin", "owner"].includes(role) && ["ugo@limova.ai", "reouven@limova.ai"].includes(normalized);
}

export function assertSavActor(email: string) {
  if (!["ugo@limova.ai", "reouven@limova.ai", "contact@limova.ai"].includes(email.trim().toLowerCase())) throw new Error("SAV_ACCESS_FORBIDDEN");
}
