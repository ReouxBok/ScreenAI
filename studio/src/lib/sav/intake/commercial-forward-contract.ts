import { savIntakeDecisionSchema } from "./contract";
export const COMMERCIAL_FORWARD_PURPOSE = "intake_commercial_forward";
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
