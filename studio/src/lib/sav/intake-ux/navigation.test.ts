import { expect, it } from "vitest";
import { intakeDossierHref, intakeListDestination, parseIntakeListMemory } from "./navigation";
const id = "10000000-0000-4000-8000-000000000001";
it("keeps list, page, mailbox, search, sort and dossier anchor as an explicit return destination", () => {
  const list = `/studio/sav/intake?view=to_validate&q=demande&page=2&sort=newest&mailbox=${id}`;
  const dossier = new URL(intakeDossierHref(id, list), "https://studio.invalid");
  expect(dossier.searchParams.get("returnTo")).toBe(`${list}#dossier-${id}`);
  expect(intakeListDestination(dossier.searchParams.get("returnTo"))).toBe(`${list}#dossier-${id}`);
});
it("keeps the technical list and permitted legacy list origin, but a direct detail falls back to SAV", () => {
  expect(intakeListDestination("/studio/sav/intake?view=processing&page=2")).toBe("/studio/sav/intake?view=processing&page=2");
  expect(intakeListDestination("/studio/sav?legacy=1&view=to_process&q=client&page=2&sort=oldest")).toContain("page=2&sort=oldest");
  expect(new URL(intakeDossierHref(id, "https://bad.invalid"), "https://studio.invalid").searchParams.get("returnTo")).toBe(`/studio/sav/intake#dossier-${id}`);
});
it.each(["https://bad.invalid/studio/sav/intake", "//bad.invalid/studio/sav/intake", "/\\bad.invalid/studio/sav/intake", "/studio", "/studio/sav/intake/other", "/studio/sav/intake?redirect=https://bad.invalid", "/studio/sav/intake?view=unknown", "/studio/sav/intake?page=-1", "/studio/sav/intake?page=10001", "/studio/sav/intake?view=other&view=to_validate", "/studio/sav/intake#unrelated", "/studio/sav/intake%2f..", "/studio/sav/intake?mailbox=bad"])("rejects a forbidden destination %s", input => {
  expect(intakeListDestination(input)).toBeNull();
});
it("validates persisted position instead of trusting storage or browser referrer", () => {
  const saved = { href: "/studio/sav/intake?view=to_validate&page=2", y: 640, focusId: `dossier-${id}` };
  expect(parseIntakeListMemory(JSON.stringify(saved))).toEqual(saved);
  for (const change of [{ href: "//bad.invalid" }, { y: -1 }, { y: "640" }, { y: 2_000_001 }, { focusId: "arbitrary" }]) expect(parseIntakeListMemory(JSON.stringify({ ...saved, ...change }))).toBeNull();
  expect(parseIntakeListMemory("invalid json")).toBeNull();
});
