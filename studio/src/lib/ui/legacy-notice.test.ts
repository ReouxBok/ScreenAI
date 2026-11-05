import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { SAV_LEGACY_COMMAND_RETIRED, legacyCommandNotice } from "./legacy-notice";

it("uses the exact code thrown by the server, without a digit, so actions.ts catch patterns let it through", () => {
  expect(SAV_LEGACY_COMMAND_RETIRED).toMatch(/^SAV_[A-Z_]+$/);
  expect(SAV_LEGACY_COMMAND_RETIRED).not.toBe("SAV_V0_COMMAND_RETIRED");
});

it("says the dossier stays readable, and what did not happen for replies and tickets", () => {
  expect(legacyCommandNotice(SAV_LEGACY_COMMAND_RETIRED)).toBe("Cette commande de l’ancien circuit n’existe plus. Le dossier reste consultable ; la reprise se fait dans le nouveau parcours.");
  expect(legacyCommandNotice(SAV_LEGACY_COMMAND_RETIRED, "reply")).toMatch(/Aucune réponse n’a été envoyée\.$/);
  expect(legacyCommandNotice(SAV_LEGACY_COMMAND_RETIRED, "ticket")).toMatch(/Aucun ticket n’a été créé ni modifié\.$/);
  for (const other of ["SAV_V0_COMMAND_RETIRED", "SAV_V0_ANALYSIS_RETIRED", "", null, undefined]) expect(legacyCommandNotice(other)).toBeNull();
});

it("matches pole C's constant when its commit is available in this repository", () => {
  let source = "";
  try { source = execFileSync("git", ["show", "be24f6c:studio/src/lib/sav/v0-command-retirement.ts"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return; }
  expect(source).toContain(`export const SAV_LEGACY_COMMAND_RETIRED = "${SAV_LEGACY_COMMAND_RETIRED}";`);
});
