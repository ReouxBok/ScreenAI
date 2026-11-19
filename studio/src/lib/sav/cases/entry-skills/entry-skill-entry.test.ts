import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
import { ACCESS_SKILL_TEST_PROVIDER_ENV } from "../../../../../test/sav-access-skill-double";
import { confirmSays, counterSaysNo, entrySkillModelDouble, routerSays, type EntryDoubleCall, type EntryDoubleAnswer } from "../../../../../test/sav-entry-skill-double";
import { FAKE_BLOCK, FAKE_BLOCK_B, FAKE_BLOCK_ID } from "../../../../../test/sav-entry-fake-block";
import { savMailboxes, savMessages, savSyncState, savThreads } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { decryptSavPayload, encryptSavPayload } from "../../crypto";
import { decideCaseAdmission } from "../admission-policy";
import type { CaseEntryRule } from "../case-blocks";
import { SAV_CASE_BLOCK_REGISTRY } from "../case-block-registry";
import type { CaseAdmissionQualification } from "../case-types";
import { SAV_CASE_BLOCK_SCOPE_REVISION } from "../investigation-access-scope";
import { SAV_V2_BLOCK_SCOPES_ENV } from "../investigation-pilot-readers";
import { firstBlockEvidence, type CaseEntrySource } from "../v2-entry";
import { SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID } from "../access-skill/access-skill-guidelines";
import { accessSkillStoreKey } from "../access-skill/access-skill-judge";
import { entrySkillRuleId } from "../../skills/entry-block";
import { SAV_ENTRY_SKILL_SHADOW_PREFIX, SAV_ENTRY_SKILL_STORE_PREFIX } from "./entry-skill-reading";

/*
 * Chantier « 3 blocs », the entry on the real stores (PGlite) with the model doubled at the network boundary only: the real `firstBlockEvidence`, wire,
 * key resolution, transport bounds, V2 spend gate, stores and pure rules. A FAKE block (`demo_export`, test-only). Fictional data only.
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "";
const AT = "2026-11-19T09:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000019", POLICY_REVISION = "policy-blocks-19";
const LEGACY: CaseEntryRule = { ruleId: "rule-access", revision: "r1", v1Kind: "support", family: "access", at: AT };
const SKILL: CaseEntryRule = { ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION, v1Kind: "support", family: "access", at: AT };
const DEMO: CaseEntryRule = { ruleId: entrySkillRuleId(FAKE_BLOCK_ID), revision: FAKE_BLOCK.skill.revision, v1Kind: "support", family: "usage", at: AT, blockId: FAKE_BLOCK_ID };
const NOTICE = { SAV_HANDOFF_NOTICE: "on", SAV_HANDOFF_SLACK_BOT_TOKEN: "xoxb-synthetic-0000000000", SAV_HANDOFF_SLACK_CHANNEL_ID: "C0SYNTHETIC0" };
const POLICY = (rules: Array<{ ruleId: string; revision: string; families: string[]; blockId?: string }>) =>
  ({ revision: POLICY_REVISION, admittedFamilies: ["access", "usage"], qualifiedRules: rules, approvedBy: STAFF, approvedAt: AT });
const APPROVED = POLICY([{ ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION, families: ["access"] }, { ruleId: DEMO.ruleId, revision: DEMO.revision, families: ["usage"], blockId: FAKE_BLOCK_ID }]);
const SCOPE = { schema: SAV_CASE_BLOCK_SCOPE_REVISION, blockId: FAKE_BLOCK_ID, family: "usage", policyRevision: POLICY_REVISION, revision: "scope-demo-r1",
  sources: [{ knowledgeId: "k-demo", contentVersionId: "k-demo-v1", use: "answer" }] };
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-19" } };

const env = (blocks: Record<string, string> | null, rules: CaseEntryRule[] = [LEGACY, SKILL, DEMO], access: string | null = "on") => ({
  ...ACCESS_SKILL_TEST_PROVIDER_ENV, ...NOTICE, SAV_V2_ADMISSION_RULES_JSON: JSON.stringify(rules), ...(access ? { SAV_V2_ACCESS_SKILL: access } : {}),
  SAV_V2_ADMISSION_POLICY_JSON: JSON.stringify({ policy: APPROVED, validFrom: "2025-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" }),
  [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify([SCOPE]), ...(blocks ? { SAV_V2_ENTRY_BLOCKS_JSON: JSON.stringify(blocks) } : {}) }) as Record<string, string>;

const LOGIN = "Bonjour, je ne reçois pas le code de connexion depuis ce matin. Merci", LOGIN_QUOTE = "je ne reçois pas le code de connexion";
const EXPORT = "Bonjour, comment imprimer le planning de la semaine ? Merci", EXPORT_QUOTE = "comment imprimer le planning de la semaine";

/** An honest synthetic model for both blocks: the router reads the words, each skill confirms its own topic, counter-reads say « no ». */
const honest = (call: EntryDoubleCall): EntryDoubleAnswer => {
  const ids = (call.payload.requests ?? []).map(row => row.requestId), text = call.payload.text;
  const topic = (requestId: string) => { const words = call.payload.requests?.find(row => row.requestId === requestId)?.words ?? text; return words.includes("imprimer") ? "export" : "login"; };
  const quote = (requestId: string) => topic(requestId) === "export" ? EXPORT_QUOTE : LOGIN_QUOTE;
  if (call.kind === "counter") return { output: counterSaysNo() };
  if (call.kind === "router") return { output: routerSays(ids.map(id => [id, topic(id) === "export" ? FAKE_BLOCK_ID : "access"])) };
  if (call.kind === "access_judge") return { output: confirmSays(ids.map(id => ({ requestId: id, verdict: topic(id) === "login" ? "access" : "other", quote: quote(id) }))) };
  return { output: confirmSays(ids.map(id => ({ requestId: id, verdict: topic(id) === "export" ? "block" : "other", quote: quote(id) }))) };
};

async function mail(text: string, subject = "Demande") {
  const threadId = randomUUID(), messageId = randomUUID(), gmail = `gm-${messageId}`;
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject, customerEmail: "client@exemple.invalid" });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: "client@exemple.invalid", toEmails: ["support@exemple.invalid"], subject,
    bodyCiphertext: encryptSavPayload({ text }), receivedAt: new Date(AT), gmailMessageId: gmail });
  return { messageId, gmail, single: [{ requestId: `${gmail}/r1`, kind: "support" }] };
}
type Mail = Awaited<ReturnType<typeof mail>>;
const evidence = (e: Record<string, string>, m: Mail, network: ReturnType<typeof entrySkillModelDouble>["network"] | null, source: CaseEntrySource = {}, requests = m.single) =>
  firstBlockEvidence(e, m.messageId, m.gmail, requests, SAV_CASE_BLOCK_REGISTRY, { accessSkillCompute: "always", skillBlocks: [FAKE_BLOCK, FAKE_BLOCK_B], ...source,
    accessSkillDeps: { network: network ?? (async () => { throw Error("NETWORK_FORBIDDEN"); }), ...source.accessSkillDeps } });
const rowsLike = async (prefix: string) => f.db.select().from(savSyncState).where(like(savSyncState.key, `${prefix}%`));
const admittedBy = (rows: CaseAdmissionQualification["requests"]) => rows.map(row => row.provenance.kind === "qualified_rule"
  ? `${row.provenance.ruleId}@${row.provenance.revision}${row.provenance.blockId ? `#${row.provenance.blockId}` : ""}` : `${row.provenance.kind}:${"reason" in row.provenance ? row.provenance.reason : ""}`);
const logged = (spy: ReturnType<typeof vi.spyOn>, event: string) => spy.mock.calls.filter((call: unknown[]) => call[0] === event).map((call: unknown[]) => call[1] as Record<string, unknown>);
const withoutIds = (rows: Array<Record<string, unknown>>) => rows.map(({ messageId: _m, ...rest }) => rest);
let infos: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "entry-skill-entry-fixture-key-32chars!!");
  f = await createSavTestDb(); state.db = f.db;
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@exemple.invalid" }).returning();
  mailboxId = mailbox!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "entry-skill-entry-fixture-key-32chars!!"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("GLOBAL_NETWORK_FORBIDDEN"); }));
  infos = vi.spyOn(console, "info").mockImplementation(() => {});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Accès seul bloc à skill actif : le chemin SAV-97 à l'identique", () => {
  it("mêmes admissions, mêmes appels, mêmes clés de stockage, mêmes journaux, avec ou sans réglage des autres blocs", async () => {
    const before = (await rowsLike(SAV_ENTRY_SKILL_STORE_PREFIX)).length;
    const runs: Array<{ rows: string[]; calls: string[]; logs: unknown[]; accessKey: boolean }> = [];
    // No setting; the fake block off; on but without its rule configured (only Access can admit); unknown ids; unreadable setting.
    const settings: Array<Record<string, string> | null | "broken"> = [null, { [FAKE_BLOCK_ID]: "off" }, { [FAKE_BLOCK_ID]: "on" }, { ghost: "on", access: "on" }, "broken"];
    for (const setting of settings) {
      for (const text of [LOGIN, EXPORT]) {
        infos.mockClear();
        const model = entrySkillModelDouble(honest), m = await mail(text);
        const e = setting === "broken" ? { ...env(null, [LEGACY, SKILL]), SAV_V2_ENTRY_BLOCKS_JSON: "{oops" } : env(setting, setting && FAKE_BLOCK_ID in setting && setting[FAKE_BLOCK_ID] === "on" ? [LEGACY, SKILL] : [LEGACY, SKILL, DEMO]);
        const rows = await evidence(e, m, model.network);
        const accessKey = (await f.db.select().from(savSyncState).where(eq(savSyncState.key, accessSkillStoreKey("first_mail", m.messageId)))).length === 1;
        runs.push({ rows: admittedBy(rows), calls: model.calls.map(call => call.kind), logs: withoutIds(logged(infos, "sav_v2_access_skill")), accessKey });
      }
    }
    const reference = runs.slice(0, 2);
    expect(reference).toEqual([
      { rows: [`${SAV_ACCESS_SKILL_RULE_ID}@${SAV_ACCESS_SKILL_REVISION}`], calls: ["access_judge", "counter"], logs: [expect.objectContaining({ mode: "on", skill: "admit" })], accessKey: true },
      { rows: [], calls: ["access_judge"], logs: [expect.objectContaining({ mode: "on", skill: "team", reasons: "no_access_request" })], accessKey: true },
    ]);
    for (let index = 2; index < runs.length; index += 2) expect(runs.slice(index, index + 2)).toEqual(reference);
    // Nothing of the two-stage entry was read, computed or stored.
    expect((await rowsLike(SAV_ENTRY_SKILL_STORE_PREFIX)).length).toBe(before);
    expect(logged(infos, "sav_v2_entry_skill")).toEqual([]);
  });
  it("Accès off ou shadow : un bloc « on » est lu off (signalé), le chemin des détecteurs est inchangé", async () => {
    for (const access of [null, "shadow"]) {
      const model = entrySkillModelDouble(honest), m = await mail(LOGIN);
      expect(admittedBy(await evidence(env({ [FAKE_BLOCK_ID]: "on" }, [LEGACY, SKILL, DEMO], access), m, model.network))).toEqual(["rule-access@r1"]);
      expect(model.calls.every(call => call.kind !== "router" && call.kind !== "judge")).toBe(true);
    }
    expect(logged(errors, "sav_v2_entry_blocks_setting")).toContainEqual(expect.objectContaining({ ignored: [{ key: FAKE_BLOCK_ID, reason: "access_skill_not_on" }] }));
  });
});

describe("deux blocs à skill actifs (Accès + bloc factice) : entrée à deux étages", () => {
  const ON = { [FAKE_BLOCK_ID]: "on" };
  it("le bloc factice est admis par SA règle (qualified_rule <bloc>-entry-skill, révision, blockId) ; la politique décide", async () => {
    const model = entrySkillModelDouble(honest), m = await mail(EXPORT);
    const rows = await evidence(env(ON), m, model.network);
    expect(rows).toEqual([{ requestId: m.single[0]!.requestId, family: "usage", provenance: { kind: "qualified_rule", ruleId: DEMO.ruleId, revision: DEMO.revision, at: AT, blockId: FAKE_BLOCK_ID } }]);
    expect(model.calls.map(call => call.kind === "judge" ? `judge:${call.blockId}` : call.kind)).toEqual(["router", `judge:${FAKE_BLOCK_ID}`, "counter"]);
    const qualification = { requests: rows, identity: CONFIRMED, crmContext: "complete" as const, teamSignals: [] };
    expect(decideCaseAdmission({ policy: APPROVED, qualification, caseSensitivity: "none" })).toMatchObject({ target: "agent", reasons: ["admitted"] });
    // A policy that does not list this rule at this revision admits nobody.
    const withoutDemo = POLICY([{ ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION, families: ["access"] }]);
    expect(decideCaseAdmission({ policy: withoutDemo, qualification, caseSensitivity: "none" }).target).not.toBe("agent");
    // Stored once, encrypted, bound to the package; a second reading (even the re-evaluation's, which never pays) reads it without any call.
    const stored = (await rowsLike(`${SAV_ENTRY_SKILL_STORE_PREFIX}:first_mail:${m.messageId}:`));
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0])).not.toContain("imprimer");
    expect(decryptSavPayload<{ catalog: string[] }>(stored[0]!.cursor!).catalog).toEqual(["access", FAKE_BLOCK_ID]);
    expect(await evidence(env(ON), m, model.network, { accessSkillCompute: "never" })).toEqual(rows);
    expect(model.calls).toHaveLength(3);
    expect(logged(infos, "sav_v2_entry_skill")).toContainEqual(expect.objectContaining({ mode: "on", entry: "admit", routes: FAKE_BLOCK_ID }));
  });
  it("un mail Accès est confirmé par le juge SAV-97 d'Accès (même clé de stockage), admis sous la règle d'Accès inchangée", async () => {
    const model = entrySkillModelDouble(honest), m = await mail(LOGIN);
    expect(admittedBy(await evidence(env(ON), m, model.network))).toEqual([`${SAV_ACCESS_SKILL_RULE_ID}@${SAV_ACCESS_SKILL_REVISION}`]);
    expect(model.calls.map(call => call.kind)).toEqual(["router", "access_judge", "counter"]);
    expect(await f.db.select().from(savSyncState).where(eq(savSyncState.key, accessSkillStoreKey("first_mail", m.messageId)))).toHaveLength(1);
  });
  it("sensible au routeur, phrase du noyau, texte tronqué : tout le mail à l'équipe", async () => {
    const sensitive = entrySkillModelDouble(call => call.kind === "router" ? { output: routerSays((call.payload.requests ?? []).map(row => [row.requestId, "sensitive"])) } : honest(call));
    expect(await evidence(env(ON), await mail(EXPORT), sensitive.network)).toEqual([]);
    expect(sensitive.calls.map(call => call.kind)).toEqual(["router"]);
    const model = entrySkillModelDouble(honest);
    expect(await evidence(env(ON), await mail(`${EXPORT}\nPS : je veux résilier mon abonnement.`), model.network)).toEqual([]);
    expect(await evidence(env(ON), await mail(`${EXPORT}\n${"Historique cité. ".repeat(800)}`), model.network)).toEqual([]);
    expect(model.calls).toEqual([]);
  });
  it("un bloc sans périmètre valide pour la politique en vigueur n'admet personne", async () => {
    const model = entrySkillModelDouble(honest), e = { ...env(ON), [SAV_V2_BLOCK_SCOPES_ENV]: "[]" };
    expect(await evidence(e, await mail(EXPORT), model.network)).toEqual([]);
  });
  it("mail mixte Accès + bloc : chaque demande à son bloc (SAV-92), modes des deux blocs lus ; un bloc plus strict devient une part de l'équipe", async () => {
    const text = `Bonjour, ${LOGIN_QUOTE}. Et ${EXPORT_QUOTE} ?`;
    for (const [modes, expected] of [
      [{ access: "auto", [FAKE_BLOCK_ID]: "auto" }, [`${SAV_ACCESS_SKILL_RULE_ID}@${SAV_ACCESS_SKILL_REVISION}`, `${DEMO.ruleId}@${DEMO.revision}#${FAKE_BLOCK_ID}`]],
      [{ access: "auto", [FAKE_BLOCK_ID]: "draft" }, [`${SAV_ACCESS_SKILL_RULE_ID}@${SAV_ACCESS_SKILL_REVISION}`, "team_part:block_switch_restricted"]],
    ] as const) {
      const model = entrySkillModelDouble(honest), m = await mail(text);
      const requests = [{ requestId: `${m.gmail}/r1`, kind: "support" }, { requestId: `${m.gmail}/r2`, kind: "support" }];
      const quotes = new Map([[requests[0]!.requestId, LOGIN_QUOTE], [requests[1]!.requestId, EXPORT_QUOTE]]);
      const rows = await evidence(env(ON), m, model.network, { readQuotes: async () => quotes, blockMode: async blockId => (modes as Record<string, "auto" | "draft">)[blockId]! }, requests);
      expect(admittedBy(rows)).toEqual(expected);
      expect(model.calls.map(call => call.kind)).toEqual(["router", "access_judge", "counter", "judge", "counter"]);
    }
  });
  it("une seconde lecture ne paie jamais deux fois ; une panne du routeur laisse le mail à l'équipe", async () => {
    const down = entrySkillModelDouble(call => call.kind === "router" ? { http: 500 } : honest(call)), m = await mail(EXPORT);
    expect(await evidence(env(ON), m, down.network)).toEqual([]);
    expect(await evidence(env(ON), m, down.network)).toEqual([]);
    expect(down.calls.map(call => call.kind)).toEqual(["router"]);
  });
});

describe("shadow : calculé, stocké, comparé, jamais décisif", () => {
  const SHADOW = { [FAKE_BLOCK_ID]: "shadow" };
  it("Accès décide ; l'entrée à deux étages est calculée au relais, le désaccord est stocké et journalisé (codes fermés)", async () => {
    const model = entrySkillModelDouble(honest), m = await mail(EXPORT);
    expect(await evidence(env(SHADOW), m, model.network)).toEqual([]);
    // Access's own path first (its judge says « no Access request »), then the shadow: router, the fake block's skill, the counter-read.
    expect(model.calls.map(call => call.kind)).toEqual(["access_judge", "router", "judge", "counter"]);
    const [row] = await rowsLike(`${SAV_ENTRY_SKILL_SHADOW_PREFIX}:first_mail:${m.messageId}:`);
    expect(decryptSavPayload(row!.cursor!)).toMatchObject({ actual: "r1=team", shadow: `r1=${FAKE_BLOCK_ID}`, disagree: true });
    const shadow = logged(infos, "sav_v2_entry_skill_shadow");
    expect(shadow).toEqual([expect.objectContaining({ actual: "r1=team", shadow: `r1=${FAKE_BLOCK_ID}`, disagree: true, entry: "admit" })]);
    expect(JSON.stringify(shadow)).not.toMatch(/imprimer|planning/);
  });
  it("un mail Accès : accord, rien ne change ; à la création (bail V1) le shadow ne paie rien", async () => {
    const model = entrySkillModelDouble(honest), m = await mail(LOGIN);
    expect(admittedBy(await evidence(env(SHADOW), m, model.network))).toEqual([`${SAV_ACCESS_SKILL_RULE_ID}@${SAV_ACCESS_SKILL_REVISION}`]);
    expect(logged(infos, "sav_v2_entry_skill_shadow")).toEqual([expect.objectContaining({ actual: "r1=access", shadow: "r1=access", disagree: false })]);
    // The shadow reused Access's stored reading: Access's judge and counter were paid once.
    expect(model.calls.map(call => call.kind)).toEqual(["access_judge", "counter", "router"]);
    const lease = entrySkillModelDouble(honest), m2 = await mail(EXPORT);
    expect(await evidence(env(SHADOW), m2, lease.network, { accessSkillCompute: "on_only" })).toEqual([]);
    expect(lease.calls.map(call => call.kind)).toEqual(["access_judge"]);
  });
  it("une panne du shadow ne change rien à l'admission réelle", async () => {
    const model = entrySkillModelDouble(call => call.kind === "router" ? { lost: true } : honest(call)), m = await mail(LOGIN);
    expect(admittedBy(await evidence(env(SHADOW), m, model.network))).toEqual([`${SAV_ACCESS_SKILL_RULE_ID}@${SAV_ACCESS_SKILL_REVISION}`]);
  });
});
