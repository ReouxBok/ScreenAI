// V2 wake (local, OFF): the CANONICAL adapter of every port `runCaseV2Wake` needs, so the composition (nativebuild09) wires one function and no test double sits on the normal
// path. Each adapter below is the real one; a port with no real implementation in the repo is NOT faked here: it is a REQUIRED argument that has no default (see CONTRAT.md §9).
//   owner              A's `ticketOwnerPort` on a read-only HubSpot GET of the ticket's owner (real HubSpot, token from env)
//   Slack              `createHandoffSlackAdapters` (default of `runHandoffNoticePass`), real Slack Web API, bot token and channel from env
//   CRM reading        `createHandoffCrmReader` (read-only HubSpot), for the handoff notice
//   CRM stage          `createCaseTicketStageAdapters` (default of `runCaseTicketStagePass`): PATCH stage only, GET to verify
//   MIME send/verify   `createIntakeExecutorAdapters`: the existing executor's Gmail send / read-back and HubSpot reads
//   policy revision    A's `admissionPolicyRevisionPort` on `readPolicyRecord` — MISSING in the repo: required argument
// `network` defaults to the global `fetch`; nothing else is read from the process unless `env` says so.
import "server-only";
import { createIntakeExecutorAdapters, type GmailRequest } from "../intake/execution-adapters";
import { createSavHubspotTransport } from "../hubspot-transport";
import { admissionPolicyRevisionPort, type AdmissionPolicyRecord } from "./admission-runtime";
import { caseTicketOwnerPortFromTransport, type CaseOwnerReadTransport } from "./admission-owner-reader";
import { createHandoffCrmReader } from "./case-handoff-crm";
import type { CaseTicketOwnerPort } from "./case-ticket-owner";
import type { CaseV2WakeDeps } from "./case-v2-wake";

const TIMEOUT_MS = 10_000;

/** Read-only HubSpot GET for the owner reader: exactly the path A's reader asks for, nothing else, bearer token from env, a non-2xx answer throws (never « no owner »). */
export function createCaseOwnerReadTransport(input: Readonly<{ env: () => Record<string, string | undefined>; network?: typeof fetch }>): CaseOwnerReadTransport {
  const network = input.network ?? fetch;
  // The token is read at each request (a rotated or removed value takes effect at once); a request without it never leaves.
  const request = createSavHubspotTransport((url, init) => {
    const token = input.env().HUBSPOT_ACCESS_TOKEN;
    if (!token) throw Error("SAV_CASE_OWNER_READ_TOKEN_MISSING");
    return network(url, { ...init, redirect: "error", headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${token}` } });
  });
  return async ({ method, path }) => {
    if (method !== "GET" || !/^\/crm\/v3\/objects\/tickets\/[0-9]{1,30}\?properties=hubspot_owner_id$/.test(path)) throw Error("SAV_CASE_OWNER_READ_REQUEST_FORBIDDEN");
    return request<unknown>(path, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } }, status => `SAV_CASE_OWNER_READ_HTTP_${status}`);
  };
}

/** A's `ticketOwnerPort` on the real read. The V2 owner is re-read from `env()` at every call (a changed or removed value takes effect at once). */
export function createCaseTicketOwnerPort(input: Readonly<{ env: () => Record<string, string | undefined>; network?: typeof fetch }>): CaseTicketOwnerPort {
  const transport = createCaseOwnerReadTransport(input);
  return snapshot => caseTicketOwnerPortFromTransport({ transport, env: input.env() })(snapshot);
}

export type CaseV2WakeCompositionInput = Readonly<{
  env: () => Record<string, string | undefined>;
  /** The approved execution policy `{ id, hash }` (the one `SAV_INTAKE_EXECUTION_POLICY_*` names). */
  policy: Readonly<{ id: string; hash: string }>;
  /** REQUIRED, no default: the reader of the current admission policy record. The repo has no persisted source for it (A's `readPolicyRecord` is only an injected port). */
  readPolicyRecord: () => Promise<AdmissionPolicyRecord | null>;
  since: Date;
  deadlineMs: number;
  now?: () => Date;
  network?: typeof fetch;
  /** Gmail transport of the MIME send / read-back. Absent: the real one (`requestSavGmail`, the connected mailbox). Tests with a synthetic provider inject theirs; production does not. */
  gmail?: Readonly<{ request?: GmailRequest; permissions?: (mailbox: string, signal: AbortSignal) => Promise<void> }>;
  limit?: number;
}>;

/** The wake's dependencies with the canonical adapter on every port. Nothing here runs anything. */
export function createCaseV2WakeDeps(input: CaseV2WakeCompositionInput): CaseV2WakeDeps {
  const network = input.network ?? fetch, now = input.now ?? (() => new Date());
  return {
    policy: input.policy, since: input.since,
    replies: {
      env: input.env, deadlineMs: input.deadlineMs, ...(input.limit === undefined ? {} : { limit: input.limit }),
      adapters: createIntakeExecutorAdapters({
        network, env: input.env, ...(input.gmail?.request ? { gmailRequest: input.gmail.request } : {}), ...(input.gmail?.permissions ? { gmailPermissions: input.gmail.permissions } : {}),
      }),
      readTicketOwner: createCaseTicketOwnerPort({ env: input.env, network }),
      currentPolicyRevision: admissionPolicyRevisionPort({ read: input.readPolicyRecord, now }),
    },
    handoff: { network, crm: createHandoffCrmReader({ network, env: input.env }) },
    stages: { network },
  };
}
