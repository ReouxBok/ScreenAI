import type { IntakePlan, IntakeContact, IntakeAssociation, IntakeTicket, IntakeHistory } from "./engine-types";
import type { IntakeRuntimeConfig } from "./runtime-contract";
import type { ExecutionConfig, ExecutionPolicy } from "./execution-policy";
import type { savIntakeExecutions, savIntakeEffects } from "@/db/schema";
export type Execution = typeof savIntakeExecutions.$inferSelect;
export type Effect = typeof savIntakeEffects.$inferSelect;
export type EffectKind = "ticket_create" | "note_create" | "note_associate" | "email_create" | "email_associate" | "stage_new" | "identity_send";
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
};
export type ExecutionOptions = {
    config: ExecutionConfig;
    policy: ExecutionPolicy;
    runtime: IntakeRuntimeConfig;
    env: () => Record<string, string | undefined>;
    adapters: ExecutorAdapters;
    signal: AbortSignal;
};
