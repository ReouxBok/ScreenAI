import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { contentItems, contentVersions, reviewEvents, savKnowledgeActivations } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { readCaseAccessScope, SAV_CASE_ACCESS_SCOPE_REVISION } from "./investigation-access-scope";
import {
  caseAccessScopeConfigReader, caseActiveSourceReader, caseInvestigationClock, casePolicyRevisionReader, caseProvenanceReaders,
  SAV_V2_ACCESS_SCOPE_ENV, SAV_V2_ACCESS_SCOPE_MAX_CHARS,
} from "./investigation-pilot-readers";

// B (4/11, SYN): the canonical provenance readers on an isolated database. Every card / version id comes from the database itself; the
// policy and scope are synthetic data of this test, approved by nobody.
const STAFF = "20000000-0000-4000-8000-000000000004", AT = "2026-11-01T00:00:00.000Z";
const POLICY = { revision: "policy-syn-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-syn", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
let f: Awaited<ReturnType<typeof createSavTestDb>>;

async function seed(options: { activate?: "first" | "second" | "none"; archived?: boolean; aiEnabled?: boolean; audience?: string; reviewed?: boolean } = {}) {
  const [item] = await f.db.insert(contentItems).values({ slug: `syn-${crypto.randomUUID()}`, type: "article", title: "Fiche synthétique", ownerEmail: "staff@example.invalid",
    status: options.archived ? "archived" : "published", agentKey: "sav", aiEnabled: options.aiEnabled ?? true, locale: "fr-FR", verifiedAt: new Date("2026-11-02T00:00:00Z") }).returning();
  const version = async (n: number) => (await f.db.insert(contentVersions).values({ itemId: item!.id, version: n, bodyMarkdown: `Procédure synthétique v${n} : ouvrir new.limova.ai.`,
    metadata: { intents: [], limovaPaths: [], prerequisites: [], expectedResult: "", troubleshooting: "", resolution: { audience: (options.audience ?? "support") as "support", symptoms: ["syn"],
      steps: ["Étape synthétique."], exceptions: [], escalation: "Revue", productVersion: "test", supersedes: [], conflictsWith: [] } }, changeNote: "Fixture", authorEmail: "staff@example.invalid" }).returning())[0]!;
  const first = await version(1), second = await version(2);
  await f.db.update(contentItems).set({ publishedVersionId: first.id }).where(eq(contentItems.id, item!.id));
  const activated = options.activate === "second" ? second : first;
  if (options.activate !== "none") await f.db.insert(savKnowledgeActivations).values({ itemId: item!.id, versionId: activated.id, title: "Fiche active synthétique", activatedBy: "fixture" });
  if (options.reviewed) await f.db.insert(reviewEvents).values({ itemId: item!.id, versionId: first.id, action: "approved", actorEmail: "staff@example.invalid" } as typeof reviewEvents.$inferInsert);
  return { item: item!, first, second };
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => { await f.client.exec("TRUNCATE content_items CASCADE"); });

describe("accessScope: configured, bounded, OFF by default", () => {
  const scope = (policyRevision: string) => JSON.stringify({ schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision, revision: "scope-syn-r1", family: "access",
    sources: [{ knowledgeId: "k-syn", contentVersionId: "k-syn-v1", use: "answer", firstReply: "login_code_steps" }] });
  const read = (raw: string | undefined) => readCaseAccessScope(caseAccessScopeConfigReader(() => ({ [SAV_V2_ACCESS_SCOPE_ENV]: raw })), POLICY.revision);
  it("absent or empty: no scope (OFF)", async () => {
    expect(await read(undefined)).toEqual({ ok: false, problem: "scope_missing" });
    expect(await read("  ")).toEqual({ ok: false, problem: "scope_missing" });
    expect(await caseAccessScopeConfigReader(() => ({}))()).toBeNull();
  });
  it("a scope for the policy in force is read as configured", async () => {
    expect(await read(scope(POLICY.revision))).toMatchObject({ ok: true, scope: { revision: "scope-syn-r1", sources: [{ firstReply: "login_code_steps" }] } });
  });
  it("another policy, a malformed one, not JSON or too large: refused", async () => {
    expect(await read(scope("policy-other"))).toEqual({ ok: false, problem: "scope_policy_mismatch" });
    expect(await read(JSON.stringify({ schema: "other" }))).toEqual({ ok: false, problem: "scope_invalid" });
    expect(await read("{not json")).toEqual({ ok: false, problem: "scope_unreadable" });
    expect(await read(" ".repeat(SAV_V2_ACCESS_SCOPE_MAX_CHARS) + scope(POLICY.revision))).toEqual({ ok: false, problem: "scope_unreadable" });
  });
});

describe("readActiveSource: the activated, published version, read now", () => {
  it("the activated version of an eligible SAV article is active, with its proof date", async () => {
    const { item, first } = await seed({ reviewed: true });
    const source = await caseActiveSourceReader()({ knowledgeId: item.id, contentVersionId: first.id });
    expect(source).toMatchObject({ active: true, title: "Fiche active synthétique", content: expect.stringContaining("v1") });
    expect(source!.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("another version of the same card, a card never activated, archived, AI off or another audience: not active, no proof date", async () => {
    const other = await seed({ activate: "second" });
    expect(await caseActiveSourceReader()({ knowledgeId: other.item.id, contentVersionId: other.first.id })).toMatchObject({ active: false, verifiedAt: null });
    for (const options of [{ activate: "none" as const }, { archived: true }, { aiEnabled: false }, { audience: "lead" }]) {
      const card = await seed(options);
      expect(await caseActiveSourceReader()({ knowledgeId: card.item.id, contentVersionId: card.first.id })).toMatchObject({ active: false, verifiedAt: null });
    }
  });
  it("a version of another card, an unknown pair or ids that are not the base's: null, no query on a malformed id", async () => {
    const a = await seed(), b = await seed();
    expect(await caseActiveSourceReader()({ knowledgeId: a.item.id, contentVersionId: b.first.id })).toBeNull();
    expect(await caseActiveSourceReader()({ knowledgeId: a.item.id, contentVersionId: crypto.randomUUID() })).toBeNull();
    expect(await caseActiveSourceReader()({ knowledgeId: "k-syn", contentVersionId: "k-syn-v1" })).toBeNull();
  });
});

describe("now and currentPolicyRevision", () => {
  it("the clock is the wall clock", () => {
    const before = Date.now(), at = caseInvestigationClock().getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at - before).toBeLessThan(1_000);
  });
  it("A's record valid now gives its revision; none, expired, not yet valid or malformed gives null", async () => {
    const now = () => new Date("2026-11-04T12:00:00Z");
    const record = (policy: unknown, validFrom = "2026-11-01T00:00:00Z", validUntil = "2026-12-01T00:00:00Z") => async () => ({ policy, validFrom, validUntil });
    expect(await casePolicyRevisionReader(record(POLICY), now)()).toBe("policy-syn-r1");
    expect(await casePolicyRevisionReader(async () => null, now)()).toBeNull();
    expect(await casePolicyRevisionReader(record(POLICY, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"), now)()).toBeNull();
    expect(await casePolicyRevisionReader(record(POLICY, "2026-11-10T00:00:00Z"), now)()).toBeNull();
    expect(await casePolicyRevisionReader(record({ revision: "" }), now)()).toBeNull();
  });
  it("the four readers together are A's record, the configuration, the base and the clock: OFF without configuration", async () => {
    const readers = caseProvenanceReaders({ readPolicyRecord: async () => null, env: () => ({}) });
    expect(Object.keys(readers).sort()).toEqual(["accessScope", "currentPolicyRevision", "now", "readActiveSource", "readTemporaryIncidents"]);
    expect(await readers.readTemporaryIncidents!([], new Date())).toMatchObject({ ok: true, context: { scope: "scope_missing", entries: [] } });
    expect(await readers.accessScope()).toBeNull();
    expect(await readers.currentPolicyRevision()).toBeNull();
  });
});
