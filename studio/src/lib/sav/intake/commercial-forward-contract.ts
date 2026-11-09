import { z } from "zod";
import { savIntakeDecisionSchema } from "./contract";
export const COMMERCIAL_FORWARD_PURPOSE = "intake_commercial_forward";
export const commercialForwardResourceSchema = z.object({ schema: z.literal("sav-commercial-forward.v1"), recipient: z.email().max(254), subjectPrefix: z.string().min(1).max(100).refine(x => !/[\r\n\0]/.test(x)), introduction: z.string().min(10).max(2000), policy: z.string().min(20).max(5000) }).strict();
/** Semantic V1 decision, never a keyword or CRM subscription heuristic. */
export function assertPureCommercialDecision(value: unknown) { const d = savIntakeDecisionSchema.parse(value); if (d.classification !== "commercial" || !d.requests.length || d.requests.some(r => r.kind !== "commercial") || d.disposition.kind !== "no_ticket" || d.disposition.nextAction !== "supervised_commercial" || d.messageId !== d.latestInboundMessageId)
    throw Error("SAV_COMMERCIAL_PURE_REQUEST_REQUIRED"); return d; }
export function commercialForwardDeliveryState(a?: {
    status: string;
    payload: Record<string, unknown>;
}) { if (!a)
    return "available"; if (a.status === "succeeded")
    return "succeeded"; if (a.payload.forwardDispatchedAt)
    return "uncertain"; if (["pending", "running"].includes(a.status))
    return "pending"; return "failed"; }
