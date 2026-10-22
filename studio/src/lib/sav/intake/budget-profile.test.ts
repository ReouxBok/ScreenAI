import { it, expect, vi, afterEach } from "vitest";
import { intakeBudgetUsage, intakeAdmissionUsage, intakeOperationalTermValid, SAV_INTAKE_OPERATIONAL_PROFILE } from "./budget-profile";
const at=new Date("2026-10-21T00:00:00.000Z"),day=86400000;
const config={budgetProfile:SAV_INTAKE_OPERATIONAL_PROFILE,maxNanoUsd:3000000000,maxRollingNanoUsd:90000000000,maxCalls:300};
const row=(ago:number,state="settled",chargedNanoUsd=100)=>({createdAt:new Date(at.getTime()-ago),state,chargedNanoUsd});
afterEach(()=>vi.useRealTimers());
it("UTC midnight excludes settled prior-day costs, including the exact rolling30day boundary",()=>{
  vi.useFakeTimers();vi.setSystemTime(at);
  const u=intakeBudgetUsage([row(1),row(0),row(30*day),row(30*day+1)],config,at);
  expect(u).toMatchObject({chargedNanoUsd:100,callCount:1,rollingChargedNanoUsd:300,lifetimeCallCount:4});
});
it("unknown reservations older than30days remain fully charged in both current margins",()=>{
  vi.useFakeTimers();vi.setSystemTime(at);
  const u=intakeBudgetUsage([row(31*day,"uncertain",817152000),row(100*day,"dispatched",817152000),row(0)],config,at);
  expect(u.chargedNanoUsd).toBe(1634304100);expect(u.rollingChargedNanoUsd).toBe(u.chargedNanoUsd);expect(u.callCount).toBe(3);
});
it("config/profile changes never reset the shared ledger and legacy qualification stays cumulative",()=>{
  vi.useFakeTimers();vi.setSystemTime(at);
  const rows=[row(day+1),row(0)];
  expect(intakeBudgetUsage(rows,config,at).lifetimeCallCount).toBe(2);
  expect(intakeBudgetUsage(rows,{maxNanoUsd:3000000000,maxCalls:30},at)).toMatchObject({chargedNanoUsd:200,callCount:2});
  expect(intakeBudgetUsage(rows,{...config,maxCalls:299},at).lifetimeChargedNanoUsd).toBe(200);
});
it("ledger clocks in the future and forward-injected now are refused",()=>{
  vi.useFakeTimers();vi.setSystemTime(at);
  expect(()=>intakeBudgetUsage([row(-1)],config,at)).toThrow("CLOCK_REJECTED");
  expect(()=>intakeBudgetUsage([],config,new Date(at.getTime()+1))).toThrow("CLOCK_REJECTED");
  expect(()=>intakeAdmissionUsage([{createdAt:new Date(at.getTime()+1)}],true,at)).toThrow("CLOCK_REJECTED");
});
it("admission quota is UTC daily only for the operational profile, lifetime count is not reset",()=>{
  vi.useFakeTimers();vi.setSystemTime(at);
  const rows=Array.from({length:100},()=>row(1));
  expect(intakeAdmissionUsage(rows,true,at)).toBe(0);expect(intakeAdmissionUsage(rows,false,at)).toBe(100);
  rows.push(row(0));expect(intakeAdmissionUsage(rows,true,at)).toBe(1);expect(rows).toHaveLength(101);
});
it("explicit authority lasts at most30days and never exceeds the existing price validity",()=>{
  vi.useFakeTimers();vi.setSystemTime(at);
  expect(intakeOperationalTermValid(new Date(at.getTime()+30*day).toISOString(),at)).toBe(true);
  expect(intakeOperationalTermValid(new Date(at.getTime()+30*day+1).toISOString(),at)).toBe(false);
  const december=new Date("2026-12-15T00:00:00Z");vi.setSystemTime(december);
  expect(intakeOperationalTermValid("2027-01-01T00:00:00Z",december)).toBe(true);
  expect(intakeOperationalTermValid("2027-01-01T00:00:00.001Z",december)).toBe(false);
});
