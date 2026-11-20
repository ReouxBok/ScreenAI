import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("../hubspot-transport", () => ({ requestSavHubspot: request }));

import { qualifyThreadlessTicket, readThreadlessTicket, SAV_THREADLESS_SOURCE_REVISION, threadlessAccessQualified } from "./threadless-source";

const AT = "2026-11-18T10:00:00.000Z";
const SITE = "/crm/v3/objects/tickets/987?properties=";
const ASSOCIATIONS = "/crm/v4/objects/tickets/987/associations/";
const ENV = { SAV_V2_NEW_THREAD: "on", SAV_V2_HUBSPOT_OWNER_ID: "123", HUBSPOT_ACCESS_TOKEN: "synthetic" };
const TICKET = { id: "987", updatedAt: AT, properties: { subject: "Impossible de me connecter",
  content: "Je n’arrive pas à me connecter à mon compte.", hubspot_owner_id: "123", hs_pipeline: "0", hs_pipeline_stage: "1" } };
const CONTACT = { id: "555", properties: { email: "Client.Fictif@example.invalid" } };
const NOTE = "Note interne fictive : répondre à autre@example.invalid.";

function arrange(input: {
  contactIds?: number[]; contact?: { id: string; properties: { email?: string | null } }; emailIds?: number[];
  stage?: string; owner?: string; sourceType?: string; current?: typeof TICKET; partialContacts?: boolean; incompleteEmails?: boolean;
} = {}) {
  let ticketReads = 0;
  request.mockImplementation(async (path: string) => {
    if (path.startsWith(SITE)) {
      if (ticketReads++ && input.current) return input.current;
      return { ...TICKET, properties: { ...TICKET.properties, hs_pipeline_stage: input.stage ?? "1", hubspot_owner_id: input.owner ?? "123",
        source_type: input.sourceType } };
    }
    if (path === `${ASSOCIATIONS}emails?limit=1`) return input.incompleteEmails ? {} : { results: (input.emailIds ?? []).map(toObjectId => ({ toObjectId })) };
    if (path === `${ASSOCIATIONS}contacts?limit=2`) return { results: (input.contactIds ?? [555]).map(toObjectId => ({ toObjectId })),
      ...(input.partialContacts ? { paging: { next: { after: "556" } } } : {}) };
    if (path === `${ASSOCIATIONS}notes?limit=40`) return { results: [{ toObjectId: 333 }] };
    if (path === "/crm/v3/objects/notes/batch/read") return { status: "COMPLETE", results: [{ id: "333", properties: { hs_note_body: NOTE, hs_timestamp: AT } }] };
    if (path === "/crm/v3/objects/contacts/555?properties=email") return input.contact ?? CONTACT;
    throw Error("UNEXPECTED_SYNTHETIC_PATH");
  });
}

beforeEach(() => { request.mockReset(); });

describe("ticket HubSpot sans fil", () => {
  it("uses only the unique associated contact and saves the notes separately as source data", async () => {
    arrange();
    await expect(readThreadlessTicket("987", ENV)).resolves.toEqual({ status: "ready", source: {
      kind: "hubspot_ticket", revision: SAV_THREADLESS_SOURCE_REVISION, ticketId: "987", version: AT, ownerId: "123", stageId: "1",
      subject: TICKET.properties.subject, description: TICKET.properties.content, categories: "", notes: [{ id: "333", body: NOTE, at: AT }],
      contact: { id: "555", email: "client.fictif@example.invalid" },
    } });
  });

  it.each([
    { contactIds: [], reason: "no_contact" },
    { contactIds: [555, 556], reason: "multiple_contacts" },
    { partialContacts: true, reason: "multiple_contacts" },
    { contact: { id: "555", properties: {} }, reason: "missing_email" },
    { contact: { id: "555", properties: { email: "Client <client@example.invalid>" } }, reason: "invalid_email" },
  ])("leaves identity issue $reason to a person without selecting an address in a note", async ({ reason, ...input }) => {
    arrange(input);
    await expect(readThreadlessTicket("987", ENV)).resolves.toMatchObject({ status: "human_wait", reason, source: { contact: null } });
  });

  it("requires a renewed read when the ticket version changes while the snapshot is read", async () => {
    arrange({ current: { ...TICKET, updatedAt: "2026-11-18T10:01:00.000Z" } });
    await expect(readThreadlessTicket("987", ENV)).resolves.toEqual({ status: "unavailable" });
  });

  it("exits for an associated email before looking at notes or contact", async () => {
    arrange({ emailIds: [444] });
    await expect(readThreadlessTicket("987", ENV)).resolves.toEqual({ status: "existing_thread" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refuses an unreadable email association inventory", async () => {
    arrange({ incompleteEmails: true });
    await expect(readThreadlessTicket("987", ENV)).resolves.toEqual({ status: "unavailable" });
  });

  it("does not treat a CRM email-origin ticket with no visible mail as threadless", async () => {
    arrange({ sourceType: "EMAIL" });
    await expect(readThreadlessTicket("987", ENV)).resolves.toEqual({ status: "unavailable" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refuses a closed ticket or a ticket held by another owner", async () => {
    arrange({ stage: "4" });
    await expect(readThreadlessTicket("987", ENV)).resolves.toEqual({ status: "closed" });
    arrange({ owner: "456" });
    await expect(readThreadlessTicket("987", ENV)).resolves.toEqual({ status: "owner_changed" });
  });

  it("does not read HubSpot when the flag is absent", async () => {
    await expect(readThreadlessTicket("987", {})).resolves.toEqual({ status: "off" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("admission d'un ticket sans fil", () => {
  const rule = { ruleId: "access-fixture", revision: "synthetic-v1", family: "access", v1Kind: "support", at: AT };
  const policy = { revision: "policy-fixture", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: rule.ruleId, revision: rule.revision, families: ["access"] }],
    approvedBy: "20000000-0000-4000-8000-000000000001", approvedAt: AT };
  const env = { ...ENV, SAV_V2_ADMISSION_RULES_JSON: JSON.stringify([rule]), SAV_V2_ADMISSION_POLICY_JSON: JSON.stringify({
    policy, validFrom: AT, validUntil: "2026-11-19T10:00:00.000Z",
  }) };

  async function fixture() {
    arrange();
    const read = await readThreadlessTicket("987", env);
    if (read.status !== "ready") throw Error("SYNTHETIC_SOURCE_REQUIRED");
    return read.source;
  }

  it("admits the Access description under the existing approved rule", async () => {
    await expect(qualifyThreadlessTicket(await fixture(), env, new Date(AT))).resolves.toMatchObject({ status: "admitted",
      admission: { qualification: { identity: { status: "confirmed", source: { type: "hubspot_object", id: "987" } } } } });
  });

  it("passes sensitive wording to a person and excludes a description outside Access", async () => {
    const source = await fixture();
    await expect(qualifyThreadlessTicket({ ...source, description: "Je veux un remboursement." }, env, new Date(AT)))
      .resolves.toEqual({ status: "human_wait", reason: "sensitive_request" });
    await expect(qualifyThreadlessTicket({ ...source, description: "Comment configurer mon agenda ?" }, env, new Date(AT)))
      .resolves.toMatchObject({ status: "out_of_scope" });
  });

  it("lets a sensitive note alert the team without using notes to admit Access", async () => {
    const source = await fixture();
    const notes = [{ id: "333", at: AT, body: "Demande de remboursement ouverte." }];
    await expect(qualifyThreadlessTicket({ ...source, notes }, env, new Date(AT)))
      .resolves.toEqual({ status: "human_wait", reason: "sensitive_request" });
    await expect(qualifyThreadlessTicket({ ...source, description: "", notes: [{ ...notes[0]!, body: TICKET.properties.content }] }, env, new Date(AT)))
      .resolves.toMatchObject({ status: "out_of_scope" });
  });

  it("PORTE 2A: only a fresh Access qualification lets a first mail leave (smart, gone or changed: no)", async () => {
    const source = await fixture();
    expect(threadlessAccessQualified(await qualifyThreadlessTicket(source, env, new Date(AT)))).toBe(true);
    expect(threadlessAccessQualified(await qualifyThreadlessTicket(source, { ...env, SAV_V2_ENTRY_SMART: "on" }, new Date(AT)))).toBe(false);
    expect(threadlessAccessQualified(await qualifyThreadlessTicket({ ...source, description: "Comment configurer mon agenda ?" }, env, new Date(AT)))).toBe(false);
    expect(threadlessAccessQualified({ status: "human_wait", reason: "sensitive_request" })).toBe(false);
  });

  it("keeps the existing Gmail qualification scope closed to CRM tickets", async () => {
    await expect(qualifyThreadlessTicket(await fixture(), { ...env, SAV_V2_SCOPE_MODE: "qualification" }, new Date(AT)))
      .resolves.toEqual({ status: "out_of_scope", reason: "threadless_qualification_not_configured" });
  });
});
