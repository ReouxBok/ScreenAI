import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { savLearningAdmissionSignals, savLearningModelUsage } from "@/db/schema";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
import {dispatchSavDerivedCall,settleSavDerivedCall} from "./derived-budget";
import {
  activateSavLearningCutover, claimSavLearningComparisonTx, getSavLearningCutover, isSavLearningCycleEligible,
  recordSavLearningSignal, reserveSavLearningCapacityTx, reserveSavLearningModelCallTx,
} from "./learning-admission";

let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
const boundary = { activatedAt: "2026-10-14T12:00:00.000Z", activatedBy: "ugo@limova.ai" as const, deploymentSha: "a".repeat(40) };

beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
beforeEach(async () => {
  await fixture.client.exec("TRUNCATE sav.learning_admission_signals, sav.learning_admission_stats, sav.learning_admission_reservations, sav.learning_model_usage, sav.learning_candidates, sav.sync_state, audit_logs CASCADE");
});

describe("SAV learning admission contract", () => {
  it("keeps cutover explicit, immutable, and based on the resolution cycle start", async () => {
    expect(await getSavLearningCutover()).toBeNull();
    await expect(activateSavLearningCutover(boundary, "reviewer@limova.ai")).rejects.toThrow("SAV_CUTOVER_UGO_APPROVAL_REQUIRED");
    await activateSavLearningCutover(boundary, "ugo@limova.ai");
    expect(isSavLearningCycleEligible("2026-10-14T12:00:00.000Z", boundary)).toBe(false);
    expect(isSavLearningCycleEligible("2026-10-14T12:00:01.000Z", boundary)).toBe(true);
    expect(isSavLearningCycleEligible("2026-10-13T12:00:00.000Z", await getSavLearningCutover())).toBe(false);
    await expect(activateSavLearningCutover({ ...boundary, activatedAt: "2026-10-14T12:01:00.000Z" }, "ugo@limova.ai")).rejects.toThrow("SAV_LEARNING_CUTOVER_IMMUTABLE");
  });

  it("deduplicates a comparison claim before charging another model call", async () => {
    const first = await fixture.db.transaction((tx) => claimSavLearningComparisonTx(tx, { sourceRef: "hubspot:fixture-1", sourceHash: "hash-1", origin: "hubspot", inputHash: "input-1" }));
    const retry = await fixture.db.transaction((tx) => claimSavLearningComparisonTx(tx, { sourceRef: "hubspot:fixture-1", sourceHash: "hash-1", origin: "hubspot", inputHash: "input-1" }));
    expect(first.claimed).toBe(true);
    expect(retry.claimed).toBe(false);
    expect(await fixture.db.select().from(savLearningAdmissionSignals)).toHaveLength(1);
  });

  it("enforces 5 new or amended candidates over the rolling seven days", async () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    for (let index = 0; index < 5; index++) {
      const reservation = await fixture.db.transaction((tx) => reserveSavLearningCapacityTx(tx, { reservationKey: `reservation-${index}`, proposalKind: index % 2 ? "amendment" : "new", now }));
      expect(reservation.ok).toBe(true);
    }
    const sixth = await fixture.db.transaction((tx) => reserveSavLearningCapacityTx(tx, { reservationKey: "reservation-6", proposalKind: "new", now }));
    expect(sixth).toMatchObject({ ok: false, reasonCode: "weekly_limit", weekly: 5 });
    const duplicate = await fixture.db.transaction((tx) => reserveSavLearningCapacityTx(tx, { reservationKey: "reservation-0", proposalKind: "new", now }));
    expect(duplicate).toMatchObject({ ok: true, duplicate: true });
  });

  it("records daily volume after proven low-cost settlements while preserving call quotas", async () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    for (let index = 0; index < 12; index++) {
      const reservation=await fixture.db.transaction(tx=>reserveSavLearningModelCallTx(tx,now));expect(reservation).toMatchObject({ok:true});
      await dispatchSavDerivedCall(reservation.reservationId,"comparison","gemini-3.6-flash",{systemInstruction:{parts:[{text:"Synthetic"}]},contents:[{parts:[{text:"Synthetic"}]}],generationConfig:{maxOutputTokens:4096}},now);
      await settleSavDerivedCall(reservation.reservationId,{inputTokens:10,outputTokens:20,thoughtTokens:0,totalTokens:30},now);
    }
    const [usage] = await fixture.db.select().from(savLearningModelUsage).where(eq(savLearningModelUsage.day, "2026-10-15"));
    expect(usage.callCount).toBe(12);
  });

  it("retains only 100 redacted signal records and never stores free-form details", async () => {
    for (let index = 0; index < 101; index++) await recordSavLearningSignal({
      sourceRef: `hubspot:ticket-${index}`, sourceHash: `hash-${index}`, origin: "hubspot", reasonCode: "insufficient_evidence",
      details: { outcome: "insufficient_evidence", rationale: "customer@example.com secret text", privateEmail: "customer@example.com" },
    }, new Date(Date.UTC(2026, 9, 15, 10, 0, index)));
    const rows = await fixture.db.select().from(savLearningAdmissionSignals);
    expect(rows).toHaveLength(100);
    expect(rows.some((row) => JSON.stringify(row).includes("customer@example.com"))).toBe(false);
    expect(rows.find((row) => row.details.outcome)?.details).toEqual({ outcome: "insufficient_evidence" });
  });
});
