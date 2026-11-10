// Wording shown when the server refuses a command of the retired V0 circuit
// (SAV-60). The code is the one pole C throws in `v0-command-retirement.ts`
// (head be24f6c); it is repeated here, not imported, until both lots are composed.
export const SAV_LEGACY_COMMAND_RETIRED = "SAV_LEGACY_COMMAND_RETIRED";

export type LegacyCommandKind = "reply" | "ticket" | "other";

const suffix: Record<LegacyCommandKind, string> = {
  reply: " Aucune réponse n’a été envoyée.",
  ticket: " Aucun ticket n’a été créé ni modifié.",
  other: "",
};

/** Notice for a refused legacy command, or null for any other code. */
export function legacyCommandNotice(code: unknown, kind: LegacyCommandKind = "other"): string | null {
  if (code !== SAV_LEGACY_COMMAND_RETIRED) return null;
  return `Cette commande de l’ancien circuit n’existe plus. Le dossier reste consultable ; la reprise se fait dans le nouveau parcours.${suffix[kind] ?? ""}`;
}
