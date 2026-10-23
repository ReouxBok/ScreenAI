import { it } from "vitest";

/** Independent qualification helpers (synthetic data only, no sockets).
 *
 * Tests named "[CIBLE]" describe a target behaviour that is ABSENT from base
 * 222ab2cf. They only run with SAV_QUALIFICATION_TARGET=1, so the base suite
 * stays green while the combined patch set can be checked explicitly.
 * Tests named "[INV]" are invariants that must hold on base AND after patches. */
export const targetIt = process.env.SAV_QUALIFICATION_TARGET === "1" ? it : it.skip;

/** Deterministic barrier: both sides must arrive before either continues. */
export function barrier(parties = 2) {
  let arrived = 0, release!: () => void;
  const opened = new Promise<void>(resolve => { release = resolve; });
  return async () => { if (++arrived >= parties) release(); await opened; };
}

/** The exact transformation under qualification: HubSpot may drop an HTML
 * comment from hs_note_body. Nothing else in the stored value is changed. */
export const stripHtmlComments = (value: string) => value.replace(/<!--[\s\S]*?-->/g, "");
