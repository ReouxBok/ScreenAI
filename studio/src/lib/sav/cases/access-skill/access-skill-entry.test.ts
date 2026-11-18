import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
import { accessSkillModelDouble, ACCESS_SKILL_TEST_PROVIDER_ENV, counterSays, judgeSays, type AccessSkillDoubleAnswer, type AccessSkillDoubleCall } from "../../../../../test/sav-access-skill-double";
import { savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savSyncState, savThreads, staffUsers, savIntakeEffects } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { decryptSavPayload, encryptSavPayload } from "../../crypto";
import { intakeRuntimeHash } from "../../intake/runtime-contract";
import { decideCaseAdmission } from "../admission-policy";
import type { CaseEntryRule } from "../case-blocks";
import { SAV_CASE_BLOCK_REGISTRY } from "../case-block-registry";
import { readCase } from "../case-store";
import type { CaseAdmissionQualification } from "../case-types";
import { recordCaseAfterConfirmedIntake } from "../intake-boundary";
import { caseInvestigationPrompt, caseInvestigationPromptRevision, SAV_CASE_ACCESS_SKILL_DECISION_INSTRUCTION } from "../investigation-v2-providers";
import type { CaseInvestigationModelRequest } from "../investigation-runner";
import { firstBlockEvidence, v2EntryPolicySources, type CaseEntrySource } from "../v2-entry";
import { SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID } from "./access-skill-guidelines";
import { accessSkillStoreKey, type AccessSkillStored } from "./access-skill-judge";
import { accessSkillReturnRule, caseReturnRulesForAccessSkill } from "./access-skill-return";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * SAV-97 wiring, on the real stores (PGlite), with the model doubled at the network boundary only: the real entry (`firstBlockEvidence`, the relay's
 * and the re-evaluation's rule ports, the creation's), the real wire, key resolution, transport bounds, V2 spend gate, store and pure rule. SYN data only.
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "", seq = 9_700_000;
const AT = "2026-11-18T09:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000097", V2_OWNER = "90000097";
const LEGACY: CaseEntryRule = { ruleId: "rule-access", revision: "r1", v1Kind: "support", family: "access", at: AT };
const SKILL: CaseEntryRule = { ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION, v1Kind: "support", family: "access", at: AT };
const NOTICE = { SAV_HANDOFF_NOTICE: "on", SAV_HANDOFF_SLACK_BOT_TOKEN: "xoxb-synthetic-0000000000", SAV_HANDOFF_SLACK_CHANNEL_ID: "C0SYNTHETIC0" };
const env = (mode: "off" | "shadow" | "on" | null, rules: CaseEntryRule[] = [LEGACY, SKILL]) =>
  ({ ...ACCESS_SKILL_TEST_PROVIDER_ENV, ...NOTICE, SAV_V2_ADMISSION_RULES_JSON: JSON.stringify(rules), ...(mode ? { SAV_V2_ACCESS_SKILL: mode } : {}) }) as Record<string, string>;
const POLICY = (rules: Array<{ ruleId: string; revision: string }>) => ({ revision: "policy-97", admittedFamilies: ["access"], qualifiedRules: rules.map(rule => ({ ...rule, families: ["access"] })), approvedBy: STAFF, approvedAt: AT });
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-97" } };

const CAPCAR = "Bonjour, j'ai fait le mandat de prélèvement pour un forfait Business Plus mais quand je veux me connecter on me demande de choisir un abonnement. Pourquoi ?";
const CAPCAR_QUOTE = "quand je veux me connecter on me demande de choisir un abonnement";
const PLAIN = "Bonjour, je ne reçois pas le code de connexion depuis ce matin. Merci";
const PLAIN_QUOTE = "je ne reçois pas le code de connexion";
const PS_CANCEL = "Bonjour, je ne reçois pas le code de connexion.\n\nCordialement,\nClaire\n\nPS : par contre je veux résilier à la fin du mois.";

/** The honest synthetic model: capcar and plain login are Access; a counter-read says « no » unless told otherwise. */
const honest = (counter: "yes" | "no" | "unsure" = "no") => (call: AccessSkillDoubleCall): AccessSkillDoubleAnswer => {
  if (call.kind === "counter") return { output: counterSays(counter) };
  const requestId = call.payload.requests?.[0]?.requestId ?? "r1";
  if (call.payload.text.includes("mandat de prélèvement")) return { output: judgeSays("access", CAPCAR_QUOTE, { requestId, sensitive: "context_only",
    mentions: [{ quote: "mandat de prélèvement", family: "finance", role: "context" }, { quote: "choisir un abonnement", family: "subscription", role: "context" }] }) };
  return { output: judgeSays("access", PLAIN_QUOTE, { requestId }) };
};

async function mail(text: string, subject = "Connexion") {
  const threadId = randomUUID(), messageId = randomUUID(), gmail = `gm-${messageId}`;
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject, customerEmail: "client@example.invalid" });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"], subject,
    bodyCiphertext: encryptSavPayload({ text }), receivedAt: new Date(AT), gmailMessageId: gmail });
  return { messageId, gmail, threadId, single: [{ requestId: `${gmail}/r1`, kind: "support" }] };
}
const evidence = (e: Record<string, string>, m: Awaited<ReturnType<typeof mail>>, network: ReturnType<typeof accessSkillModelDouble>["network"] | null,
  source: CaseEntrySource = {}, requests = m.single) =>
  firstBlockEvidence(e, m.messageId, m.gmail, requests, SAV_CASE_BLOCK_REGISTRY, { accessSkillCompute: "always", ...source,
    accessSkillDeps: { network: network ?? (async () => { throw Error("NETWORK_FORBIDDEN"); }), ...source.accessSkillDeps } });
const stored = async (messageId: string, purpose: "first_mail" | "return" = "first_mail") => {
  const [row] = await f.db.select().from(savSyncState).where(eq(savSyncState.key, accessSkillStoreKey(purpose, messageId)));
  return row ? { status: row.status, value: row.cursor ? decryptSavPayload<AccessSkillStored>(row.cursor) : null } : null;
};
const skillRows = async () => (await f.db.select().from(savSyncState).where(like(savSyncState.key, "sav-v2-access-skill.v1:%"))).length;
const spendDone = async () => {
  const rows = await f.db.select().from(savSyncState).where(like(savSyncState.key, "sav-v2-spend.v1:model:%"));
  return rows.flatMap(row => Object.keys((JSON.parse(row.cursor ?? "{}") as { done?: Record<string, number> }).done ?? {}));
};
const admittedBy = (rows: CaseAdmissionQualification["requests"]) => rows.map(row => row.provenance.kind === "qualified_rule" ? `${row.provenance.ruleId}@${row.provenance.revision}` : row.provenance.kind);
let infos: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "access-skill-entry-fixture-key-32chars!");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-skill-admin", email: "skill-admin@example.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "access-skill-entry-fixture-key-32chars!"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("GLOBAL_NETWORK_FORBIDDEN"); }));
  infos = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("off (défaut) : la production d'aujourd'hui, à l'identique", () => {
  it("mêmes admissions avec ou sans la règle du skill configurée ; aucun appel modèle, aucune ligne écrite", async () => {
    const before = await skillRows();
    for (const mode of [null, "off", "OFF", "true"] as const) {
      const plain = await mail(PLAIN), capcar = await mail(CAPCAR), cancel = await mail(PS_CANCEL);
      const e = mode === "OFF" || mode === "true" ? { ...env(null), SAV_V2_ACCESS_SKILL: mode } : env(mode as "off" | null);
      for (const rules of [[LEGACY], [LEGACY, SKILL]]) {
        const ee = { ...e, SAV_V2_ADMISSION_RULES_JSON: JSON.stringify(rules) };
        expect(admittedBy(await evidence(ee, plain, null))).toEqual(["rule-access@r1"]);
        expect(await evidence(ee, capcar, null)).toEqual([]); // the detector refuses capcar today (« prélèvement », « abonnement »)
        expect(await evidence(ee, cancel, null)).toEqual([]);
      }
    }
    expect(await skillRows()).toBe(before);
  });
  it("le prompt de décision et sa révision ne changent pas (off et shadow)", () => {
    const request = { purpose: "decision", snapshot: { version: 1, body: { openRequests: [], facts: [], questions: [], trials: [] } }, knowledge: [], coverage: null, feedback: [], closure: [] } as unknown as CaseInvestigationModelRequest;
    const base = caseInvestigationPrompt(request);
    expect(base.instruction).not.toContain(SAV_CASE_ACCESS_SKILL_DECISION_INSTRUCTION);
    expect(caseInvestigationPromptRevision(false, {})).toBe(caseInvestigationPromptRevision(false, { SAV_V2_ACCESS_SKILL: "off" }));
    expect(caseInvestigationPromptRevision(false, { SAV_V2_ACCESS_SKILL: "shadow" })).toBe(caseInvestigationPromptRevision(false, {}));
    expect(caseInvestigationPromptRevision(false, { SAV_V2_ACCESS_SKILL: "on" })).toBe(`${caseInvestigationPromptRevision(false, {})}+askill1`);
    expect(caseInvestigationPrompt(request, { accessSkill: true }).instruction).toContain(SAV_CASE_ACCESS_SKILL_DECISION_INSTRUCTION);
    expect(caseInvestigationPrompt({ ...request, purpose: "resolution_check" } as CaseInvestigationModelRequest, { accessSkill: true }).instruction).not.toContain(SAV_CASE_ACCESS_SKILL_DECISION_INSTRUCTION);
  });
  it("le retour client garde exactement la règle existante (ou aucune)", () => {
    const legacy = vi.fn(async () => []);
    expect(caseReturnRulesForAccessSkill(() => ({}), () => new Date(), legacy)).toBe(legacy);
    expect(caseReturnRulesForAccessSkill(() => ({ SAV_V2_ACCESS_SKILL: "off" }), () => new Date(), undefined)).toBeUndefined();
  });
});

describe("shadow : calculé, stocké, comparé dans les journaux, jamais décisif", () => {
  it("les détecteurs décident ; le skill est payé une fois au relais et le désaccord capcar est journalisé", async () => {
    const model = accessSkillModelDouble(honest());
    const plain = await mail(PLAIN), capcar = await mail(CAPCAR);
    expect(admittedBy(await evidence(env("shadow"), plain, model.network))).toEqual(["rule-access@r1"]);
    expect(await evidence(env("shadow"), capcar, model.network)).toEqual([]);
    expect(model.calls.map(call => call.kind)).toEqual(["judge", "counter", "judge", "counter"]);
    expect((await stored(capcar.messageId))?.status).toBe("done");
    const shadow = infos.mock.calls.filter((call: unknown[]) => call[0] === "sav_v2_access_skill_shadow").map((call: unknown[]) => call[1]);
    expect(shadow).toEqual([expect.objectContaining({ detectors: "admit", skill: "admit", disagree: false }), expect.objectContaining({ detectors: "team", skill: "admit", disagree: true, counterRead: "no" })]);
    // No customer text in the log.
    expect(JSON.stringify(shadow)).not.toMatch(/prélèvement|code de connexion/);
  });
  it("à la création (bail V1) le shadow ne paie rien ; une panne du modèle ne change rien", async () => {
    const model = accessSkillModelDouble(() => ({ http: 500 }));
    const plain = await mail(PLAIN);
    expect(admittedBy(await evidence(env("shadow"), plain, model.network, { accessSkillCompute: "on_only" }))).toEqual(["rule-access@r1"]);
    expect(model.calls).toEqual([]);
    expect(admittedBy(await evidence(env("shadow"), plain, model.network))).toEqual(["rule-access@r1"]);
    expect(model.calls).toHaveLength(1);
  });
});

describe("on : le skill décide l'Accès", () => {
  it("capcar est admis, preuve qualified_rule access-entry-skill à cette révision ; juge puis contre-lecture, payés une fois", async () => {
    const model = accessSkillModelDouble(honest());
    const capcar = await mail(CAPCAR);
    const rows = await evidence(env("on"), capcar, model.network);
    expect(rows).toEqual([{ requestId: capcar.single[0]!.requestId, family: "access", provenance: { kind: "qualified_rule", ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION, at: AT } }]);
    expect(model.calls.map(call => call.kind)).toEqual(["judge", "counter"]);
    // Paid through V2's model budget, once per call.
    const done = await spendDone();
    expect(done).toEqual(expect.arrayContaining([`access-skill:first_mail:${capcar.messageId}:${SAV_ACCESS_SKILL_REVISION}:judge`, `access-skill:first_mail:${capcar.messageId}:${SAV_ACCESS_SKILL_REVISION}:counter`]));
    // The policy that approves this rule and revision admits; one that does not, admits nobody.
    const qualification = { requests: rows, identity: CONFIRMED, crmContext: "complete" as const, teamSignals: [] };
    expect(decideCaseAdmission({ policy: POLICY([{ ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION }]), qualification, caseSensitivity: "none" })).toMatchObject({ target: "agent", reasons: ["admitted"] });
    expect(decideCaseAdmission({ policy: POLICY([{ ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: "sav-access-entry-skill-older.v0" }]), qualification, caseSensitivity: "none" }).reasons).toContain("qualification_unproven");
    expect(decideCaseAdmission({ policy: POLICY([{ ruleId: "rule-access", revision: "r1" }]), qualification, caseSensitivity: "none" }).reasons).toContain("qualification_unproven");
  });
  it("calcul si absent puis relecture sans payer ; la réévaluation (never) ne paie jamais, l'absent n'admet personne", async () => {
    const model = accessSkillModelDouble(honest());
    const capcar = await mail(CAPCAR), other = await mail(PLAIN);
    const first = await evidence(env("on"), capcar, model.network);
    const again = await evidence(env("on"), capcar, model.network);
    const reread = await evidence(env("on"), capcar, model.network, { accessSkillCompute: "never" });
    expect(again).toEqual(first); expect(reread).toEqual(first);
    expect(model.calls).toHaveLength(2);
    expect(await evidence(env("on"), other, model.network, { accessSkillCompute: "never" })).toEqual([]);
    expect(await stored(other.messageId)).toBeNull();
    expect(model.calls).toHaveLength(2);
  });
  it("les ports réels : le relais (et SAV-96, qui passe par lui) calcule ; la réévaluation relit ; la création ne calcule qu'en on", async () => {
    const model = accessSkillModelDouble(honest());
    const capcar = await mail(CAPCAR), e = env("on");
    const context = { source: { messageId: capcar.messageId, gmailMessageId: capcar.gmail, runId: null, runVersion: null } } as never;
    // The ports build their own deps (real fetch): the global network double answers like the model.
    vi.stubGlobal("fetch", model.network);
    expect(await v2EntryPolicySources(e, { accessSkillCompute: "never" }).approvedRules({ context, requests: capcar.single })).toEqual([]);
    expect(model.calls).toHaveLength(0);
    const relayed = await v2EntryPolicySources(e).approvedRules({ context, requests: capcar.single });
    expect(admittedBy(relayed)).toEqual([`${SAV_ACCESS_SKILL_RULE_ID}@${SAV_ACCESS_SKILL_REVISION}`]);
    expect(await v2EntryPolicySources(e, { accessSkillCompute: "never" }).approvedRules({ context, requests: capcar.single })).toEqual(relayed);
    expect(model.calls).toHaveLength(2);
    // SAV-96's owner handover relays through `v2EntryRelayDeps`, whose rule port is this relay port (compute allowed); the binding's re-evaluation reads only.
    const dir = path.dirname(fileURLToPath(import.meta.url));
    expect(readFileSync(path.join(dir, "../owner-handover.ts"), "utf8")).toContain("...v2EntryRelayDeps(env),");
    expect(readFileSync(path.join(dir, "../v2-entry-binding.ts"), "utf8")).toContain('v2EntryPolicySources(env, { accessSkillCompute: "never" })');
    expect(readFileSync(path.join(dir, "../v2-entry.ts"), "utf8")).toContain('{ run: { runId: null, runVersion: null }, accessSkillCompute: "on_only" }');
  });
  it("révision non approuvée dans les règles : personne n'est admis, rien n'est payé ; le détecteur n'est jamais utilisé en on", async () => {
    const model = accessSkillModelDouble(honest());
    const plain = await mail(PLAIN);
    expect(await evidence(env("on", [LEGACY, { ...SKILL, revision: "sav-access-entry-skill-older.v0" }]), plain, model.network)).toEqual([]);
    expect(await evidence(env("on", [LEGACY]), plain, model.network)).toEqual([]);
    expect(model.calls).toEqual([]);
  });
  it("une résiliation cachée dans un PS : l'équipe, sans aucun appel modèle (noyau)", async () => {
    const model = accessSkillModelDouble(honest());
    const cancel = await mail(PS_CANCEL);
    expect(await evidence(env("on"), cancel, model.network)).toEqual([]);
    expect(model.calls).toEqual([]);
    expect((await stored(cancel.messageId))?.value).toMatchObject({ judge: { status: "skipped", problem: "kernel_phrase" }, counter: null });
  });
  it("le modèle se trompe (« accès ») sur une demande de changement d'offre : la contre-lecture « oui » garde le mail pour l'équipe", async () => {
    const text = "Bonjour, je n'arrive pas à me connecter et je voudrais passer au forfait supérieur.";
    const model = accessSkillModelDouble(call => call.kind === "counter" ? { output: counterSays("yes") } : { output: judgeSays("access", "je n'arrive pas à me connecter", { requestId: call.payload.requests![0]!.requestId }) });
    expect(await evidence(env("on"), await mail(text), model.network)).toEqual([]);
    expect(model.calls.map(call => call.kind)).toEqual(["judge", "counter"]);
  });
  it.each<[string, AccessSkillDoubleAnswer]>([
    ["HTTP 500", { http: 500 }], ["HTTP 400", { http: 400 }], ["connexion perdue (délai)", { lost: true }], ["enveloppe invalide", { raw: { nope: true } }],
    ["sortie mal formée", { output: { verdict: "access" } }], ["citation inventée", { output: judgeSays("access", "je veux me connecter tout de suite") }],
    ["incertain", { output: judgeSays("unsure", PLAIN_QUOTE) }], ["confiance moyenne", { output: judgeSays("access", PLAIN_QUOTE, { confidence: "medium" }) }],
  ])("%s → l'équipe, et jamais une seconde dépense", async (_name, answer) => {
    const model = accessSkillModelDouble(() => answer);
    const plain = await mail(PLAIN);
    expect(await evidence(env("on"), plain, model.network)).toEqual([]);
    expect(await evidence(env("on"), plain, model.network)).toEqual([]);
    expect(model.calls).toHaveLength(1);
  });
  it("sans budget V2 (politique absente) : rien n'est envoyé, l'équipe", async () => {
    const model = accessSkillModelDouble(honest());
    const e = { ...env("on") }; delete e.SAV_V2_SPEND_POLICY_JSON;
    expect(await evidence(e, await mail(PLAIN), model.network)).toEqual([]);
    expect(model.calls).toEqual([]);
  });
  it("deux demandes : accès + autre sujet = part de l'équipe ; accès + demande sensible = tout le mail à l'équipe", async () => {
    const text = "Bonjour, je ne reçois pas le code de connexion. Et comment configurer un agent ? Merci";
    const m = await mail(text), requests = [{ requestId: `${m.gmail}/r1`, kind: "support" }, { requestId: `${m.gmail}/r2`, kind: "support" }];
    const quotes = new Map([[requests[0]!.requestId, "je ne reçois pas le code de connexion"], [requests[1]!.requestId, "comment configurer un agent"]]);
    const two = (second: "other" | "sensitive") => accessSkillModelDouble(call => call.kind === "counter" ? { output: counterSays("no") } : { output: {
      mail: { sensitive: second === "sensitive" ? "request" : "none", thirdParty: false, instructionLike: false },
      requests: [{ requestId: requests[0]!.requestId, verdict: "access", family: null, confidence: "high", quote: "je ne reçois pas le code de connexion", reason: "s" },
        { requestId: requests[1]!.requestId, verdict: second, family: second === "sensitive" ? "subscription" : null, confidence: "high", quote: "comment configurer un agent", reason: "s" }],
      sensitiveMentions: [] } });
    const ok = two("other");
    const rows = await evidence(env("on"), m, ok.network, { readQuotes: async () => quotes }, requests);
    expect(rows).toEqual([expect.objectContaining({ requestId: requests[0]!.requestId, family: "access", provenance: expect.objectContaining({ ruleId: SAV_ACCESS_SKILL_RULE_ID }) }),
      expect.objectContaining({ requestId: requests[1]!.requestId, provenance: expect.objectContaining({ kind: "team_part", reason: "no_block_match" }) })]);
    expect(ok.calls.map(call => call.kind)).toEqual(["judge", "counter"]);
    expect(ok.calls[0]!.payload.requests).toEqual([{ requestId: requests[0]!.requestId, kind: "support", words: "je ne reçois pas le code de connexion" }, { requestId: requests[1]!.requestId, kind: "support", words: "comment configurer un agent" }]);
    const m2 = await mail(text), requests2 = requests.map(row => ({ ...row, requestId: row.requestId.replace(m.gmail, m2.gmail) }));
    const sensitive = two("sensitive");
    expect(await evidence(env("on"), m2, sensitive.network, { readQuotes: async () => quotes }, requests2)).toEqual([]);
    // V1's finance or cancellation request keeps the whole mail with the team before any call.
    const v1 = accessSkillModelDouble(honest());
    expect(await evidence(env("on"), await mail(PLAIN), v1.network, {}, [{ requestId: "x/r1", kind: "support" }, { requestId: "x/r2", kind: "finance" }])).toEqual([]);
    expect(v1.calls).toEqual([]);
  });
});

describe("retour client requalifié par le même skill (on)", () => {
  const port = (text: string, families: Array<"access" | "finance"> = ["access"]) => ({ caseId: randomUUID(), messageId: randomUUID(), text, requests: families.map((family, index) => ({ requestId: `r${index + 1}`, family })) });
  const rule = (network: ReturnType<typeof accessSkillModelDouble>["network"], rules = [LEGACY, SKILL]) =>
    accessSkillReturnRule({ env: () => env("on", rules), now: () => new Date("2026-11-18T10:00:00.000Z"), deps: { network } });
  it("toujours le même écran d'abonnement à la connexion : reste accès (qualified_rule du skill, daté après le mail)", async () => {
    const text = "J'ai essayé avec mon autre adresse, toujours l'écran qui me demande de choisir un abonnement à la connexion.";
    const model = accessSkillModelDouble(call => call.kind === "counter" ? { output: counterSays("no") } : { output: judgeSays("access", "toujours l'écran qui me demande de choisir un abonnement", { sensitive: "context_only" }) });
    expect(await rule(model.network)(port(text))).toEqual([{ requestId: "r1", family: "access", provenance: { kind: "qualified_rule", ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION, at: "2026-11-18T10:00:00.000Z" } }]);
    expect(model.calls[0]!.payload.purpose).toBe("return");
  });
  it("« c'est bon, par contre remboursez-moi » : retiré vers l'équipe (famille sensible), sans appel ; incertain : aucune règle", async () => {
    const none = accessSkillModelDouble(honest());
    expect(await rule(none.network)(port("C'est bon je suis connecté. Par contre remboursez-moi le mois."))).toEqual([expect.objectContaining({ requestId: "r1", family: "finance" })]);
    expect(none.calls).toEqual([]);
    const unsure = accessSkillModelDouble(() => ({ output: judgeSays("unsure", "toujours pareil") }));
    expect(await rule(unsure.network)(port("toujours pareil"))).toEqual([]);
    const sensitive = accessSkillModelDouble(() => ({ output: judgeSays("sensitive", "passer à l'offre annuelle", { family: "subscription" }) }));
    expect(await rule(sensitive.network)(port("Merci, et je veux passer à l'offre annuelle."))).toEqual([expect.objectContaining({ family: "subscription" })]);
  });
  it("sans la règle du skill à cette révision : aucune réponse, rien n'est payé", async () => {
    const model = accessSkillModelDouble(honest());
    expect(await rule(model.network, [LEGACY])(port("toujours pas de code"))).toEqual([]);
    expect(model.calls).toEqual([]);
  });
});

describe("capcar de bout en bout, relais réel (A) : off → équipe ; on → dossier V2", () => {
  /** V1 as its executor leaves a confirmed single-request ticket (as in case-multi-request.test.ts), then A's relay with the entry's real reading. */
  async function relay(mode: "off" | "on", network: ReturnType<typeof accessSkillModelDouble>["network"]) {
    const m = await mail(CAPCAR), ticketId = String(++seq), e = env(mode);
    const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId: m.messageId, threadId: m.threadId, runVersion: 1, policyId, policyHash: "fixture", state: "confirmed", ticketId,
      payloadCiphertext: encryptSavPayload({ plan: { decision: { classification: "support", requests: [{ id: "r1", kind: "support" }] } } }) }).returning();
    const [run] = await f.db.insert(savIntakeRuns).values({ threadId: m.threadId, messageId: m.messageId, version: 1, isCurrent: false, state: "observed", configHash: `skill-${m.messageId}`, policyHash: "fixture",
      payloadCiphertext: encryptSavPayload({ revision: "sav-intake-runtime-2026-10-21.v1", effects: "not_connected" }) }).returning();
    await f.db.update(savIntakeExecutions).set({ runId: run!.id, runVersion: 1 }).where(eq(savIntakeExecutions.id, execution!.id));
    const intent = { kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${m.messageId}:${ticketId}`, ticketId, sourceMessageId: m.messageId, expectedOwnerId: null, properties: { hubspot_owner_id: V2_OWNER } };
    await f.db.insert(savIntakeEffects).values({ businessKey: intent.key, executionId: execution!.id, kind: "owner_assign", permission: "assign_v2_owner", state: "confirmed",
      intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), confirmedAt: new Date(), dispatchedAt: new Date() });
    const readQualification = async (input: { messageId: string; gmailMessageId: string; requests: { requestId: string; kind: string }[] }): Promise<CaseAdmissionQualification> =>
      ({ requests: await firstBlockEvidence(e, input.messageId, input.gmailMessageId, input.requests, SAV_CASE_BLOCK_REGISTRY, { run: { runId: run!.id, runVersion: 1 }, accessSkillCompute: "always", accessSkillDeps: { network } }),
        identity: CONFIRMED, crmContext: "complete", teamSignals: [] });
    const relayed = await recordCaseAfterConfirmedIntake(m.messageId, { readProgress: async () => ({ state: "confirmed", ticketId, confirmed: true }),
      readAdmissionPolicy: async () => POLICY([{ ruleId: "rule-access", revision: "r1" }, { ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION }]),
      readQualification, env: { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" } }) as { caseId: string };
    return readCase(relayed.caseId);
  }
  it("off : le détecteur refuse (family_unknown), le dossier n'est pas à l'agent ; on : admis, propriétaire agent, preuve du skill", async () => {
    const off = await relay("off", accessSkillModelDouble(honest()).network);
    expect(off!.owner).not.toBe("agent");
    expect(off!.admission!.reasons).toContain("family_unknown");
    const model = accessSkillModelDouble(honest());
    const on = await relay("on", model.network);
    expect(on).toMatchObject({ owner: "agent", admission: { target: "agent", reasons: ["admitted"] } });
    expect(on!.admission!.qualification.requests).toEqual([expect.objectContaining({ family: "access", provenance: expect.objectContaining({ ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION }) })]);
    expect(model.calls.map(call => call.kind)).toEqual(["judge", "counter"]);
  });
});
