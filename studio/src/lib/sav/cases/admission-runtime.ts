import { z } from "zod";
import { SAV_INTAKE_CONTRACT_REVISION, type SavIntakeDecision } from "../intake/contract";
import { v1IntentHash } from "./case-store";
import {
  caseAdmissionPolicySchema, caseAwaitsV2Attribution, caseOwnerAtCreationProofSchema,
  type CaseAdmissionDecision, type CaseAdmissionQualification, type CaseOwnerAtCreationProof, type CaseSensitivity, type CaseSnapshot,
} from "./case-types";
import type { CaseBoundaryDeps, CaseQualificationTarget } from "./intake-boundary";

/*
 * Pole A runtime seams for admission and V2 ownership (SAV-44/SAV-11). Injectable ports only:
 * nothing here is wired into production, reads a database, calls HubSpot or writes anything.
 * Unavailable is never absent: a reader that cannot read throws, and the caller keeps waiting.
 */

type Env = Record<string, string | undefined>;
const OWNER_ID = /^[0-9]{1,20}$/;

/** Who decided that V1's intake-only identity may count for V2 admission, and how far. None
 * (null) is today's state: V1 identity never confirms anyone for V2 (decision D-a, open). */
export type V1AdmissionAdapterPolicy = { revision: string; decidedBy: string; identity: "none" | "sender_unique_crm_match" };
const adapterPolicySchema = z.object({
  revision: z.string().trim().min(1).max(200), decidedBy: z.string().trim().min(1).max(200), identity: z.enum(["none", "sender_unique_crm_match"]),
}).strict();

/** V1's stored decision of the relayed execution, as V1 confirmed it, with what makes it current. */
export type ConfirmedV1Context = {
  decision: Pick<SavIntakeDecision, "revision" | "messageId" | "classification" | "requests" | "disposition">;
  source: { messageId: string; gmailMessageId: string; executionId: string; executionState: string; runId: string | null; runVersion: number; ticketId: string };
  /** The latest V1 run of this message and whether an operator refused its analysis. */
  freshness: { latestRunVersion: number; humanRefused: boolean };
};

export type V1QualificationTrace = {
  identity: "adapter_policy_absent" | "adapter_identity_none" | "context_not_current" | "not_ticket_disposition" | "human_equivalent_contacts"
    | "customer_declared_address" | "primary_contact_missing" | "confirmed_sender_unique_crm_match";
  crmContext: "adapter_policy_absent" | "context_not_current" | "not_ticket_disposition" | "search_incomplete" | "complete";
};

function contextCurrent(context: ConfirmedV1Context) {
  const { decision, source, freshness } = context;
  // A V1 execution without its run (runId null) cannot show it is the message's latest analysis.
  return decision.revision === SAV_INTAKE_CONTRACT_REVISION && source.executionState === "confirmed" && decision.messageId === source.messageId
    && source.runId !== null && source.runVersion === freshness.latestRunVersion && !freshness.humanRefused;
}

/** Conservative V1 → V2 qualification: identity and CRM completeness only. It proves no request
 * family (no approved rule exists: V1 categories stay hints, and a sensitive hint still excludes)
 * and never adds a team signal. Anything stale, refused or not a ticket disposition is unknown. */
export function qualificationFromConfirmedV1(context: ConfirmedV1Context, adapterPolicy: V1AdmissionAdapterPolicy | null): { qualification: CaseAdmissionQualification; trace: V1QualificationTrace } {
  return qualifyTicketIdentity(context.decision, adapterPolicy, contextCurrent(context));
}

/** Both paths use the same CRM identity evidence. Before creation the caller proves freshness
 * with the executing V1 lease; after creation it must use the confirmed execution and ticket. */
export function qualifyTicketIdentity(decision: Pick<SavIntakeDecision, "disposition">, adapterPolicy: V1AdmissionAdapterPolicy | null, current: boolean): { qualification: CaseAdmissionQualification; trace: V1QualificationTrace } {
  const unknown = (identity: V1QualificationTrace["identity"], crmContext: V1QualificationTrace["crmContext"]) =>
    ({ qualification: { requests: [], identity: { status: "unknown" as const }, crmContext: "unknown" as const, teamSignals: [] }, trace: { identity, crmContext } });
  const policy = adapterPolicy === null ? null : adapterPolicySchema.parse(adapterPolicy);
  if (!policy) return unknown("adapter_policy_absent", "adapter_policy_absent");
  if (!current) return unknown("context_not_current", "context_not_current");
  const disposition = decision.disposition;
  if (disposition.kind !== "ticket") return unknown("not_ticket_disposition", "not_ticket_disposition");
  const complete = disposition.search === "complete" && disposition.history === "complete" && disposition.contactScope.complete;
  const crmContext = complete ? "complete" as const : "unknown" as const;
  const crmTrace = complete ? "complete" as const : "search_incomplete" as const;
  const identity = (status: "unknown" | "ambiguous", trace: V1QualificationTrace["identity"]) =>
    ({ qualification: { requests: [], identity: { status }, crmContext, teamSignals: [] }, trace: { identity: trace, crmContext: crmTrace } });
  if (policy.identity === "none") return identity("unknown", "adapter_identity_none");
  if (disposition.identity.kind === "human_equivalent_contacts") return identity("ambiguous", "human_equivalent_contacts");
  if (disposition.identity.addressOrigin !== "sender") return identity("unknown", "customer_declared_address");
  const primary = disposition.contactScope.primaryContactId;
  if (!primary || !disposition.contactScope.contacts.some(contact => contact.contactId === primary && contact.origin === "email_lookup")) return identity("unknown", "primary_contact_missing");
  return {
    qualification: { requests: [], identity: { status: "confirmed", source: { type: "hubspot_object", id: primary } }, crmContext, teamSignals: [] },
    trace: { identity: "confirmed_sender_unique_crm_match", crmContext: crmTrace },
  };
}

/** `CaseBoundaryDeps.readQualification` from V1's confirmed context. The relay's target is required
 * and compared with the context's source (message, Gmail id, ticket, execution, run, version) before
 * any qualification: a missing target or any difference throws. No V1 execution for the message:
 * null (the relay keeps V1 hints, which never admit). A read that fails throws: the relay stops and
 * its durable catch-up replays it, nothing is admitted on a guess. */
export function v1QualificationPort(deps: {
  readConfirmedContext(messageId: string): Promise<ConfirmedV1Context | null>;
  adapterPolicy(): Promise<V1AdmissionAdapterPolicy | null>;
}): NonNullable<CaseBoundaryDeps["readQualification"]> {
  return async ({ messageId, gmailMessageId, target }) => {
    if (!target) throw Error("SAV_V1_QUALIFICATION_TARGET_MISSING");
    const context = await deps.readConfirmedContext(messageId);
    if (!context) return null;
    if (!sourceMatchesTarget(context.source, { messageId, gmailMessageId, ...target })) throw Error("SAV_V1_QUALIFICATION_SOURCE_MISMATCH");
    return qualificationFromConfirmedV1(context, await deps.adapterPolicy()).qualification;
  };
}

function sourceMatchesTarget(source: ConfirmedV1Context["source"], target: CaseQualificationTarget & { messageId: string; gmailMessageId: string }) {
  return source.messageId === target.messageId && source.gmailMessageId === target.gmailMessageId && source.ticketId === target.ticketId
    && target.executionId !== null && source.executionId === target.executionId && source.runId === target.runId && source.runVersion === target.runVersion;
}

/** The approved admission policy with its validity window, as stored by whoever approves it. */
export type AdmissionPolicyRecord = { policy: unknown; validFrom: string; validUntil: string };

function currentPolicy(record: AdmissionPolicyRecord | null, now: Date): unknown {
  if (!record) return null;
  const from = Date.parse(record.validFrom), until = Date.parse(record.validUntil), at = now.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until || at < from || at >= until) return null;
  return record.policy;
}

/** `CaseBoundaryDeps.readAdmissionPolicy`: none, expired or not yet valid gives null (nobody is
 * admitted); a malformed policy is passed on, so admission records `policy_invalid`. */
export function admissionPolicyPort(deps: { read(): Promise<AdmissionPolicyRecord | null>; now(): Date }): NonNullable<CaseBoundaryDeps["readAdmissionPolicy"]> {
  return async () => currentPolicy(await deps.read(), deps.now());
}

/** The revision B's runner and the store compare against; null when no valid policy applies. */
export function admissionPolicyRevisionPort(deps: { read(): Promise<AdmissionPolicyRecord | null>; now(): Date }) {
  return async (): Promise<string | null> => {
    const parsed = caseAdmissionPolicySchema.safeParse(currentPolicy(await deps.read(), deps.now()));
    return parsed.success ? parsed.data.revision : null;
  };
}

export type V2OwnerConfiguration = { ok: true; ownerId: string } | { ok: false; reason: "not_configured" | "malformed" | "same_as_v1_owner" };
/** SAV_V2_HUBSPOT_OWNER_ID as configured by Ugo: digits only, and never the V1 team owner
 * (HUBSPOT_SAV_OWNER_ID), so a ticket handed to the team can never read as taken by V2. */
export function v2OwnerConfiguration(env: Env = process.env): V2OwnerConfiguration {
  const value = env.SAV_V2_HUBSPOT_OWNER_ID;
  if (!value) return { ok: false, reason: "not_configured" };
  if (!OWNER_ID.test(value)) return { ok: false, reason: "malformed" };
  if (value === env.HUBSPOT_SAV_OWNER_ID) return { ok: false, reason: "same_as_v1_owner" };
  return { ok: true, ownerId: value };
}

export type TicketOwnerReading = "v2" | "human" | "none" | "unknown";
/** B's `readTicketOwner`, from a read-only HubSpot owner read. `undefined` (the read did not return
 * the property) is unknown, never none; without a valid V2 owner nobody reads as V2. A failed read
 * throws (B stops with `owner_read_failed`). */
export function ticketOwnerPort(deps: { readHubspotTicketOwner(ticketId: string): Promise<string | null | undefined>; env?: Env }) {
  return async (snapshot: Pick<CaseSnapshot, "ticketId">): Promise<TicketOwnerReading> => {
    const owner = await deps.readHubspotTicketOwner(snapshot.ticketId);
    if (owner === undefined || (owner !== null && !OWNER_ID.test(owner))) return "unknown";
    if (owner === null) return "none";
    const v2 = v2OwnerConfiguration(deps.env);
    return v2.ok && owner === v2.ownerId ? "v2" : "human";
  };
}

/** What the store reads back from V1's ledger for a ticket created with the V2 owner (route 3A):
 * the `ticket_create` effect row, its decrypted intent and the owner seen when V1 verified it. Read
 * from the ledger, never declared by a caller. V1 does not plan this today, so none exists. */
export type TicketCreateReceipt = {
  executionId: string; effectId: string; kind: string; state: string; intentHash: string;
  intent: { kind?: string; properties?: { hubspot_owner_id?: string } };
  createdTicketId: string | null;
  /** Owner seen on the ticket at V1's verification: undefined when not read. */
  verifiedOwnerId: string | null | undefined;
};

// The proof now lives with the case types, which the store checks it against (pilot access, 3/11).
export { caseOwnerAtCreationProofSchema, type CaseOwnerAtCreationProof };

export const SAV_V2_SAFE_ATTRIBUTION_REFUSALS = [
  "no_v2_owner_configured", "owner_unknown", "human_owner_present", "already_v2_owner", "sensitive", "case_not_pending", "case_with_team",
  "not_admitted", "policy_stale", "existing_unowned_no_conditional_write",
  "receipt_missing", "receipt_invalid", "receipt_not_ticket_create", "receipt_not_confirmed", "receipt_hash_mismatch", "receipt_owner_mismatch", "receipt_ticket_mismatch", "receipt_owner_not_observed", "current_owner_not_v2",
] as const;
export type V2SafeAttributionRefusal = typeof SAV_V2_SAFE_ATTRIBUTION_REFUSALS[number];
export type V2SafeAttribution = { attribute: true; proof: CaseOwnerAtCreationProof } | { attribute: false; reason: V2SafeAttributionRefusal };

/** Safe V2 ownership, decided without writing anything. `existing_ticket`: HubSpot has no conditional
 * owner write, so a read then a PATCH (or two reads) could overwrite a person: a human is refused before
 * any write and an unowned ticket stays with the team until a provider guarantee is proven (D-e).
 * `created_with_owner`: only V1's own receipt of a ticket created with the V2 owner in the creation
 * itself, seen with it at verification AND read as the V2 owner just now: a person who took the ticket
 * after V1's verification, or an owner that cannot be read now, refuses it. The ticket stage
 * (« Nouveau ») is never an input. A pure guard on reads: it is not a provider compare-and-set and not
 * the store's transactional proof, which must re-read V1's ledger under the ticket lock (lot 2, after C). */
export function decideSafeV2Attribution(input: {
  route: "existing_ticket" | "created_with_owner";
  env?: Env;
  ticketId: string;
  /** The ticket's owner read just now, on both routes (undefined: not read). */
  currentOwnerId?: string | null | undefined;
  case: Pick<CaseSnapshot, "owner" | "phase" | "body" | "sensitivity"> | null;
  messageSensitivity: CaseSensitivity;
  /** Decided now from this input, as the relay will. */
  admission: Pick<CaseAdmissionDecision, "target" | "policyRevision">;
  currentPolicyRevision: string | null;
  receipt?: TicketCreateReceipt | null;
}): V2SafeAttribution {
  const refuse = (reason: V2SafeAttributionRefusal) => ({ attribute: false as const, reason });
  const v2 = v2OwnerConfiguration(input.env);
  if (!v2.ok) return refuse("no_v2_owner_configured");
  if (input.route === "created_with_owner" && !input.receipt) return refuse("receipt_missing");
  // Every owner seen counts: now, and for a created ticket also at V1's verification.
  const observed = input.route === "existing_ticket" ? [input.currentOwnerId] : [input.currentOwnerId, input.receipt!.verifiedOwnerId];
  if (observed.some(owner => owner === undefined || (owner !== null && !OWNER_ID.test(owner)))) return refuse("owner_unknown");
  if (observed.some(owner => owner !== null && owner !== v2.ownerId)) return refuse("human_owner_present");
  if (input.route === "existing_ticket" && input.currentOwnerId === v2.ownerId) return refuse("already_v2_owner");
  if (input.messageSensitivity !== "none" || (input.case && input.case.sensitivity !== "none")) return refuse("sensitive");
  if (input.case?.owner === "agent") return refuse("case_not_pending");
  if (input.case && !caseAwaitsV2Attribution(input.case)) return refuse("case_with_team");
  if (input.admission.target !== "agent") return refuse("not_admitted");
  if (input.currentPolicyRevision === null || input.admission.policyRevision !== input.currentPolicyRevision) return refuse("policy_stale");
  if (input.route === "existing_ticket") return refuse("existing_unowned_no_conditional_write");
  const receipt = input.receipt!;
  if (receipt.kind !== "ticket_create" || receipt.intent.kind !== "ticket_create") return refuse("receipt_not_ticket_create");
  if (receipt.state !== "confirmed") return refuse("receipt_not_confirmed");
  if (v1IntentHash(receipt.intent) !== receipt.intentHash) return refuse("receipt_hash_mismatch");
  if (receipt.intent.properties?.hubspot_owner_id !== v2.ownerId) return refuse("receipt_owner_mismatch");
  if (receipt.createdTicketId !== input.ticketId) return refuse("receipt_ticket_mismatch");
  if (receipt.verifiedOwnerId !== v2.ownerId) return refuse("receipt_owner_not_observed");
  if (input.currentOwnerId !== v2.ownerId) return refuse("current_owner_not_v2");
  const proof = caseOwnerAtCreationProofSchema.safeParse({ kind: "hubspot_owner_at_creation", executionId: receipt.executionId, effectId: receipt.effectId, ticketId: input.ticketId, ownerId: v2.ownerId, intentHash: receipt.intentHash });
  return proof.success ? { attribute: true, proof: proof.data } : refuse("receipt_invalid");
}
