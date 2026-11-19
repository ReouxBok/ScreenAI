import "server-only";
import { z } from "zod";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { requestSavHubspot } from "../hubspot-transport";
import { intakeHtmlToText } from "../intake/html-message";
import { containsPromptInjection, isSavOutboundRecipientAllowed } from "../policy";
import { decideCaseAdmission, type CaseAdmissionInput } from "./admission-policy";
import { admissionPolicyPort, v2OwnerConfiguration, type AdmissionPolicyRecord } from "./admission-runtime";
import { SAV_CASE_BLOCK_REGISTRY } from "./case-block-registry";
import { caseBlockCandidates, caseBlockRuleProvenance, selectCaseBlockRule, type CaseEntryRule } from "./case-blocks";
import type { CaseOpenedRequest } from "./case-store";
import { SAV_CASE_ACCESS_BLOCK_ID, type SourceRef } from "./case-types";
import { savCaseSensitiveWording } from "./investigation-return-qualify";
import { readSavV2QualificationScope } from "./qualification-scope";
import { caseSensitiveFamiliesInText } from "./sensitive-words";
import { savV2NewThreadEnabled } from "./threadless-config";
import { readOrComputeAccessSkill, type AccessSkillDeps, type AccessSkillReading } from "./access-skill/access-skill-judge";
import { SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID } from "./access-skill/access-skill-guidelines";
import { readAccessSkillMode } from "./access-skill/access-skill-rule";
import type { AccessSkillInput } from "./access-skill/access-skill-wire";

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_THREADLESS_SOURCE_REVISION = "sav-hubspot-ticket-source.v1";
const NOTES_LIMIT = 40;
const id = z.string().regex(/^\d{1,30}$/);
const date = z.iso.datetime({ offset: true });
const email = z.email().max(254);
const noteSchema = z.object({ id, body: z.string().max(20_000), at: z.string().max(80).nullable() }).strict();

export const threadlessTicketSourceSchema = z.object({
  kind: z.literal("hubspot_ticket"), revision: z.literal(SAV_THREADLESS_SOURCE_REVISION),
  ticketId: id, version: date, ownerId: id, stageId: id,
  subject: z.string().max(1_000), description: z.string().max(32_000), categories: z.string().max(1_000),
  notes: z.array(noteSchema).max(NOTES_LIMIT), contact: z.object({ id, email }).strict().nullable(),
}).strict();
export type ThreadlessTicketSource = z.infer<typeof threadlessTicketSourceSchema>;

export const threadlessTicketEventSchema = z.object({
  source: threadlessTicketSourceSchema, ownerTransitionKey: z.string().min(1).max(420), observedAt: date,
  waitReason: z.string().regex(/^[a-z_]{1,80}$/).optional(),
});
export type ThreadlessTicketEvent = z.infer<typeof threadlessTicketEventSchema>;

const associationsPage = z.object({
  results: z.array(z.object({ toObjectId: z.union([id, z.number().int().nonnegative().transform(String)]) })),
  paging: z.object({ next: z.object({ after: z.union([id, z.number().int().nonnegative()]) }).optional() }).optional(),
});
const ticketRecord = z.object({
  id, updatedAt: date, archived: z.boolean().optional(),
  properties: z.object({
    subject: z.string().max(1_000).nullish(), content: z.string().max(32_000).nullish(),
    hubspot_owner_id: id.nullable(), hs_pipeline: id, hs_pipeline_stage: id, hs_ticket_category: z.string().max(1_000).nullish(),
    source_type: z.string().max(80).nullish(),
  }),
});
const notesBatch = z.object({
  status: z.literal("COMPLETE"), errors: z.array(z.unknown()).optional(),
  results: z.array(z.object({ id, archived: z.boolean().optional(), properties: z.object({
    hs_note_body: z.string().max(20_000).nullable(), hs_timestamp: z.string().max(80).nullable(),
  }) })),
});
const contactRecord = z.object({ id, archived: z.boolean().optional(), properties: z.object({ email: z.string().nullish() }) });

type IdentityReason = "no_contact" | "multiple_contacts" | "missing_email" | "invalid_email" | "recipient_not_allowed";
export type ThreadlessTicketRead =
  | { status: "ready"; source: ThreadlessTicketSource }
  | { status: "human_wait"; reason: IdentityReason; source: ThreadlessTicketSource }
  | { status: "off" | "existing_thread" | "out_of_scope" | "closed" | "owner_changed" | "unavailable" };

type ReadHubspot = (path: string, body?: unknown) => Promise<unknown>;

async function readNotes(read: ReadHubspot, ticketUrl: string): Promise<ThreadlessTicketSource["notes"]> {
  const page = associationsPage.parse(await read(`${ticketUrl}/associations/notes?limit=${NOTES_LIMIT}`));
  const ids = [...new Set(page.results.map(row => row.toObjectId))];
  if (page.paging?.next || ids.length > NOTES_LIMIT) throw Error("SAV_V2_THREADLESS_NOTES_INCOMPLETE");
  if (!ids.length) return [];
  const batch = notesBatch.parse(await read("/crm/v3/objects/notes/batch/read", {
    properties: ["hs_note_body", "hs_timestamp"], inputs: ids.map(id => ({ id })),
  }));
  const records = new Map(batch.results.map(note => [note.id, note]));
  if (batch.errors?.length || batch.results.length !== ids.length || records.size !== ids.length
    || ids.some(id => !records.has(id) || records.get(id)?.archived)) throw Error("SAV_V2_THREADLESS_NOTES_INCOMPLETE");
  return ids.sort().map(id => ({ id, body: records.get(id)!.properties.hs_note_body ?? "", at: records.get(id)!.properties.hs_timestamp }));
}

async function readContact(read: ReadHubspot, ticketUrl: string, env: Env): Promise<
  | { contact: NonNullable<ThreadlessTicketSource["contact"]> }
  | { contact: null; reason: IdentityReason }
> {
  const page = associationsPage.parse(await read(`${ticketUrl}/associations/contacts?limit=2`));
  const ids = [...new Set(page.results.map(row => row.toObjectId))];
  if (page.paging?.next || ids.length > 1) return { contact: null, reason: "multiple_contacts" };
  const contactId = ids[0];
  if (!contactId) return { contact: null, reason: "no_contact" };
  const record = contactRecord.parse(await read(`/crm/v3/objects/contacts/${contactId}?properties=email`));
  if (record.id !== contactId || record.archived) throw Error("SAV_V2_THREADLESS_CONTACT_CHANGED");
  const raw = record.properties.email;
  if (!raw?.trim()) return { contact: null, reason: "missing_email" };
  const address = email.safeParse(raw.toLowerCase());
  if (!address.success) return { contact: null, reason: "invalid_email" };
  if (!isSavOutboundRecipientAllowed(address.data, { testMode: env.SAV_TEST_MODE === "true", allowlist: env.SAV_TEST_OUTBOUND_ALLOWLIST ?? "" }))
    return { contact: null, reason: "recipient_not_allowed" };
  return { contact: { id: contactId, email: address.data } };
}

/** Strict reads at the entry and the final send gate. An incomplete CRM read proves neither identity nor absence of a mail. */
export async function readThreadlessTicket(ticketId: string, env: Env = process.env): Promise<ThreadlessTicketRead> {
  if (!savV2NewThreadEnabled(env)) return { status: "off" };
  const owner = v2OwnerConfiguration(env);
  if (!id.safeParse(ticketId).success || !owner.ok || !env.HUBSPOT_ACCESS_TOKEN) return { status: "unavailable" };
  const headers = { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, Accept: "application/json", "Content-Type": "application/json" };
  const signal = AbortSignal.timeout(20_000);
  const read: ReadHubspot = (path, body) => requestSavHubspot(path, {
    method: body === undefined ? "GET" : "POST", cache: "no-store", signal, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, status => `HUBSPOT_HTTP_${status}`);
  const ticketUrl = `/crm/v4/objects/tickets/${ticketId}`;
  const ticketPath = `/crm/v3/objects/tickets/${ticketId}?properties=subject,content,hubspot_owner_id,hs_pipeline,hs_pipeline_stage,hs_ticket_category,source_type`;
  try {
    const ticket = ticketRecord.parse(await read(ticketPath));
    if (ticket.id !== ticketId || ticket.archived) return { status: "unavailable" };
    const properties = ticket.properties;
    if (properties.hs_pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId) return { status: "out_of_scope" };
    if (properties.hs_pipeline_stage === SAV_HUBSPOT_SUPPORT.stages.closed) return { status: "closed" };
    if (properties.hubspot_owner_id !== owner.ownerId) return { status: "owner_changed" };
    const mailPage = associationsPage.parse(await read(`${ticketUrl}/associations/emails?limit=1`));
    if (mailPage.results.length || mailPage.paging?.next) return { status: "existing_thread" };
    if (properties.source_type === SAV_HUBSPOT_SUPPORT.source) return { status: "unavailable" };
    if (![SAV_HUBSPOT_SUPPORT.stages.new, SAV_HUBSPOT_SUPPORT.stages.awaitingTeam].some(stage => stage === properties.hs_pipeline_stage))
      return { status: "out_of_scope" };
    const notes = await readNotes(read, ticketUrl);
    const identity = await readContact(read, ticketUrl, env);
    const current = ticketRecord.parse(await read(ticketPath));
    if (current.properties.hubspot_owner_id !== owner.ownerId) return { status: "owner_changed" };
    if (current.id !== ticketId || current.archived || current.updatedAt !== ticket.updatedAt
      || JSON.stringify(current.properties) !== JSON.stringify(properties)) return { status: "unavailable" };
    const source: ThreadlessTicketSource = {
      kind: "hubspot_ticket", revision: SAV_THREADLESS_SOURCE_REVISION, ticketId, version: ticket.updatedAt,
      ownerId: owner.ownerId, stageId: properties.hs_pipeline_stage, subject: properties.subject ?? "", description: properties.content ?? "",
      categories: properties.hs_ticket_category ?? "", notes, contact: identity.contact,
    };
    return "reason" in identity ? { status: "human_wait", reason: identity.reason, source } : { status: "ready", source };
  } catch { return { status: "unavailable" }; }
}

export function threadlessTicketSourceRef(source: ThreadlessTicketSource): SourceRef {
  return { type: "hubspot_object", id: source.ticketId, revision: source.version };
}

export function threadlessTicketPlainDescription(source: ThreadlessTicketSource): string {
  return /<\/?[a-z][^>]*>/i.test(source.description) ? intakeHtmlToText(source.description) : source.description;
}

export type ThreadlessTicketQualification =
  | { status: "admitted"; admission: CaseAdmissionInput; request: CaseOpenedRequest }
  | { status: "out_of_scope" | "human_wait"; reason: string };

/** SAV-96 B: the one request of a ticket case (`openCaseFromHubspotTicket`), and SAV-97's input for it: subject and whole description, never a note. */
export const threadlessRequestId = (source: Pick<ThreadlessTicketSource, "ticketId">) => `hubspot-ticket:${source.ticketId}/access`;
export const threadlessAccessSkillMessageId = (source: Pick<ThreadlessTicketSource, "ticketId">) => `hubspot-ticket-${source.ticketId}`;
export const threadlessAccessSkillInput = (source: ThreadlessTicketSource): AccessSkillInput =>
  ({ purpose: "first_mail", subject: source.subject, text: threadlessTicketPlainDescription(source), originalRequest: null, requests: [{ requestId: threadlessRequestId(source), kind: "support", words: null }] });

/** SAV-97's reading of a ticket: the stored one, or computed once when `compute` (the entry only; every later check reads what was stored). */
export function readThreadlessAccessSkill(source: ThreadlessTicketSource, env: Env, compute: boolean, deps: Partial<AccessSkillDeps> = {}): Promise<AccessSkillReading> {
  return readOrComputeAccessSkill({ env: () => env, now: () => new Date(), ...deps },
    { purpose: "first_mail", messageId: threadlessAccessSkillMessageId(source), input: threadlessAccessSkillInput(source), compute });
}

export type ThreadlessQualifyOptions = Readonly<{ accessSkillCompute?: boolean; accessSkillDeps?: Partial<AccessSkillDeps> }>;

/**
 * A subject or contact alone never admits a case. Only the whole CRM description can match the approved Access rule.
 * SAV-96 B, `SAV_V2_ACCESS_SKILL=on`: like a mail (`v2-entry.ts` `accessSkillBlockEvidence`), the Access block is decided by SAV-97's skill on the ticket's
 * subject and description (kernel, judge, counter-read), never by the detector's wording nor its lexical veto; only the skill's rule at THIS revision admits.
 * Kept: the CRM billing and cancellation categories, the notes' alerts, the prompt-injection check, the identified contact and the approved policy.
 */
export async function qualifyThreadlessTicket(source: ThreadlessTicketSource, env: Env, now = new Date(), options: ThreadlessQualifyOptions = {}): Promise<ThreadlessTicketQualification> {
  if (readSavV2QualificationScope(env, now).mode !== "open") return { status: "out_of_scope", reason: "threadless_qualification_not_configured" };
  const description = threadlessTicketPlainDescription(source);
  const categories = source.categories.split(";").map(category => category.trim());
  const skill = readAccessSkillMode(env) === "on";
  // Notes may alert the team about a sensitive case. Only the ticket's own description may admit it.
  if (categories.includes(SAV_HUBSPOT_SUPPORT.categories.billing) || categories.includes(SAV_HUBSPOT_SUPPORT.categories.cancellation)
    || (!skill && savCaseSensitiveWording(description, source.subject)) || source.notes.some(note => caseSensitiveFamiliesInText(intakeHtmlToText(note.body)).length > 0))
    return { status: "human_wait", reason: "sensitive_request" };
  if (containsPromptInjection(`${source.subject}\n${description}`)) return { status: "human_wait", reason: "untrusted_source" };
  try {
    const rules = JSON.parse(env.SAV_V2_ADMISSION_RULES_JSON ?? "[]") as CaseEntryRule[];
    let rule: CaseEntryRule;
    if (skill) {
      const own = rules.find(row => row?.ruleId === SAV_ACCESS_SKILL_RULE_ID && row.revision === SAV_ACCESS_SKILL_REVISION && row.family === "access" && row.v1Kind === "support"
        && (row.blockId === undefined || row.blockId === SAV_CASE_ACCESS_BLOCK_ID));
      if (!own) return { status: "out_of_scope", reason: "no_block_rule" };
      if (!source.contact) return { status: "human_wait", reason: "identity_unconfirmed" };
      const reading = await readThreadlessAccessSkill(source, env, options.accessSkillCompute === true, options.accessSkillDeps);
      if (reading.status !== "ready") return { status: "human_wait", reason: `access_skill_${reading.reason}` };
      if (reading.verdict.outcome !== "admit") return { status: "human_wait", reason: reading.verdict.reasons.includes("no_access_request") && reading.verdict.reasons.length === 1 ? "not_access" : "sensitive_request" };
      if (reading.verdict.requests[threadlessRequestId(source)] !== "access") return { status: "out_of_scope", reason: "not_access" };
      rule = own;
    } else {
      // The historical admission, byte for byte (every configured rule is a detector's candidate, as before SAV-96 B).
      const selected = selectCaseBlockRule(caseBlockCandidates(rules, SAV_CASE_BLOCK_REGISTRY), description, source.subject);
      if (selected.reason !== "admitted") return { status: "out_of_scope", reason: selected.reason };
      if (selected.block.blockId !== SAV_CASE_ACCESS_BLOCK_ID || selected.rule.family !== "access") return { status: "out_of_scope", reason: "not_access" };
      if (!source.contact) return { status: "human_wait", reason: "identity_unconfirmed" };
      rule = selected.rule;
    }
    const policy = await admissionPolicyPort({
      read: async () => JSON.parse(env.SAV_V2_ADMISSION_POLICY_JSON ?? "null") as AdmissionPolicyRecord | null,
      now: () => now,
    })();
    const request = { id: threadlessRequestId(source), summary: "Difficulté de connexion signalée dans HubSpot" };
    const admission: CaseAdmissionInput = { policy, qualification: {
      requests: [{ requestId: request.id, family: "access", provenance: caseBlockRuleProvenance(rule) }],
      identity: { status: "confirmed", source: threadlessTicketSourceRef(source) }, crmContext: "complete", teamSignals: [],
    } };
    const decision = decideCaseAdmission({ ...admission, caseSensitivity: "none" });
    return decision.target === "agent" ? { status: "admitted", admission, request }
      : { status: "out_of_scope", reason: decision.reasons[0]! };
  } catch { return { status: "out_of_scope", reason: "policy_invalid" }; }
}
