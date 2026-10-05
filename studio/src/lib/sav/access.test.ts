import { describe, expect, it } from "vitest";
import { canAccessSav } from "./access";
describe("SAV-only access", () => {
  it("allows only the three admins without changing Studio roles", () => {
    for (const email of ["ugo@limova.ai", "reouven@limova.ai", "contact@limova.ai"]) {
      expect(canAccessSav(email, "admin")).toBe(true);
      expect(canAccessSav(email, "member")).toBe(email === "contact@limova.ai");
    }
    expect(canAccessSav("other@limova.ai", "admin")).toBe(false);
    expect(canAccessSav("reouven@limova.ai", "owner")).toBe(true);
    expect(canAccessSav(" UGO@LIMOVA.AI ", "admin")).toBe(true);
  });
});
