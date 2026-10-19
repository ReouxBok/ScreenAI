import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs } from "@/db/schema";
import { dispatchSavDerivedCall, getSavDerivedMoneyStatus, reserveSavDerivedCallTx, savDerivedBudgets, savDerivedCostQuote, settleSavDerivedCall } from "./derived-budget";
import { requestSavGeminiJson, savAiErrorMetadata } from "./gemini-transport";
const state = vi.hoisted(() => ({
    db: null as unknown
}));
vi.mock("@/db", () => ({
    requireDb: () => state.db
}));
let f: Awaited<ReturnType<typeof createSavTestDb>>;
const now = new Date("2026-10-19T12:00:00Z"), model = "gemini-3.6-flash";
const body = {
    systemInstruction: {
        parts: [
            {
                text: "Synthetic system"
            }
        ]
    }, contents: [
        {
            role: "user", parts: [
                {
                    text: "Synthetic input"
                }
            ]
        }
    ], generationConfig: {
        maxOutputTokens: 4096
    }
};
const metadata = {
    inputTokens: 10, outputTokens: 20, thoughtTokens: 30, totalTokens: 60
};
const reserve = (at = now, stage: "comparison" | "translation" = "comparison") => f.db.transaction(tx => reserveSavDerivedCallTx(tx, stage, at));
async function paid(at = now, stage: "comparison" | "translation" = "comparison") {
    const r = await reserve(at, stage);
    await dispatchSavDerivedCall(r.reservationId, stage, model, {
        ...body, generationConfig: {
            maxOutputTokens: stage === "comparison" ? 4096 : 8192
        }
    }, at);
    await settleSavDerivedCall(r.reservationId, metadata, at);
    return r;
}
async function history(costs: number[], at = new Date("2026-10-18T12:00:00Z")) {
    for (let cost of costs) {
        expect(cost % 750).toBe(0);
        while (cost > 0) {
            const chargedNanoUsd = Math.min(786432000, cost), inputTokens = chargedNanoUsd / 750;
            cost -= chargedNanoUsd;
            await f.db.insert(auditLogs).values({
                actorEmail: "system", action: "sav_derived_call_reserved", entityType: "sav_derived_budget", entityId: "synthetic", createdAt: at,
                technicalMetadata: {
                    stage: "comparison", ...savDerivedCostQuote(model, 4096, at), chargedNanoUsd, dispatchedAt: at.toISOString(), settledAt: at.toISOString(), inputTokens, outputTokens: 0, thoughtTokens: 0, totalTokens: inputTokens
                }
            });
        }
    }
}
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30000);
afterAll(async () => { await f?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
    await f.client.exec("TRUNCATE audit_logs");
    vi.stubGlobal("fetch", () => { throw Error("NO_REAL_NETWORK"); });
});
describe("SAV derived monetary admission", () => {
    it("quotes the entire model input window and combined output/thinking, with integer USD units", () => {
        expect(savDerivedCostQuote(model, 4096, now).reservedNanoUsd).toBe(801792000);
        expect(savDerivedCostQuote(model, 8192, now).reservedNanoUsd).toBe(817152000);
        expect(() => savDerivedCostQuote("unknown", 4096, now)).toThrow("MODEL_UNPRICED");
        expect(() => savDerivedCostQuote(model, 0, now)).toThrow("REQUEST_UNBOUNDED");
        expect(() => savDerivedCostQuote(model, 8193, now)).toThrow("REQUEST_UNBOUNDED");
        expect(savDerivedCostQuote(model, 8192, new Date("2026-12-31T23:59:59.999Z"))).toBeDefined();
        expect(() => savDerivedCostQuote(model, 4096, new Date("2027-01-01T00:00:00Z"))).toThrow("PRICE_EXPIRED");
    });
    it("cannot raise approved quotas through configuration and invalid config closes admission", () => {
        vi.stubEnv("SAV_COMPARISON_DAILY_CALLS", "900");
        vi.stubEnv("SAV_TRANSLATION_DAILY_CALLS", "bad");
        vi.stubEnv("SAV_DERIVED_DAILY_CALLS", "900");
        expect(savDerivedBudgets()).toMatchObject({
            comparison: 20, translation: 0, total: 60
        });
    });
    it("keeps uncertain payment at full reserve, defers a second attempt and resumes next UTC day", async () => {
        await reserve();
        await expect(reserve()).rejects.toThrow("MONETARY_BUDGET");
        expect(await getSavDerivedMoneyStatus(now)).toMatchObject({
            dayNanoUsd: 801792000, rollingNanoUsd: 801792000
        });
        await expect(reserve(new Date("2026-10-20T00:00:00Z"))).resolves.toBeDefined();
    });
    it("preserves unknown historical calls and excludes only calls older than the rolling window", async () => {
        await f.db.insert(auditLogs).values({
            actorEmail: "system", action: "sav_derived_call_reserved", entityType: "sav_derived_budget", entityId: "old", createdAt: new Date("2026-10-18T12:00:00Z"), technicalMetadata: {
                stage: "comparison", reservedInputBytes: 240000
            }
        });
        await expect(reserve()).rejects.toThrow("COST_HISTORY_UNKNOWN");
        expect(await getSavDerivedMoneyStatus(now)).toEqual({
            unknown: true
        });
        await expect(reserve(new Date("2026-11-17T12:00:00Z"))).resolves.toBeDefined();
    });
    it("settles exact thinking usage once, including concurrent settlements and one dispatch only", async () => {
        const r = await reserve();
        await dispatchSavDerivedCall(r.reservationId, "comparison", model, body, now);
        await expect(dispatchSavDerivedCall(r.reservationId, "comparison", model, body, now)).rejects.toThrow("RESERVATION_MISMATCH");
        const a = await settleSavDerivedCall(r.reservationId, metadata, now), b = await settleSavDerivedCall(r.reservationId, {
            ...metadata, inputTokens: 1, outputTokens: 0, thoughtTokens: 0, totalTokens: 1
        }, now);
        expect(a).toMatchObject({
            settled: true, chargedNanoUsd: 195000
        });
        expect(b).toMatchObject({
            duplicate: true, chargedNanoUsd: 195000
        });
        expect(await getSavDerivedMoneyStatus(now)).toMatchObject({
            dayNanoUsd: 195000
        });
        await expect(reserve()).resolves.toBeDefined();
    });
    it.each([
        {}, {
            inputTokens: 10, outputTokens: 20, totalTokens: 30
        }, {
            ...metadata, totalTokens: 59
        },
        {
            ...metadata, thoughtTokens: -1
        }, {
            ...metadata, thoughtTokens: 5000, totalTokens: 5030
        },
        {
            ...metadata, inputTokens: 1048577, totalTokens: 1048627
        },
    ])("never refunds missing/incoherent usage %j", async (m) => {
        const r = await reserve();
        await dispatchSavDerivedCall(r.reservationId, "comparison", model, body, now);
        expect(await settleSavDerivedCall(r.reservationId, m, now)).toEqual({
            settled: false
        });
        expect(await getSavDerivedMoneyStatus(now)).toMatchObject({
            dayNanoUsd: 801792000
        });
    });
    it("binds model, output limit and day before dispatch without releasing uncertain reservations", async () => {
        const r = await reserve();
        await expect(dispatchSavDerivedCall(r.reservationId, "comparison", "gemini-3.8-flash", body, now)).rejects.toThrow("MODEL_UNPRICED");
        await expect(dispatchSavDerivedCall(r.reservationId, "comparison", model, {
            ...body, generationConfig: {
                maxOutputTokens: 8192
            }
        }, now)).rejects.toThrow("RESERVATION_MISMATCH");
        await expect(dispatchSavDerivedCall(r.reservationId, "comparison", model, {
            ...body, tools: []
        }, now)).rejects.toThrow("REQUEST_UNBOUNDED");
        await expect(dispatchSavDerivedCall(r.reservationId, "comparison", model, body, new Date("2026-10-20T00:00:00Z"))).rejects.toThrow("RESERVATION_STALE");
        expect(await getSavDerivedMoneyStatus(now)).toMatchObject({
            dayNanoUsd: 801792000
        });
    });
    it("admits at the last integer-token point below the daily dollar boundary, but never one more reservation", async () => {
        await history([
            198207750
        ], now);
        await reserve();
        expect(await getSavDerivedMoneyStatus(now)).toMatchObject({
            dayNanoUsd: 999999750
        });
        await expect(reserve()).rejects.toThrow("MONETARY_BUDGET");
    });
    it("keeps the translation50 and shared60 caps after truthful low-cost settlement", async () => {
        for (let i = 0; i < 50; i++)
            await paid(now, "translation");
        await expect(reserve(now, "translation")).rejects.toThrow("DAILY_BUDGET");
        for (let i = 0; i < 10; i++)
            await paid();
        await expect(reserve()).rejects.toThrow("DAILY_BUDGET");
    });
    it("honors 20 comparison calls and shared daily quotas even after small proven settlements", async () => {
        for (let i = 0; i < 20; i++)
            await paid();
        await expect(reserve()).rejects.toThrow("DAILY_BUDGET");
        await expect(paid(now, "translation")).resolves.toBeDefined();
        vi.stubEnv("SAV_DERIVED_DAILY_CALLS", "21");
        await expect(reserve(now, "translation")).rejects.toThrow("DAILY_BUDGET");
    });
    it("uses net settled amounts at both exact monetary thresholds and emits one daily alert", async () => {
        await history([
            23198208000
        ]);
        await reserve();
        expect(await getSavDerivedMoneyStatus(now)).toMatchObject({
            rollingNanoUsd: 24000000000, alert: true
        });
        expect((await f.db.select().from(auditLogs)).filter(r => r.action === "sav_derived_budget_alert")).toHaveLength(1);
        const [reserved] = (await f.db.select().from(auditLogs).where(eq(auditLogs.action,"sav_derived_call_reserved"))).filter(row=>row.createdAt.getTime()===now.getTime());
        await dispatchSavDerivedCall(reserved.id,"comparison",model,body,now);
        await settleSavDerivedCall(reserved.id,metadata,now);
        expect(await getSavDerivedMoneyStatus(now)).toMatchObject({alert:false});
        await reserve();
        expect((await f.db.select().from(auditLogs)).filter(row=>row.action==="sav_derived_budget_alert")).toHaveLength(1);
        await f.client.exec("TRUNCATE audit_logs");
        await history([
            29198208000
        ]);
        await reserve();
        await expect(reserve(new Date("2026-10-20T12:00:00Z"))).rejects.toThrow("MONETARY_BUDGET");
        expect(await getSavDerivedMoneyStatus(now)).toMatchObject({
            rollingNanoUsd: 30000000000
        });
    });
    it.skipIf(!process.env.SAV_TEST_POSTGRES_URL)("native concurrency reserves one affordable call and refunds only once", async () => {
        const admissions = await Promise.allSettled([
            reserve(), reserve()
        ]);
        expect(admissions.filter(a => a.status === "fulfilled")).toHaveLength(1);
        const row = (await f.db.select().from(auditLogs).where(eq(auditLogs.action, "sav_derived_call_reserved")))[0];
        await dispatchSavDerivedCall(row.id, "comparison", model, body, now);
        const settled = await Promise.all([
            settleSavDerivedCall(row.id, metadata, now), settleSavDerivedCall(row.id, metadata, now)
        ]);
        expect(settled.filter(a => "duplicate" in a)).toHaveLength(1);
        expect(await getSavDerivedMoneyStatus(now)).toMatchObject({
            dayNanoUsd: 195000
        });
    });
});
describe("SAV derived transport coverage", () => {
    const run = (fake: typeof fetch, phase: "learning_comparison" | "translation" = "learning_comparison") => requestSavGeminiJson({
        phase, apiKey: "synthetic", model, body, fetch: fake
    });
    it("automatically reserves legacy direct callers and never retries timeout/503", async () => {
        const fake = vi.fn(async () => new Response(null, {
            status: 503
        }));
        await expect(run(fake)).rejects.toThrow("HTTP_503");
        expect(fake).toHaveBeenCalledTimes(1);
        const current = await getSavDerivedMoneyStatus(new Date());
        expect(current).toMatchObject({
            dayNanoUsd: 801792000
        });
        await expect(run(fake)).rejects.toThrow("MONETARY_BUDGET");
        expect(fake).toHaveBeenCalledTimes(1);
    });
    it("charges verified usage for malformed JSON and does not invent absent thinking=0", async () => {
        const fake = vi.fn(async () => Response.json({
            candidates: [
                {
                    finishReason: "STOP", content: {
                        parts: [
                            {
                                text: "bad JSON"
                            }
                        ]
                    }
                }
            ], usageMetadata: {
                promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 60
            }
        }));
        let caught: unknown;
        try {
            await run(fake);
        }
        catch (error) {
            caught = error;
        }
        expect(savAiErrorMetadata(caught)).toMatchObject(metadata);
        expect(await getSavDerivedMoneyStatus(new Date())).toMatchObject({
            dayNanoUsd: 195000
        });
        await run(async () => Response.json({
            candidates: [
                {
                    finishReason: "STOP", content: {
                        parts: [
                            {
                                text: "{}"
                            }
                        ]
                    }
                }
            ], usageMetadata: {
                promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30
            }
        }));
        expect(await getSavDerivedMoneyStatus(new Date())).toMatchObject({
            dayNanoUsd: 801987000
        });
    });
    it("leaves ordinary understanding outside the derived ledger", async () => {
        await requestSavGeminiJson({
            phase: "understanding", apiKey: "synthetic", model: "unpriced-ordinary-model", body, fetch: async () => Response.json({
                candidates: [
                    {
                        content: {
                            parts: [
                                {
                                    text: "{}"
                                }
                            ]
                        }
                    }
                ]
            })
        });
        expect(await f.db.select().from(auditLogs)).toHaveLength(0);
    });
});
