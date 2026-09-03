import { describe, expect, it } from "vitest";
import { canCreateTraining, canEditContent, canManageTraining, hasRole, isAllowedStaffEmail, normalizeStaffEmail } from "./access";
describe("staff access",()=>{
  it.each([["member","member",true],["member","admin",false],["admin","member",true],["admin","owner",false],["owner","admin",true]] as const)("role %s for %s",(actual,required,allowed)=>expect(hasRole(actual,required)).toBe(allowed));
  it("applique la liste blanche exacte",()=>{expect(isAllowedStaffEmail("ugo@limova.ai")).toBe(true);expect(isAllowedStaffEmail("alice@limova.ai")).toBe(false);expect(isAllowedStaffEmail("ugo@gmail.com")).toBe(false);});
  it("normalise les emails",()=>{
    expect(normalizeStaffEmail("identite-invalide")).toBe("reouven@limova.ai");
    expect(normalizeStaffEmail(" UGO@LIMOVA.AI ")).toBe("ugo@limova.ai");
  });
  it("ouvre les démonstrations au staff et réserve les contenus en production à l'administration",()=>{
    expect(canCreateTraining("member")).toBe(true);
    expect(canCreateTraining("admin")).toBe(true);
    expect(canCreateTraining("owner")).toBe(true);
    expect(canEditContent("member", null)).toBe(true);
    expect(canEditContent("member", "published-version")).toBe(false);
    expect(canEditContent("owner", "published-version")).toBe(true);
  });
  it("limite un membre à ses propres démonstrations",()=>{
    expect(canManageTraining("member", "matheo@limova.ai", " MATHEO@LIMOVA.AI ")).toBe(true);
    expect(canManageTraining("member", "matheo@limova.ai", "ugo@limova.ai")).toBe(false);
    expect(canManageTraining("admin", "ugo@limova.ai", "matheo@limova.ai")).toBe(true);
    expect(canManageTraining("owner", "reouven@limova.ai", "matheo@limova.ai")).toBe(true);
  });
});
