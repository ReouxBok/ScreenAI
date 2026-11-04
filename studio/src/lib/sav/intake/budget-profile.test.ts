import { it, expect, vi, afterEach } from "vitest";
import { intakeBudgetUsage, intakeBlockedByUnsettled, intakeAdmissionUsage, intakeOperationalTermValid, SAV_INTAKE_OPERATIONAL_PROFILE } from "./budget-profile";
const at=new Date("2026-10-21T00:00:00.000Z"),day=86400000;
const config={budgetProfile:SAV_INTAKE_OPERATIONAL_PROFILE,maxNanoUsd:3000000000,maxRollingNanoUsd:90000000000,maxCalls:300};
const row=(ago:number,state="settled",chargedNanoUsd=100)=>({createdAt:new Date(at.getTime()-ago),state,chargedNanoUsd});
afterEach(()=>vi.useRealTimers());
it("UTC midnight excludes settled prior-day costs, including the exact rolling30day boundary",()=>{
  vi.useFakeTimers();vi.setSystemTime(at);
  const u=intakeBudgetUsage([row(1),row(0),row(30*day),row(30*day+1)],config,at);
  expect(u).toMatchObject({chargedNanoUsd:100,callCount:1,rollingChargedNanoUsd:300,lifetimeCallCount:4});
});
it("keeps yesterday’s uncertain and in-flight costs in the rolling ceiling even beyond 30 days",()=>{
  vi.useFakeTimers();vi.setSystemTime(at);
  const rows = [row(1,"uncertain",300),row(31*day,"uncertain",400),row(100*day,"dispatched",500),row(0,"uncertain",100),row(0,"settled",200)];
  const u=intakeBudgetUsage(rows,config,at);
  expect(u).toMatchObject({chargedNanoUsd:300,callCount:2,dailyUnsettledNanoUsd:100,dailyUnsettledCallCount:1,
    rollingChargedNanoUsd:1500,lifetimeChargedNanoUsd:1500,inFlightNanoUsd:500,uncertainNanoUsd:800});
  // Same rows and same time, qualification stays cumulative.
  expect(intakeBudgetUsage(rows,{maxNanoUsd:2000,maxCalls:30},at)).toMatchObject({chargedNanoUsd:1500,callCount:5,dailyUnsettledNanoUsd:1300});
});
it("attributes a budget block only to reservations actually counted in that window",()=>{
  vi.useFakeTimers();vi.setSystemTime(at);
  const rows=[row(1,"uncertain",900),row(0,"settled",900)];
  const calc=(daily:number,rolling:number)=>intakeBudgetUsage(rows,{...config,maxNanoUsd:daily,maxRollingNanoUsd:rolling},at);
  expect(intakeBlockedByUnsettled(calc(1000,5000),200)).toBe(false); // settled today alone blocks
  expect(intakeBlockedByUnsettled(calc(1500,1900),200)).toBe(true); // yesterday’s uncertainty blocks rolling
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
