import type { IntakePlan, IntakeContact, IntakeAssociation, IntakeTicket, IntakeHistory } from "./engine-types";
import type { IntakeRuntimeConfig } from "./runtime-contract";
import type { ExecutionConfig, ExecutionPolicy } from "./execution-policy";
import type { savIntakeExecutions, savIntakeEffects } from "@/db/schema";
export type Execution = typeof savIntakeExecutions.$inferSelect;
export type Effect = typeof savIntakeEffects.$inferSelect;
export type EffectKind = "ticket_create" | "note_create" | "note_associate" | "email_create" | "email_associate" | "stage_new" | "identity_send" | "owner_assign" | "reply_send" | "handoff_notify" | "ticket_stage";
export type CrmSnapshot = {
    address: string;
    lookup: IntakeContact[];
    contacts: Record<string, IntakeContact>;
    associations: IntakeAssociation[];
    tickets: Record<string, IntakeTicket[]>;
    histories: Record<string, IntakeHistory>;
};
export type ExecutionPayload = {
    runtimeConfigHash: string;
    authorityContinuityId?: string;
    plan: IntakePlan;
    input: unknown;
    local: {
        messageHash: string;
        sourceHash: string | null;
        threadIdentityHash: string;
        humanChoice: string | null;
        humanRequestedAt: string | null;
        status: string;
        ticketId: string | null;
    };
    baseline?: CrmSnapshot;
    /** Digest-only CRM evidence of the analysis, when it was recorded (SAV-45). */
    originalCrm?: import("./crm-evidence-fingerprint").CrmEvidenceFingerprint;
    keys: string[];
    reason?: string;
    crmDelta?: import("./execution-context").CrmDeltaDiagnostic;
    /** CRM wait schedule of the current episode (SAV-45); the journal is the durable source. */
    crmRecheck?: import("./crm-recheck").CrmRecheckState;
    lastRunId: string;
    acceptedFingerprint: string;
    effectsConfirmed?: boolean;
    concurrentHistoryHash?: string;
    completion?: { sourceHash: string; messageHash: string };
};
export type EffectIntent = {
    kind: EffectKind;
    permission: import("./contract").SavIntakeMutation;
    key: string;
    ticketId?: string;
    contactId?: string;
    objectId?: string;
    properties?: Record<string, string>;
    expectedProperties?: Record<string, string>;
    confirmedNoteCreate?: { effectId: string; objectId: string };
    text?: string;
    marker?: string;
    mailbox?: string;
    threadId?: string;
    recipient?: string;
    sourceMessageId: string;
    rfcMessageId?: string;
    raw?: string;
    resource?: {
        resourceId: string;
        revisionId: string;
        sha256: string;
    };
    expectedOwnerId?: string | null;
    /** `handoff_notify` only: the Slack channel id the notice is posted to (injected configuration, never read by another kind). */
    channel?: string;
    /** SAV-10: what a person validated for a `reply_send` (payload hash, case version, approver). Never read by the adapters. */
    caseEffect?: import("../cases/case-effect-intents").CaseEffectMeta;
};
export type EffectAck = {
    id?: string;
    threadId?: string;
    [key: string]: unknown;
};
export type ExecutorAdapters = {
    qualifyAddedEmails?(baseline:CrmSnapshot,current:CrmSnapshot,source:import("./crm-continuation").ContinuationSourceEmail,signal:AbortSignal):Promise<import("./crm-continuation").QualifiedCrmEmail[]>;
    readCrm(plan: IntakePlan, input: unknown, config: IntakeRuntimeConfig, signal: AbortSignal): Promise<CrmSnapshot>;
    scope(snapshot: CrmSnapshot, threadId: string, ticketId?: string | null): string[];
    dispatch(intent: EffectIntent, signal: AbortSignal): Promise<EffectAck>;
    verify(intent: EffectIntent, ack: EffectAck | null, dispatchedAt: Date, signal: AbortSignal): Promise<{
        confirmed: boolean;
        ack?: EffectAck;
        attributed: boolean;
        observedTicket?: IntakeTicket;
        observedHistory?: IntakeHistory[number];
    }>;
    gmailCurrent(mailbox: string, threadId: string, gmailMessageId: string, signal: AbortSignal): Promise<void>;
    gmailPermissions(mailbox: string, signal: AbortSignal): Promise<void>;
    /** V2 only (SAV-11/44), optional and not injected in production: the server decision to
     * give the ticket to the dedicated V2 owner (cases/owner-attribution). Never asked since
     * review R1 (31/10): no owner write is planned without a conditional HubSpot write. */
    v2OwnerAttribution?(input: { ticketId: string; decision: IntakePlan["decision"]; signal: AbortSignal }): Promise<{ assign: true; ownerId: string } | { assign: false; reason: string }>;
    /** Pilot access (3/11), optional and not injected in production: whether the ticket V1 is about to
     * CREATE carries the dedicated V2 owner in its POST (cases/owner-attribution `v2OwnerAtCreationPort`).
     * Asked only with `create_ticket_v2_owner` in the policy; nobody can own a ticket that does not exist yet. */
    v2OwnerAtCreation?(input: { decision: IntakePlan["decision"]; signal: AbortSignal }): Promise<{ assign: true; ownerId: string } | { assign: false; reason: string }>;
};
export type ExecutionOptions = {
    config: ExecutionConfig;
    policy: ExecutionPolicy;
    runtime: IntakeRuntimeConfig;
    env: () => Record<string, string | undefined>;
    adapters: ExecutorAdapters;
    signal: AbortSignal;
};
