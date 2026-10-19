import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import type { SavGeminiMetadata } from "./gemini-response";
type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
type Stage = "comparison" | "translation";
export const SAV_DERIVED_COST_REVISION = "sav-derived-usd-2026-10-19.v1";
export const SAV_DERIVED_MONEY = {
    dayNanoUsd: 1000000000, rollingNanoUsd: 30000000000, alertNanoUsd: 24000000000
} as const;
const PRICE_FROM = Date.parse("2026-07-30T00:00:00Z"), PRICE_UNTIL = Date.parse("2027-01-01T00:00:00Z");
const INPUT_LIMIT = 1048576, INPUT_NANO_USD = 750, OUTPUT_NANO_USD = 3750;
const DAY_MS = 86400000, RESERVED = "sav_derived_call_reserved";
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const failure = (code: string): never => { throw new Error(code); };
export function isSavDerivedBudgetDeferred(error: unknown) {
    return error instanceof Error && /^SAV_DERIVED_(?:DAILY|MONETARY|COST|PRICE|MODEL|RESERVATION|REQUEST)/.test(error.message);
}
export function savDerivedBudgets() {
    const bound = (name: string, fallback: number) => {
        const value = Number(process.env[name] ?? fallback);
        return Number.isFinite(value) ? Math.min(fallback, Math.max(0, Math.floor(value))) : 0;
    };
    return {
        comparison: bound("SAV_COMPARISON_DAILY_CALLS", 20), translation: bound("SAV_TRANSLATION_DAILY_CALLS", 50), total: bound("SAV_DERIVED_DAILY_CALLS", 60), simulation: 0
    };
}
/** Full published model input limit covers system/data/schema without estimating
 * text tokenization. maxOutputTokens includes thinking per Google's thinking
 * guide. Text-only, no tools/cache/grounding, Standard Gemini Developer API.
 * Tariff: ai.google.dev/gemini-api/docs/pricing#gemini-3.6-flash (2026-10-19).
 * The provider's documented contract is an assumption, not a billing guarantee. */
export function savDerivedCostQuote(model: string, maxOutputTokens: number, now = new Date()) {
    if (model !== "gemini-3.6-flash")
        return failure("SAV_DERIVED_MODEL_UNPRICED");
    if (!Number.isFinite(now.getTime()) || now.getTime() < PRICE_FROM || now.getTime() >= PRICE_UNTIL)
        return failure("SAV_DERIVED_PRICE_EXPIRED");
    if (!integer(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 8192)
        return failure("SAV_DERIVED_REQUEST_UNBOUNDED");
    return {
        budgetRevision: SAV_DERIVED_COST_REVISION, model, maxInputTokens: INPUT_LIMIT, maxOutputTokens,
        inputNanoUsdPerToken: INPUT_NANO_USD, outputNanoUsdPerToken: OUTPUT_NANO_USD,
        reservedNanoUsd: INPUT_LIMIT * INPUT_NANO_USD + maxOutputTokens * OUTPUT_NANO_USD,
        priceExpiresAt: new Date(PRICE_UNTIL).toISOString()
    };
}
async function lock(tx: Tx) { await tx.execute(sql `select pg_advisory_xact_lock(hashtext('sav-derived-model-budget'))`); }
function verifiedUsageCost(metadata: Record<string, unknown>, maxOutputTokens: number) {
    const { inputTokens, outputTokens, thoughtTokens, totalTokens } = metadata;
    if (![
        inputTokens, outputTokens, thoughtTokens, totalTokens
    ].every(integer) ||
        (inputTokens as number) < 1 || (inputTokens as number) > INPUT_LIMIT ||
        (outputTokens as number) + (thoughtTokens as number) > maxOutputTokens ||
        (inputTokens as number) + (outputTokens as number) + (thoughtTokens as number) !== totalTokens)
        return null;
    return (inputTokens as number) * INPUT_NANO_USD + ((outputTokens as number) + (thoughtTokens as number)) * OUTPUT_NANO_USD;
}
function charge(metadata: Record<string, unknown>) {
    if(metadata.stage!=="comparison" && metadata.stage!=="translation")return failure("SAV_DERIVED_COST_HISTORY_UNKNOWN");
    let quote: ReturnType<typeof savDerivedCostQuote>;
    try {
        quote = savDerivedCostQuote(String(metadata.model), metadata.maxOutputTokens as number, new Date(PRICE_FROM));
    }
    catch {
        return failure("SAV_DERIVED_COST_HISTORY_UNKNOWN");
    }
    if (Object.entries(quote).some(([key, value]) => metadata[key] !== value))
        return failure("SAV_DERIVED_COST_HISTORY_UNKNOWN");
    if (metadata.chargedNanoUsd === undefined)
        return quote.reservedNanoUsd;
    const verified = verifiedUsageCost(metadata, quote.maxOutputTokens);
    if (!metadata.dispatchedAt || !Number.isFinite(Date.parse(String(metadata.settledAt))) || verified === null || verified !== metadata.chargedNanoUsd || verified > quote.reservedNanoUsd)
        return failure("SAV_DERIVED_COST_HISTORY_UNKNOWN");
    return verified;
}
async function usage(tx: Tx, now: Date) {
    const day = new Date(now.toISOString().slice(0, 10) + "T00:00:00Z"), rolling = new Date(now.getTime() - 30 * DAY_MS);
    const rows = await tx.select().from(auditLogs).where(and(eq(auditLogs.action, RESERVED), gt(auditLogs.createdAt, rolling)));
    let dayNanoUsd = 0, rollingNanoUsd = 0, dayCalls = 0;
    const stageCalls = {
        comparison: 0, translation: 0
    };
    for (const row of rows) {
        if (row.createdAt > now)
            return failure("SAV_DERIVED_COST_HISTORY_UNKNOWN");
        const cost = charge(row.technicalMetadata);
        rollingNanoUsd += cost;
        if (row.createdAt >= day) {
            dayNanoUsd += cost;
            dayCalls++;
            const stage = row.technicalMetadata.stage;
            if (stage !== "comparison" && stage !== "translation")
                return failure("SAV_DERIVED_COST_HISTORY_UNKNOWN");
            stageCalls[stage]++;
        }
    }
    return {
        day, rolling, dayNanoUsd, rollingNanoUsd, dayCalls, stageCalls
    };
}
async function alert(tx: Tx, now: Date, rollingNanoUsd: number) {
    if (rollingNanoUsd < SAV_DERIVED_MONEY.alertNanoUsd)
        return;
    const entityId = now.toISOString().slice(0, 10);
    const [existing] = await tx.select({
        id: auditLogs.id
    }).from(auditLogs).where(and(eq(auditLogs.action, "sav_derived_budget_alert"), eq(auditLogs.entityId, entityId))).limit(1);
    if (!existing)
        await tx.insert(auditLogs).values({
            actorEmail: "system", action: "sav_derived_budget_alert", entityType: "sav_derived_budget", entityId,
            technicalMetadata: {
                budgetRevision: SAV_DERIVED_COST_REVISION, rollingNanoUsd, thresholdNanoUsd: SAV_DERIVED_MONEY.alertNanoUsd
            }, createdAt: now
        });
}
/** Same inter-process lock covers call quotas, both monetary windows and alerts.
 * No network under this transaction. Unknown/crashed attempts retain full cost. */
export async function reserveSavDerivedCallTx(tx: Tx, stage: Stage, now = new Date(), proofKey?: string, request = {
    model: process.env.SAV_AI_MODEL ?? "gemini-3.6-flash", maxOutputTokens: stage === "comparison" ? 4096 : 8192
}) {
    const quote = savDerivedCostQuote(request.model, request.maxOutputTokens, now);
    await lock(tx);
    const used = await usage(tx, now), limits = savDerivedBudgets();
    if (used.dayCalls >= limits.total || used.stageCalls[stage] >= limits[stage])
        return failure("SAV_DERIVED_DAILY_BUDGET_EXHAUSTED");
    if (used.dayNanoUsd + quote.reservedNanoUsd > SAV_DERIVED_MONEY.dayNanoUsd || used.rollingNanoUsd + quote.reservedNanoUsd > SAV_DERIVED_MONEY.rollingNanoUsd)
        return failure("SAV_DERIVED_MONETARY_BUDGET_EXHAUSTED");
    const [row] = await tx.insert(auditLogs).values({
        actorEmail: "system", action: RESERVED, entityType: "sav_derived_budget", entityId: now.toISOString().slice(0, 10),
        technicalMetadata: {
            stage, ...(proofKey ? {
                proofKey
            } : {}), ...quote
        }, createdAt: now
    }).returning({
        id: auditLogs.id
    });
    await alert(tx, now, used.rollingNanoUsd + quote.reservedNanoUsd);
    return {
        reservationId: row.id, used: used.stageCalls[stage] + 1, total: used.dayCalls + 1, limits
    };
}
export async function reserveSavDerivedCall(stage: Stage, model: string, maxOutputTokens: number) {
    return requireDb().transaction(tx => reserveSavDerivedCallTx(tx, stage, new Date(), undefined, {
        model, maxOutputTokens
    }));
}
/** A durable single-use fence immediately before the sole fetch. Re-use or
 * changed model/configuration never dispatches a second request. */
export async function dispatchSavDerivedCall(reservationId: string, stage: Stage, model: string, body: Record<string, unknown>, now = new Date()) {
    const config = body.generationConfig as Record<string, unknown> | undefined;
    const quote = savDerivedCostQuote(model, config?.maxOutputTokens as number, now);
    const allowed = [
        "systemInstruction", "contents", "generationConfig"
    ];
    if (Object.keys(body).some(key => !allowed.includes(key)) || config?.candidateCount !== undefined || config?.responseModalities !== undefined)
        return failure("SAV_DERIVED_REQUEST_UNBOUNDED");
    for (const contents of [
        body.systemInstruction, ...(Array.isArray(body.contents) ? body.contents : [])
    ]) {
        if (!contents || typeof contents !== "object" || !Array.isArray((contents as {
            parts?: unknown;
        }).parts))
            return failure("SAV_DERIVED_REQUEST_UNBOUNDED");
        for (const part of (contents as {
            parts: unknown[];
        }).parts)
            if (!part || typeof part !== "object" || Object.keys(part).some(key => key !== "text") || typeof (part as {
                text?: unknown;
            }).text !== "string")
                return failure("SAV_DERIVED_REQUEST_UNBOUNDED");
    }
    await requireDb().transaction(async (tx) => {
        await lock(tx);
        const [row] = await tx.select().from(auditLogs).where(and(eq(auditLogs.id, reservationId), eq(auditLogs.action, RESERVED))).for("update");
        const meta = row?.technicalMetadata;
        if (!row || !meta || meta.stage !== stage || meta.dispatchedAt || meta.settledAt || Object.entries(quote).some(([key, value]) => meta[key] !== value))
            return failure("SAV_DERIVED_RESERVATION_MISMATCH");
        if (row.createdAt.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10))
            return failure("SAV_DERIVED_RESERVATION_STALE");
        await tx.update(auditLogs).set({
            technicalMetadata: {
                ...meta, dispatchedAt: now.toISOString()
            }
        }).where(eq(auditLogs.id, row.id));
    });
}
export async function savDerivedDispatchState(reservationId: string) {
    const [row] = await requireDb().select().from(auditLogs).where(and(eq(auditLogs.id, reservationId), eq(auditLogs.action, RESERVED)));
    return row ? Boolean(row.technicalMetadata.dispatchedAt) : null;
}
/** Absence is never zero. Only complete coherent usage proves a refund; malformed
 * responses still pay. Retry/timeout/crash/invalid usage retain the upper bound. */
export async function settleSavDerivedCall(reservationId: string, metadata: SavGeminiMetadata, now = new Date()) {
    return requireDb().transaction(async (tx) => {
        await lock(tx);
        const [row] = await tx.select().from(auditLogs).where(and(eq(auditLogs.id, reservationId), eq(auditLogs.action, RESERVED))).for("update");
        if (!row || row.technicalMetadata.budgetRevision !== SAV_DERIVED_COST_REVISION)
            return {
                settled: false
            };
        const m = row.technicalMetadata;
        if (m.settledAt)
            return {
                settled: true, duplicate: true, chargedNanoUsd: m.chargedNanoUsd
            };
        const { inputTokens, outputTokens, thoughtTokens, totalTokens } = metadata;
        const chargedNanoUsd = verifiedUsageCost({
            ...metadata
        }, Number(m.maxOutputTokens));
        if (!m.dispatchedAt || chargedNanoUsd === null || !integer(m.reservedNanoUsd) || chargedNanoUsd > m.reservedNanoUsd)
            return {
                settled: false
            };
        await tx.update(auditLogs).set({
            technicalMetadata: {
                ...m, chargedNanoUsd, settledAt: now.toISOString(), inputTokens: inputTokens!, outputTokens: outputTokens!, thoughtTokens: thoughtTokens!, totalTokens: totalTokens!
            }
        }).where(eq(auditLogs.id, row.id));
        return {
            settled: true, chargedNanoUsd
        };
    });
}
export async function getSavDerivedMoneyStatus(now = new Date()) {
    try {
        return await requireDb().transaction(async (tx) => {
            await lock(tx);
            const current = await usage(tx, now);
            const [pending] = await tx.select({
                n: sql<number> `count(*)::int`
            }).from(auditLogs).where(and(eq(auditLogs.action, "sav_derived_comparison_deferred"), sql `${auditLogs.technicalMetadata}->>'state'='pending'`));
            return {
                pendingComparisons: pending.n, ...current, limits: SAV_DERIVED_MONEY, alert: current.rollingNanoUsd >= SAV_DERIVED_MONEY.alertNanoUsd, unknown: false as const
            };
        });
    }
    catch {
        return {
            unknown: true as const
        };
    }
}
