import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
import { savMailboxes, savThreads, savMessages, staffUsers, savIntakeExecutionPolicies, savIntakeExecutionBudget, savIntakeExecutions, savIntakeEffects, savIntakeOccupations, savIntakeRuns, savActions, savSyncState, auditLogs, savIntakeHumanEvents, savIntakeEffectJournal } from "@/db/schema";
const state = vi.hoisted(() => ({
    db: null as unknown, user: null as unknown, adapterDefaults: null as unknown
}));
// SAV-31: native reconciliations build their own adapters; route only those default builds to the synthetic provider.
vi.mock("./execution-adapters", async importOriginal => {
    const actual = await importOriginal<typeof import("./execution-adapters")>();
    return { ...actual, createIntakeExecutorAdapters: (deps?: Parameters<typeof actual.createIntakeExecutorAdapters>[0]) =>
        actual.createIntakeExecutorAdapters(deps ?? (state.adapterDefaults as Parameters<typeof actual.createIntakeExecutorAdapters>[0]) ?? undefined) };
});
vi.mock("@/db", () => ({
    requireDb: () => {
        if (!state.db)
            throw Error("NO_DB_ALLOWED");
        return state.db;
    }
}));
// Scheduling is covered by hubspot-transport.test.ts; keep business scenarios
// independent of real rate-limit waits without replacing readers or guards.
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
vi.mock("@clerk/nextjs/server", () => ({
    currentUser: async () => state.user
}));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { planSavIntake } from "./engine";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { savIntakeRuntimeConfig, intakeRuntimeHash, SAV_INTAKE_RUNTIME_REVISION } from "./runtime-contract";
import { executionPolicySchema, executionAdministrator, intakeExecutionConfig, approveIntakeExecutionPolicy, revokeIntakeExecutionPolicy, readIntakeExecutionAuthority, type ExecutionPolicy } from "./execution-policy";
import { enqueueSavIntakeMessage, claimSavIntakeRun, saveSavIntakeResult, catchupSavIntake, pendingSavIntakeRuns } from "./runtime-store";
import { createIntakeExecutorAdapters } from "./execution-adapters";
import { analyseSavIntakeRuntime } from "./runtime";
import { admitIntakeExecution, getExecutionEffects, occupationSchemaInstalled, releaseNeverDispatchedIntakeScopes, assertNoLegacyConflict, claimExecution, endExecutionPass, occupyKeys, finishVerifiedIdentityRecovery } from "./execution-store";
import { executeIntakePass, readIntakeExecutionProgress, reconcileIntakeEffectsReadOnly, reconcileIntakeExecutor, reconcileIntakeEffectCandidate, scanIntakeExecutionCandidates, pendingIntakeEffectRecoveries } from "./executor";
import { guardLegacyIntakeOccupation, withLegacyOccupationAction, markLegacyIntakeDispatch, releaseLegacyIntakeIfConfirmed } from "./legacy-occupation";
import type { ExecutionOptions, EffectIntent, EffectAck } from "./execution-types";
let f: Awaited<ReturnType<typeof createSavTestDb>>, p: ReturnType<typeof executionProvider>, options: ExecutionOptions, environment: Record<string, string | undefined>, messageId: string, threadId: string, mailboxId: string, runId: string, adminId: string;
const mutations: ExecutionPolicy["mutations"] = ["create_ticket", "link_ticket", "set_ticket_new", "append_ticket_note", "associate_email", "send_identity_template"];
const template = "SYNTHETIC exact template.\nSignature kept exactly.";
async function storedMessage(thread = threadId, at = new Date()) {
    return (await f.db.insert(savMessages).values({
        threadId: thread, mailboxId, direction: "inbound", gmailMessageId: randomUUID(), fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"], subject: "Synthetic connection failure", bodyCiphertext: encryptSavPayload({
            text: "The synthetic connection fails.", headers: {
                "message-id": "<incoming@example.invalid>"
            }, attachments: []
        }), receivedAt: at
    }).returning())[0];
}
async function observed(mid = messageId) {
    const runtime = options.runtime, id = (await enqueueSavIntakeMessage(mid, runtime))!, lease = (await claimSavIntakeRun(id, runtime))!;
    const crm = createSavIntakeHubspotReaders({
        network: p.network
    });
    const plan = await planSavIntake(lease.input, {
        ...crm, analyseMessage: async () => ({
            messageId: mid, requests: [{
                    id: "r1", kind: "support", currentMessageId: mid
                }], ticketSummary: {
                title: "Synthetic connection failure", description: "The synthetic connection fails.", requestIds: ["r1"]
            }
        }), assessIssues: async ({ tickets, requests }) => ({
            investigationComplete: true, tickets: tickets.map(({ ticket: t }) => ({
                ticketId: t.id, relation: "same", requestIds: requests.map(r => r.id), evidenceIds: ["current", `ticket-${t.id}`, `history-${t.id}`]
            }))
        })
    }, runtime.policy, {}, () => new Date());
    await saveSavIntakeResult(lease, runtime, {
        revision: SAV_INTAKE_RUNTIME_REVISION, effects: "not_connected", plan, input: lease.input
    }, "observed");
    return id;
}
async function admission() { runId = await observed(); const row = await admitIntakeExecution(runId, options); expect(row).not.toBeNull(); return row!; }
async function writePolicy(mutationsOverride = mutations) {
    options.policy = executionPolicySchema.parse({
        ...options.policy, mutations: mutationsOverride
    });
    options.config.policyHash = intakeRuntimeHash(options.policy);
    environment.SAV_INTAKE_EXECUTION_POLICY_SHA256 = options.config.policyHash;
    await f.db.update(savIntakeExecutionPolicies).set({
        policyHash: options.config.policyHash, payloadCiphertext: encryptSavPayload(options.policy)
    }).where(eq(savIntakeExecutionPolicies.id, options.config.policyId));
}
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 120000);
afterAll(async () => {
    if (f) {
        await f.client.exec("TRUNCATE sav.intake_identity_episodes,sav.intake_effect_journal,sav.intake_effects,sav.intake_occupations,sav.intake_executions,sav.intake_execution_policies CASCADE; UPDATE sav.intake_execution_budget SET admitted=0; DELETE FROM sav.sync_state WHERE key='sav-intake-execution-scan-v1'");
        await f.client.close();
    }
});
beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => { });
    vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters");
    await f.client.exec("TRUNCATE sav.intake_identity_episodes,sav.intake_effect_journal,sav.intake_effects,sav.intake_occupations,sav.intake_executions,sav.intake_execution_policies,sav.intake_model_calls,sav.mailboxes CASCADE; DELETE FROM public.staff_users; TRUNCATE public.audit_logs; UPDATE sav.intake_execution_budget SET admitted=0; DELETE FROM sav.sync_state WHERE key='sav-intake-execution-scan-v1'");
    await f.db.insert(savSyncState).values({
        key: "sav-intake-execution-schema-v1", status: "installed"
    }).onConflictDoNothing();
    const [admin] = await f.db.insert(staffUsers).values({
        clerkId: "synthetic-admin", email: "ugo@limova.ai", name: "Synthetic Admin", role: "admin", active: true
    }).returning();
    adminId = admin.id;
    state.user = {
        id: admin.clerkId, primaryEmailAddress: {
            emailAddress: admin.email, verification: {
                status: "verified"
            }
        }
    };
    mailboxId = (await f.db.insert(savMailboxes).values({
        email: "support@example.invalid"
    }).returning())[0].id;
    threadId = (await f.db.insert(savThreads).values({
        mailboxId, gmailThreadId: "gmail-thread", customerEmail: "customer@example.invalid"
    }).returning())[0].id;
    messageId = (await storedMessage()).id;
    const ref = {
        resourceId: "synthetic-template", revisionId: "v1", sha256: createHash("sha256").update(template).digest("hex")
    };
    const catalogue = [{
            resource: ref, text: template, approvalId: "synthetic-approval", approvedBy: "synthetic-admin", approvedAt: new Date(Date.now() - 1000).toISOString(), status: "approved"
        }];
    const enginePolicy = {
        relationRevision: "synthetic-relations", admittedRelations: [{
                category: "HUBSPOT_DEFINED", typeId: 449
            }], resources: {
            identification: ref, registrationNotFound: ref
        }
    };
    environment = {
        SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake", HUBSPOT_ACCESS_TOKEN: "fake", SAV_ENCRYPTION_KEY_V1: process.env.SAV_ENCRYPTION_KEY_V1, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(enginePolicy), SAV_INTAKE_RUNTIME_RESOURCES: JSON.stringify(catalogue), SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({
            mailboxId, createdAfter: new Date(Date.now() - 10000).toISOString(), receivedAfter: new Date(Date.now() - 3600000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(enginePolicy), resourcesHash: intakeRuntimeHash(catalogue), maxCalls: 30, maxNanoUsd: 3000000000
        })
    };
    const runtime = savIntakeRuntimeConfig(environment)!;
    const policy: ExecutionPolicy = {
        revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: runtime.codeRevision, enginePolicyHash: runtime.policyHash, resourcesHash: runtime.resourcesHash, createdAfter: runtime.createdAfter, receivedAfter: runtime.receivedAfter, expiresAt: runtime.expiresAt, maxDossiers: 10, mutations, admission: {
            kind: "automatic"
        }
    };
    const grant = await approveIntakeExecutionPolicy(policy);
    environment = {
        ...environment, SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: grant.id, SAV_INTAKE_EXECUTION_POLICY_SHA256: grant.policyHash
    };
    p = executionProvider();
    p.setGmail((await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0].gmailMessageId!, "gmail-thread");
    options = {
        runtime, policy, config: intakeExecutionConfig(environment)!, env: () => environment, signal: AbortSignal.timeout(30000), adapters: createIntakeExecutorAdapters({
            network: p.network, gmailRequest: p.gmail, gmailPermissions: async () => { }, env: () => environment
        })
    };
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("OFF returns before DB/tables and does not consume malformed pins", async () => {
    const saved = state.db;
    state.db = null;
    try {
        expect(intakeExecutionConfig({
            SAV_INTAKE_EXECUTION_POLICY_ID: "bad"
        })).toBeNull();
        expect(await reconcileIntakeExecutor()).toEqual({
            skipped: "off"
        });
    }
    finally {
        state.db = saved;
    }
});
it("preserves OFF compatibility before schema0041", async () => {
    await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-intake-execution-schema-v1"));
    expect(await occupationSchemaInstalled()).toBe(false);
    const action = {
        id: randomUUID()
    } as Parameters<typeof guardLegacyIntakeOccupation>[0];
    await guardLegacyIntakeOccupation(action);
    await f.db.insert(savSyncState).values({
        key: "sav-intake-execution-schema-v1", status: "installed"
    });
});
it("session authorization never provisions or reactivates a revoked administrator", async () => {
    await f.db.update(staffUsers).set({
        active: false
    }).where(eq(staffUsers.id, adminId));
    await expect(executionAdministrator()).rejects.toThrow("UNAUTHORIZED");
    expect((await f.db.select().from(staffUsers))[0].active).toBe(false);
    await expect(readIntakeExecutionAuthority(options.config)).rejects.toThrow("PERMISSION_REVOKED");
});
it("creates, archives, associates and confirms with the real HTTP adapters, no owner assignment", async () => {
    const row = await admission();
    const result = await executeIntakePass(row.id, options);
    expect(result).toMatchObject({
        state: "confirmed"
    });
    expect((await getExecutionEffects(row.id)).map(e => e.state)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
    const create = p.calls.find(c => c.method === "POST" && c.path.endsWith("/tickets"))!.body as {
        properties: Record<string, string>;
    };
    expect(create.properties.source_type).toBe("EMAIL");
    expect(create.properties).not.toHaveProperty("hubspot_owner_id");
    expect(await readIntakeExecutionProgress(messageId)).toMatchObject({
        actorType: "ai", state: "confirmed", confirmed: true, learning: "not_started", followupStarted: false
    });
    expect(await f.db.select().from(savIntakeOccupations)).toHaveLength(0);
});
it("SAV-72 the created ticket description is the original incoming email, not the planner summary; marker kept", async () => {
    const text = "Bonjour,\n\nL'export échoue toujours après la mise à jour.\nJ'ai déjà vidé le cache.\n\nMerci d'avance,\nClaire Exemple\n\nLe 2 oct. 2026 à 09:00, Support <support@example.invalid> a écrit :\n> Pouvez-vous vider le cache ?";
    await f.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ text, headers: { "message-id": "<incoming@example.invalid>" }, attachments: [] }) }).where(eq(savMessages.id, messageId));
    const row = await admission();
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    const creates = p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"));
    expect(creates).toHaveLength(1);
    const marker = intakeRuntimeHash(`create:${messageId}`), content = (creates[0].body as { properties: Record<string, string> }).properties.content;
    expect(content).toBe(`Objet : Synthetic connection failure\n\nBonjour,\n\nL'export échoue toujours après la mise à jour.\nJ'ai déjà vidé le cache.\n\nMerci d'avance,\nClaire Exemple\n\n[Historique cité non recopié : il reste dans l'email associé au ticket.]\n\n[Studio intake: ${marker}]`);
    expect(content).not.toContain("The synthetic connection fails.");
    expect(content).not.toContain("Pouvez-vous vider le cache");
    // The created object read back by the provider carries exactly the posted description.
    expect(Object.values(p.objects.tickets).map(t => t.properties.content)).toContain(content);
    expect((await getExecutionEffects(row.id)).every(e => e.state === "confirmed")).toBe(true);
});
it.each(["open", "closed"] as const)("links/reopens %s with verified dependencies then stage-only PATCH preserving NULL owner", async (stage) => {
    p.seedTicket({
        stage, closedAt: stage === "closed" ? new Date(Date.now() - 1000).toISOString() : undefined
    });
    const row = await admission();
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "confirmed"
    });
    const patch = p.calls.filter(c => c.method === "PATCH");
    expect(patch).toHaveLength(1);
    expect(patch[0].body).toEqual({
        properties: {
            hs_pipeline_stage: "1"
        }
    });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(0);
    expect((await getExecutionEffects(row.id)).find(e => e.kind === "stage_new")?.state).toBe("confirmed");
});
it("requires root link authority before any auxiliary effect", async () => {
    p.seedTicket({
        stage: "new"
    });
    await writePolicy(mutations.filter(m => m !== "link_ticket"));
    const row = await admission();
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "waiting", reason: "SAV_INTAKE_EXECUTION_MUTATION_NOT_GRANTED"
    });
    expect(p.calls.filter(c => ["PUT", "PATCH"].includes(c.method) || c.method === "POST" && !c.path.endsWith("/search") && !c.path.endsWith("/read"))).toHaveLength(0);
    expect(await f.db.select().from(savIntakeOccupations)).toHaveLength(0);
});
it("preserves late ACK after revocation without dispatching a second effect", async () => {
    const row = await admission();
    const dispatch = options.adapters.dispatch;
    options.adapters.dispatch = async (...args) => {
        const result = await dispatch(...args);
        await f.db.update(staffUsers).set({
            active: false
        }).where(eq(staffUsers.id, adminId));
        return result;
    };
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "waiting", reason: "SAV_INTAKE_EXECUTION_PERMISSION_REVOKED"
    });
    const effects = await getExecutionEffects(row.id);
    expect(effects[0].state).toBe("confirmed");
    expect(decryptSavPayload<EffectAck>(effects[0].ackCiphertext!).id).toBeTruthy();
    expect(effects).toHaveLength(1);
});
it("lost create ACK reconciles read-only and never repeats POST", async () => {
    const row = await admission(), dispatch = options.adapters.dispatch;
    options.adapters.dispatch = async (...args) => { await dispatch(...args); throw Error("LOST_ACK"); };
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "uncertain"
    });
    await f.db.update(savIntakeEffects).set({
        nextReconcileAt: null
    }).where(eq(savIntakeEffects.executionId, row.id));
    await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
    expect((await getExecutionEffects(row.id))[0].state).toBe("confirmed");
    options.adapters.dispatch = dispatch;
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "confirmed"
    });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
});
it("crash after marker before POST stays uncertain with zero-match RO, no blind POST", async () => {
    const row = await admission();
    expect(await executeIntakePass(row.id, options, {
        afterMarker: async () => { throw Error("CRASH"); }
    })).toMatchObject({
        state: "uncertain"
    });
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "uncertain"
    });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(0);
    expect(await f.db.select().from(savIntakeOccupations)).not.toHaveLength(0);
});
// Choice rule (Ugo, 27/10): once an effect is confirmed, the remaining actions finish on the
// same target whatever the team changed; nothing is replayed and the change is traced.
it("human ticket changes after create confirmation no longer stop the continuation", async () => {
    const row = await admission(), verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "ticket_create" && proof.confirmed)
            p.objects.tickets[proof.ack!.id!].properties.content = "Human changed content";
        return proof;
    };
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
    expect((await f.db.select().from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId, row.id))).some(j => j.kind === "crm_change_ignored")).toBe(true);
});
it("a human closure after the set-New PATCH no longer stops finalization", async () => {
    p.seedTicket({
        stage: "open"
    });
    const row = await admission(), verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "stage_new")
            p.objects.tickets["201"].properties.hs_pipeline_stage = "4";
        return proof;
    };
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    expect(p.calls.filter(c => c.method === "PATCH")).toHaveLength(1);
});
it("required current Gmail callback cannot silently disappear", async () => {
    const row = await admission();
    delete (options.adapters as Partial<typeof options.adapters>).gmailCurrent;
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "waiting", reason: "SAV_INTAKE_EXECUTION_GMAIL_CONTROL_REQUIRED"
    });
    expect(await getExecutionEffects(row.id)).toHaveLength(0);
});
it("every unqualified direct association stops before creation", async () => {
    const row = await admission();
    p.links.set("contacts:101:contacts", ["102"]);
    options.runtime.policy.admittedRelations = [];
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "waiting", reason: "SAV_INTAKE_EXECUTION_ASSOCIATION_INCOMPLETE"
    });
    expect(await getExecutionEffects(row.id)).toHaveLength(0);
});
it("quota is lifetime shared across policy changes and refuses deleted history", async () => {
    options.policy.maxDossiers = 1;
    await writePolicy();
    const row = await admission();
    expect(await admitIntakeExecution(runId, options)).toMatchObject({
        id: row.id
    });
    await f.db.update(savIntakeExecutionBudget).set({
        admitted: 2
    });
    const m = await storedMessage(threadId, new Date());
    await observed(m.id);
    await expect(admitIntakeExecution((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.messageId, m.id)))[0].id, options)).rejects.toThrow("ADMISSION_LIMIT");
});
it("250 historical successes do not conceal a late active legacy action", async () => {
    await f.db.insert(savActions).values(Array.from({
        length: 250
    }, () => ({
        threadId, messageId, kind: "create_ticket" as const, status: "succeeded" as const, actorType: "human" as const, payload: {}, idempotencyKey: randomUUID()
    })));
    await f.db.transaction(tx => assertNoLegacyConflict(tx, [`thread:${threadId}`]));
    await f.db.insert(savActions).values({
        threadId, messageId, kind: "link_ticket", status: "running", actorType: "human", payload: {}, idempotencyKey: randomUUID()
    });
    await expect(f.db.transaction(tx => assertNoLegacyConflict(tx, [`thread:${threadId}`]))).rejects.toThrow("LEGACY_SCOPE_OCCUPIED");
});
it("new entrant before any dispatch releases scope; old run cannot resume", async () => {
    const row = await admission();
    const lease = (await claimExecution(row.id))!;
    await storedMessage(threadId, new Date());
    await endExecutionPass(lease, "waiting", "SAV_INTAKE_EXECUTION_CONTEXT_CHANGED");
    expect(await f.db.select().from(savIntakeOccupations)).toHaveLength(0);
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "waiting", reason: "SAV_INTAKE_EXECUTION_CONTEXT_CHANGED"
    });
});
it("new entrant after confirmed create hands off auditable receipt and links without another POST", async () => {
    const row = await admission();
    let newer: string | undefined;
    const verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "ticket_create") {
            const m = await storedMessage(threadId, new Date());
            newer = m.id;
            p.setGmail(m.gmailMessageId!, "gmail-thread");
        }
        return proof;
    };
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "waiting"
    });
    options.adapters.verify = verify;
    const nextRun = await observed(newer!), next = await admitIntakeExecution(nextRun, options);
    expect(next).toBeTruthy();
    expect(await executeIntakePass(next!.id, options)).toMatchObject({
        state: "confirmed"
    });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
    expect((await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, row.id)))[0].state).toBe("refused");
});
it("scoped occupation permits unrelated contact and rejects A-to-B/B-to-A overlap", async () => { const a = randomUUID(), b = randomUUID(); await f.db.transaction(tx => occupyKeys(tx, a, "intake", ["contact:101", "contact:102"])); await expect(f.db.transaction(tx => occupyKeys(tx, b, "legacy", ["contact:102", "contact:101"]))).rejects.toThrow("SCOPE_OCCUPIED"); await f.db.transaction(tx => occupyKeys(tx, b, "legacy", ["contact:103"])); });
it("identity template is verified through HTTP/full Gmail parser with exact MIME body", async () => {
    p.setContacts([]);
    const row = await admission();
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "confirmed"
    });
    expect(p.calls.filter(c => c.path === "gmail/messages/send")).toHaveLength(1);
    const effect = (await getExecutionEffects(row.id))[0], intent = decryptSavPayload<EffectIntent>(effect.intentCiphertext);
    expect(intent.text).toBe(template);
    expect(intent.raw).not.toContain("assistant IA");
    expect((await readIntakeExecutionProgress(messageId))!.learning).toBe("not_started");
});
it.each(["finance", "cancellation"] as const)("strict provider confirms %s fields and excludes learning", async (kind) => {
    const id = (await enqueueSavIntakeMessage(messageId, options.runtime))!, l = (await claimSavIntakeRun(id, options.runtime))!;
    const readers = createSavIntakeHubspotReaders({
        network: p.network
    });
    const plan = await planSavIntake(l.input, {
        ...readers, analyseMessage: async () => ({
            messageId, requests: [{
                    id: "r", kind, currentMessageId: messageId
                }], ticketSummary: {
                title: "Synthetic ticket request", description: "Synthetic complete description", requestIds: ["r"]
            }
        }), assessIssues: async () => ({
            investigationComplete: true, tickets: []
        })
    }, options.runtime.policy, {}, () => new Date());
    await saveSavIntakeResult(l, options.runtime, {
        revision: SAV_INTAKE_RUNTIME_REVISION, effects: "not_connected", plan, input: l.input
    }, "observed");
    const row = await admitIntakeExecution(id, options);
    expect(await executeIntakePass(row!.id, options)).toMatchObject({
        state: "confirmed"
    });
    expect(await readIntakeExecutionProgress(messageId)).toMatchObject({
        learning: "excluded"
    });
    expect(Object.values(p.objects.tickets)[0].properties.hs_ticket_category).toBeTruthy();
});
it.each(["owner", "history"])("human %s change on created ticket no longer blocks the remaining actions", async (change) => {
    const row = await admission(), verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "ticket_create") {
            const id = proof.ack!.id!;
            if (change === "owner")
                p.objects.tickets[id].properties.hubspot_owner_id = "999";
            else {
                p.objects.notes["777"] = {
                    id: "777", properties: {
                        hs_note_body: "Human note", hs_timestamp: new Date().toISOString()
                    }
                };
                p.links.set(`tickets:${id}:notes`, ["777"]);
            }
        }
        return proof;
    };
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
});
it("a changed historical body invalidates before first mutation", async () => {
    const older = await storedMessage(threadId, new Date(Date.now() - 1000)), row = await admission();
    await f.db.update(savMessages).set({
        bodyCiphertext: encryptSavPayload({
            text: "Changed historical address proof"
        })
    }).where(eq(savMessages.id, older.id));
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "waiting", reason: "SAV_INTAKE_EXECUTION_CONTEXT_CHANGED"
    });
    expect(await getExecutionEffects(row.id)).toHaveLength(0);
});
it("missing/denied Gmail send control prevents the exact template", async () => {
    p.setContacts([]);
    const row = await admission();
    options.adapters.gmailPermissions = async () => { throw Error("SAV_INTAKE_EXECUTION_GMAIL_PERMISSION_REQUIRED"); };
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "waiting", reason: "SAV_INTAKE_EXECUTION_GMAIL_PERMISSION_REQUIRED"
    });
    expect(p.calls.filter(c => c.path === "gmail/messages/send")).toHaveLength(0);
});
it.each(["wrong-body", "extra-to", "cc", "wrong-thread", "display-name"])("real MIME verifier treats %s conservatively", async (scenario) => {
    p.setContacts([]);
    const row = await admission();
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "confirmed"
    });
    const effect = (await getExecutionEffects(row.id))[0], intent = decryptSavPayload<EffectIntent>(effect.intentCiphertext), a = decryptSavPayload<EffectAck>(effect.ackCiphertext!);
    const sent = p.sent[a.id!] as {
        threadId: string;
        payload: {
            headers: {
                name: string;
                value: string;
            }[];
            body: {
                data: string;
            };
        };
    };
    if (scenario === "wrong-body")
        sent.payload.body.data = Buffer.from(template + " ").toString("base64url");
    if (scenario === "extra-to")
        sent.payload.headers.find(h => h.name === "To")!.value = sent.payload.headers.find(h => h.name === "To")!.value + ", " + intent.recipient;
    if (scenario === "cc")
        sent.payload.headers.push({
            name: "Cc", value: "extra@example.invalid"
        });
    if (scenario === "wrong-thread")
        sent.threadId = "another-thread";
    if (scenario === "display-name") {
        sent.payload.headers.find(h => h.name === "From")!.value = `Synthetic Support <${intent.mailbox}>`;
        sent.payload.headers.find(h => h.name === "To")!.value = `Synthetic Customer <${intent.recipient}>`;
    }
    expect((await options.adapters.verify(intent, a, effect.dispatchedAt!, AbortSignal.timeout(5000))).confirmed).toBe(scenario === "display-name");
});
it("lost Gmail ACK searches SENT and confirms without resending", async () => {
    p.setContacts([]);
    const row = await admission(), dispatch = options.adapters.dispatch;
    options.adapters.dispatch = async (...args) => { await dispatch(...args); throw Error("LOST_ACK"); };
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "uncertain"
    });
    await f.db.update(savIntakeEffects).set({
        nextReconcileAt: null
    }).where(eq(savIntakeEffects.executionId, row.id));
    await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
    expect((await getExecutionEffects(row.id))[0].state).toBe("confirmed");
    expect(p.calls.filter(c => c.path === "gmail/messages/send")).toHaveLength(1);
});
it("identity episode forbids a second initial after another inbound message", async () => {
    p.setContacts([]);
    const row = await admission();
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "confirmed"
    });
    const m = await storedMessage();
    p.setGmail(m.gmailMessageId!, "gmail-thread");
    const id = await observed(m.id), next = await admitIntakeExecution(id, options);
    expect(await executeIntakePass(next!.id, options)).toMatchObject({
        state: "waiting", reason: "SAV_INTAKE_EXECUTION_IDENTIFICATION_ALREADY_REQUESTED"
    });
    expect(p.calls.filter(c => c.path === "gmail/messages/send")).toHaveLength(1);
});
it("root permission revoked after marker still forbids auxiliary dispatch", async () => {
    p.seedTicket({
        stage: "new"
    });
    const row = await admission();
    expect(await executeIntakePass(row.id, options, {
        afterMarker: async () => { await writePolicy(mutations.filter(m => m !== "link_ticket")); }
    })).toMatchObject({
        state: "uncertain", reason: "SAV_INTAKE_EXECUTION_DISABLED"
    });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/notes"))).toHaveLength(0);
});
it.each(["claim", "marker", "ack"])("real cron resumes expired running after %s with no duplicate mutation", async (stage) => {
    const row = await admission(), lease = (await claimExecution(row.id))!;
    if (stage !== "claim") {
        lease.payload.baseline = await options.adapters.readCrm(lease.payload.plan, lease.payload.input, options.runtime, options.signal);
        await (await import("./execution-store")).saveExecutionPayload(lease);
        const intent: EffectIntent = {
            kind: "ticket_create", permission: "create_ticket", key: `create:${messageId}`, sourceMessageId: messageId, contactId: "101", marker: "synthetic-resume", properties: {
                subject: "Synthetic resume", content: "Synthetic resume synthetic-resume", hs_pipeline: "0", hs_pipeline_stage: "1", source_type: "EMAIL"
            }
        };
        const { ensureExecutionEffect, markEffectDispatched, recordEffectAck } = await import("./execution-store");
        const effect = await markEffectDispatched(lease, await ensureExecutionEffect(lease, intent));
        if (stage === "ack")
            await recordEffectAck(effect, await options.adapters.dispatch(intent, options.signal));
    }
    await f.db.update(savIntakeExecutions).set({
        leaseUntil: new Date(Date.now() - 1)
    }).where(eq(savIntakeExecutions.id, row.id));
    const result = await reconcileIntakeExecutor({
        env: () => environment, adapters: options.adapters
    });
    if (stage === "marker")
        expect(result).toMatchObject({
            state: "uncertain"
        });
    else
        expect(result).toMatchObject({
            state: "confirmed"
        });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(stage === "marker" ? 0 : 1);
});
it("RO scheduler ignores exhausted/backoff effects and reaches a due running ACK while OFF", async () => {
    const row = await admission();
    await executeIntakePass(row.id, options, {
        afterMarker: async () => { throw Error("CRASH"); }
    });
    await f.db.update(savIntakeEffects).set({
        reconcileAttempts: 5
    }).where(eq(savIntakeEffects.executionId, row.id));
    expect(await pendingIntakeEffectRecoveries()).toHaveLength(0);
    const before = p.calls.length;
    expect(await reconcileIntakeExecutor({
        env: () => ({
            SAV_INTAKE_EXECUTION_RECOVERY: "read_only"
        }), adapters: options.adapters
    })).toMatchObject({
        recovered: 0
    });
    expect(p.calls).toHaveLength(before);
});
it("scan cursor passes at least five source-invalid observations without rewriting freshness", async () => {
    const original = await observed();
    await f.db.update(savMessages).set({
        bodyCiphertext: encryptSavPayload({
            text: "changed"
        })
    }).where(eq(savMessages.id, messageId));
    for (let n = 0; n < 5; n++) {
        const t = (await f.db.insert(savThreads).values({
            mailboxId, gmailThreadId: `stale-${n}`, customerEmail: "customer@example.invalid"
        }).returning())[0];
        const m = await storedMessage(t.id);
        const id = await observed(m.id);
        await f.db.update(savMessages).set({
            bodyCiphertext: encryptSavPayload({
                text: "changed"
            })
        }).where(eq(savMessages.id, m.id));
        expect(id).toBeTruthy();
    }
    const t = (await f.db.insert(savThreads).values({
        mailboxId, gmailThreadId: "valid-last", customerEmail: "customer@example.invalid"
    }).returning())[0], m = await storedMessage(t.id), valid = await observed(m.id);
    const [before] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, original));
    for (let n = 0; n < 3; n++)
        await scanIntakeExecutionCandidates(options);
    expect((await f.db.select().from(savIntakeExecutions)).map(e => e.runId)).toContain(valid);
    const [after] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, original));
    expect(after.freshUntil).toEqual(before.freshUntil);
});
it("human writer and intake share durable contact scope even after OFF, stale attempt fenced", async () => {
    const row = await admission(), l = (await claimExecution(row.id))!;
    vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "synthetic-fake");
    vi.stubGlobal("fetch", p.network);
    const action = (await f.db.insert(savActions).values({
        threadId, messageId, kind: "link_ticket", status: "running", actorType: "human", attemptCount: 1, payload: {
            contactId: "101"
        }, idempotencyKey: randomUUID()
    }).returning())[0];
    await expect(withLegacyOccupationAction(action, () => guardLegacyIntakeOccupation(action))).rejects.toThrow("SCOPE_OCCUPIED");
    await endExecutionPass(l, "waiting", "SAV_PAUSED");
    vi.stubEnv("SAV_INTAKE_EXECUTION_MODE", "execute");
    await withLegacyOccupationAction(action, async () => { await guardLegacyIntakeOccupation(action); await markLegacyIntakeDispatch(action.id); });
    vi.stubEnv("SAV_INTAKE_EXECUTION_MODE", "off");
    await f.db.update(savActions).set({
        status: "failed", attemptCount: 2
    }).where(eq(savActions.id, action.id));
    await releaseLegacyIntakeIfConfirmed(action.id);
    expect((await f.db.select().from(savIntakeOccupations)).some(o => o.ownerId === action.id)).toBe(true);
    const [retry] = await f.db.select().from(savActions).where(eq(savActions.id, action.id));
    await expect(withLegacyOccupationAction(retry, () => guardLegacyIntakeOccupation(retry))).rejects.toThrow("RECONCILIATION_REQUIRED");
});
it("never-dispatched identity reservation transfers to a newer inbound without consuming another episode", async () => {
    p.setContacts([]);
    const row = await admission();
    let newer: string | undefined;
    expect(await executeIntakePass(row.id, options, {
        beforeMarker: async () => { const m = await storedMessage(); newer = m.id; p.setGmail(m.gmailMessageId!, "gmail-thread"); }
    })).toMatchObject({
        state: "waiting"
    });
    const [oldEffect] = await getExecutionEffects(row.id);
    expect(oldEffect.state).toBe("planned");
    expect(oldEffect.dispatchedAt).toBeNull();
    const id = await observed(newer!), next = await admitIntakeExecution(id, options);
    expect(await executeIntakePass(next!.id, options)).toMatchObject({
        state: "confirmed"
    });
    const [moved] = await getExecutionEffects(next!.id);
    expect(moved.id).toBe(oldEffect.id);
    expect(p.calls.filter(c => c.path === "gmail/messages/send")).toHaveLength(1);
});
it("an expired observation is revalidated explicitly without changing evidence timestamps", async () => {
    const id = await observed(), old = new Date(Date.now() - 1000);
    await f.db.update(savIntakeRuns).set({
        freshUntil: old
    }).where(eq(savIntakeRuns.id, id));
    const row = await admitIntakeExecution(id, options);
    expect(await executeIntakePass(row!.id, options)).toMatchObject({
        state: "confirmed"
    });
    expect((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, id)))[0].freshUntil).toBeNull(); // own link invalidates run, never extends its evidence
});
it("known HubSpot email ID still requires source verification and final association, without POST email", async () => {
    const m = (await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0];
    p.objects.emails["888"] = {
        id: "888", properties: {
            hs_timestamp: m.receivedAt.toISOString(), hs_email_direction: "INCOMING_EMAIL", hs_email_subject: m.subject, hs_email_text: "The synthetic connection fails.", hs_email_headers: JSON.stringify({
                from: {
                    email: m.fromEmail
                }, to: m.toEmails.map(email => ({
                    email
                })), cc: [], bcc: []
            }), hs_email_from_email: m.fromEmail, hs_email_to_email: m.toEmails.join(";")
        }
    };
    await f.db.update(savMessages).set({
        hubspotEmailId: "888"
    }).where(eq(savMessages.id, messageId));
    const row = await admission();
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "confirmed"
    });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/emails"))).toHaveLength(0);
    expect(p.calls.filter(c => c.method === "PUT" && c.path.includes("/emails/888/associations/default/tickets/"))).toHaveLength(1);
});
it("two concurrent admissions sharing contact have a single durable winner", async () => {
    const a = await observed(), thread = (await f.db.insert(savThreads).values({
        mailboxId, gmailThreadId: "second-thread", customerEmail: "customer@example.invalid"
    }).returning())[0], m = await storedMessage(thread.id), b = await observed(m.id);
    const results = await Promise.allSettled([admitIntakeExecution(a, options), admitIntakeExecution(b, options)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(1);
});
it("operator candidate reconciliation is verified/audited and has no mutation capability", async () => {
    const row = await admission(), dispatch = options.adapters.dispatch;
    options.adapters.dispatch = async (...args) => { await dispatch(...args); throw Error("LOST_ACK"); };
    await executeIntakePass(row.id, options);
    const [effect] = await getExecutionEffects(row.id), candidate = Object.keys(p.objects.tickets)[0], before = p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets")).length;
    await expect(reconcileIntakeEffectCandidate(effect.id, "999", "Synthetic wrong candidate selected", options.adapters)).rejects.toThrow();
    expect(await reconcileIntakeEffectCandidate(effect.id, candidate, "Synthetic verified exact candidate", options.adapters)).toMatchObject({
        confirmed: true
    });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(before);
});
it("policy revocation survives staff reactivation and still accepts late ACK/RO", async () => {
    const row = await admission(), dispatch = options.adapters.dispatch;
    options.adapters.dispatch = async (...args) => {
        const result = await dispatch(...args);
        await revokeIntakeExecutionPolicy(options.config.policyId, "Synthetic durable revocation");
        await f.db.update(staffUsers).set({
            active: true, role: "admin"
        }).where(eq(staffUsers.id, adminId));
        return result;
    };
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "waiting", reason: "SAV_INTAKE_EXECUTION_PERMISSION_REVOKED"
    });
    expect((await getExecutionEffects(row.id))[0].state).toBe("confirmed");
    await expect(readIntakeExecutionAuthority(options.config)).rejects.toThrow("PERMISSION_REVOKED");
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
});
it("human confirmed registration identity occupies its actual contact and ticket", async () => {
    vi.stubEnv("SAV_INTAKE_EXECUTION_MODE", "execute");
    vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "synthetic-fake");
    vi.stubGlobal("fetch", p.network);
    p.setContacts([{
            id: "101", emails: ["customer@example.invalid"]
        }, {
            id: "102", emails: ["registered@example.invalid"]
        }]);
    await f.db.transaction(tx => occupyKeys(tx, randomUUID(), "intake", ["contact:102"]));
    const action = (await f.db.insert(savActions).values({
        threadId, messageId, kind: "link_ticket", status: "running", actorType: "human", attemptCount: 1, idempotencyKey: randomUUID(), payload: {
            ticketId: "888", ticketReviewSnapshotCiphertext: encryptSavPayload({
                customerEmail: "customer@example.invalid", proposal: {
                    customerIdentity: {
                        verifiedByHuman: true, registrationEmail: "registered@example.invalid"
                    }, routing: {
                        contactId: "102"
                    }
                }
            })
        }
    }).returning())[0];
    await expect(withLegacyOccupationAction(action, () => guardLegacyIntakeOccupation(action))).rejects.toThrow("SCOPE_OCCUPIED");
});
it("RO confirmed late ACK releases a paused partial scope without linking or another POST", async () => {
    const row = await admission();
    expect(await executeIntakePass(row.id, options, {
        afterAck: async () => {
            await f.db.update(savThreads).set({
                aiPaused: true
            }).where(eq(savThreads.id, threadId));
            throw Error("CRASH_AFTER_ACK");
        }
    })).toMatchObject({
        state: "uncertain"
    });
    await f.db.update(savIntakeEffects).set({
        nextReconcileAt: null
    }).where(eq(savIntakeEffects.executionId, row.id));
    await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
    expect((await getExecutionEffects(row.id))[0].state).toBe("confirmed");
    expect(await f.db.select().from(savIntakeOccupations)).toHaveLength(0);
    expect((await f.db.select().from(savThreads).where(eq(savThreads.id, threadId)))[0].hubspotTicketId).toBeNull();
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
});
// Review735: a directly linked contact can own the only matching ticket. The
// primary contact's empty ticket list is valid and must remain independently read.
function linkedContactTicket(stage: "open" | "closed", ownerId: string | null = null) {
    p.setContacts([{
            id: "101", emails: ["customer@example.invalid"]
        }, {
            id: "102", emails: ["linked@example.invalid"]
        }]);
    p.links.set("contacts:101:contacts", ["102"]);
    p.seedTicket({
        id: "201", contactIds: ["102"], stage, ownerId, closedAt: stage === "closed" ? new Date(Date.now() - 1000).toISOString() : undefined
    });
}
it.each([
    ["open", null], ["closed", null], ["open", "777"], ["closed", "777"]
] as const)("review735 linked-contact-only %s ticket owner %s confirms with primary ticket list empty", async (stage, ownerId) => {
    linkedContactTicket(stage, ownerId);
    const row = await admission();
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "confirmed"
    });
    expect(p.links.get("contacts:101:tickets") ?? []).toEqual([]);
    expect(p.links.get("contacts:102:tickets")).toEqual(["201"]);
    expect(p.objects.tickets["201"].properties.hubspot_owner_id).toBe(ownerId);
    expect(await executeIntakePass(row.id, options)).toEqual({
        skipped: "occupied"
    });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/notes"))).toHaveLength(1);
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/emails"))).toHaveLength(1);
    const effects = await getExecutionEffects(row.id);
    expect(effects.every(e => e.state === "confirmed")).toBe(true);
    expect(p.calls.filter(c => c.method === "PATCH")).toHaveLength(1);
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(0);
});
it.each(["disappeared", "human_closed"] as const)("review735 linked ticket %s after PATCH: only a target out of the contacts' tickets stops", async (change) => {
    linkedContactTicket("open");
    const row = await admission(), verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "stage_new") {
            if (change === "disappeared")
                p.links.set("contacts:102:tickets", []);
            else
                p.objects.tickets["201"].properties.hs_pipeline_stage = "4";
        }
        return proof;
    };
    expect(await executeIntakePass(row.id, options)).toMatchObject(change === "disappeared" ? { state: "waiting", reason: "SAV_INTAKE_EXECUTION_CRM_CHANGED" } : { state: "confirmed" });
    expect((await getExecutionEffects(row.id)).find(e => e.kind === "stage_new")?.state).toBe("confirmed");
    if (change === "disappeared") {
        expect((await f.db.select().from(savThreads).where(eq(savThreads.id, threadId)))[0].hubspotTicketId).toBeNull();
        expect((await readIntakeExecutionProgress(messageId))?.crmDelta).toMatchObject({ reason: "target_out_of_scope", ticketIds: ["201"], fields: ["tickets", "ticket.out_of_scope"] });
    }
});
it("review735 confirmed history stays confirmed when a new entrant is admitted", async () => {
    const first = await admission();
    expect(await executeIntakePass(first.id, options)).toMatchObject({
        state: "confirmed"
    });
    const before = await readIntakeExecutionProgress(messageId), receipts = await getExecutionEffects(first.id);
    const newer = await storedMessage();
    p.setGmail(newer.gmailMessageId!, "gmail-thread");
    const nextRun = await observed(newer.id);
    expect(await admitIntakeExecution(nextRun, options)).toBeTruthy();
    expect(await readIntakeExecutionProgress(messageId)).toEqual(before);
    expect(await getExecutionEffects(first.id)).toEqual(receipts);
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
});
it("review735 confirmed template history stays confirmed when the next identification message is admitted", async () => {
    p.setContacts([]);
    const first = await admission();
    expect(await executeIntakePass(first.id, options)).toMatchObject({
        state: "confirmed"
    });
    const before = await readIntakeExecutionProgress(messageId), receipts = await getExecutionEffects(first.id);
    const newer = await storedMessage();
    p.setGmail(newer.gmailMessageId!, "gmail-thread");
    const nextRun = await observed(newer.id);
    expect(await admitIntakeExecution(nextRun, options)).toBeTruthy();
    expect(await readIntakeExecutionProgress(messageId)).toEqual(before);
    expect(await getExecutionEffects(first.id)).toEqual(receipts);
    expect(p.calls.filter(c => c.path === "gmail/messages/send")).toHaveLength(1);
});
async function operationalAdmissionProfile() {
  const pins={...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!),budgetProfile:"operational_utc_v1",maxRollingNanoUsd:90000000000,maxCalls:300};
  environment.SAV_INTAKE_RUNTIME_CONFIG=JSON.stringify(pins);
  options.runtime=savIntakeRuntimeConfig(environment)!;
  options.policy={...options.policy,budgetProfile:"operational_utc_v1"};
  await writePolicy();
}
async function historicalAdmissions(at:Date,count=100) {
  await f.db.insert(savIntakeExecutions).values(Array.from({length:count},()=>({messageId:randomUUID(),threadId:randomUUID(),runVersion:1,policyId:options.config.policyId,policyHash:options.config.policyHash,state:"confirmed",payloadCiphertext:encryptSavPayload({synthetic:true}),createdAt:at})));
  await f.db.update(savIntakeExecutionBudget).set({admitted:count});
}
it("operational100 admissions are UTC daily while the lifetime integrity counter keeps advancing",async()=>{
  await operationalAdmissionProfile();
  const yesterday=new Date(Date.parse(new Date().toISOString().slice(0,10)+"T00:00:00Z")-1);
  await historicalAdmissions(yesterday);
  await admission();
  expect((await f.db.select().from(savIntakeExecutionBudget))[0].admitted).toBe(101);
  expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(101);
});
it("operational daily admission limit survives another policy and refuses future ledger clocks",async()=>{
  await operationalAdmissionProfile();await historicalAdmissions(new Date());
  options.policy={...options.policy,expiresAt:new Date(Date.now()+7200000).toISOString()};await writePolicy();
  runId=await observed();await expect(admitIntakeExecution(runId,options)).rejects.toThrow("ADMISSION_LIMIT");
  await f.db.update(savIntakeExecutions).set({createdAt:new Date(Date.now()+60000)});
  await expect(admitIntakeExecution(runId,options)).rejects.toThrow("LEDGER_CLOCK_REJECTED");
  expect((await f.db.select().from(savIntakeExecutionBudget))[0].admitted).toBe(100);
});

it("a recovery no-send scope blocks even an already admitted identification execution",async()=>{
 p.setContacts([]);const row=await admission();
 const payload=decryptSavPayload<import("./execution-types").ExecutionPayload>(row.payloadCiphertext);
 payload.input={...(payload.input as object),humanResolution:{suppressOutbound:true}};
 await f.db.update(savIntakeExecutions).set({payloadCiphertext:encryptSavPayload(payload)}).where(eq(savIntakeExecutions.id,row.id));
 expect(await executeIntakePass(row.id,options)).toMatchObject({state:"waiting",reason:"SAV_INTAKE_EXECUTION_OUTBOUND_SUPERVISED"});
 expect(p.calls.filter(c=>c.path==="gmail/messages/send")).toHaveLength(0);expect(await getExecutionEffects(row.id)).toHaveLength(0);
});

async function verifiedIdentityAfterRevocation() {
    p.setContacts([]);
    const row = await admission(), verify = options.adapters.verify;
    options.adapters.verify = async () => ({confirmed:false,attributed:false});
    expect(await executeIntakePass(row.id,options)).toMatchObject({state:"uncertain"});
    const effect = (await getExecutionEffects(row.id))[0];
    await f.db.update(savIntakeEffects).set({reconcileAttempts:5}).where(eq(savIntakeEffects.id,effect.id));
    await revokeIntakeExecutionPolicy(options.config.policyId,"Synthetic rotation after a real verified send");
    options.adapters.verify = verify;
    const ack = decryptSavPayload<EffectAck>(effect.ackCiphertext!);
    await reconcileIntakeEffectCandidate(effect.id,ack.id!,"Synthetic existing sent receipt, never resend",options.adapters);
    return row;
}
it("finalizes a verified identity receipt after revoked authority without dispatch, reset or readmission", async () => {
    const row = await verifiedIdentityAfterRevocation();
    const before = p.calls.length, budget = await f.db.select().from(savIntakeExecutionBudget);
    expect(await finishVerifiedIdentityRecovery(row.id)).toBe(true);
    expect(await finishVerifiedIdentityRecovery(row.id)).toBe(false);
    expect(await readIntakeExecutionProgress(messageId)).toMatchObject({confirmed:true,ticketId:null,reason:null});
    expect((await f.db.select().from(savMessages).where(eq(savMessages.id,messageId)))[0].analysisStatus).toBe("intake_execution_identity_wait");
    expect(await f.db.select().from(savIntakeOccupations)).toHaveLength(0);
    expect(await f.db.select().from(savIntakeExecutionBudget)).toEqual(budget);
    expect((await getExecutionEffects(row.id))[0].reconcileAttempts).toBe(5);
    expect(p.calls).toHaveLength(before);
    expect(p.calls.filter(c=>c.path==="gmail/messages/send")).toHaveLength(1);
});
it.each(["new-inbound","changed-source","superseded-run","active-lease","missing-proof","changed-intent","paused","missing-run"])("identity receipt finalization preserves the %s barrier", async scenario => {
    const row = await verifiedIdentityAfterRevocation(), before = p.calls.length;
    if(scenario==="new-inbound") await storedMessage(threadId,new Date(Date.now()+1));
    if(scenario==="changed-source") await f.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:"Changed source"})}).where(eq(savMessages.id,messageId));
    if(scenario==="superseded-run") await f.db.update(savIntakeRuns).set({isCurrent:false}).where(eq(savIntakeRuns.id,runId));
    if(scenario==="active-lease") await f.db.update(savIntakeExecutions).set({leaseUntil:new Date(Date.now()+60000)}).where(eq(savIntakeExecutions.id,row.id));
    if(scenario==="missing-proof") await f.db.update(savIntakeEffects).set({verificationCiphertext:null}).where(eq(savIntakeEffects.executionId,row.id));
    if(scenario==="changed-intent") await f.db.update(savIntakeEffects).set({intentHash:"0".repeat(64)}).where(eq(savIntakeEffects.executionId,row.id));
    if(scenario==="missing-run") await f.db.update(savIntakeExecutions).set({runId:null}).where(eq(savIntakeExecutions.id,row.id));
    if(scenario==="paused") await f.db.update(savThreads).set({aiPaused:true}).where(eq(savThreads.id,threadId));
    expect(await finishVerifiedIdentityRecovery(row.id)).toBe(false);
    expect((await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id,row.id)))[0].state).toBe("uncertain");
    expect(p.calls).toHaveLength(before);
});
it.each(["confirmed","departed","dispatch-marker"])("configuration catchup preserves %s receipts and still accepts new inbound", async scenario => {
    p.setContacts([]);
    const row = await admission();
    if(scenario==="confirmed") await executeIntakePass(row.id,options);
    else {
        options.adapters.verify=async()=>({confirmed:false,attributed:false});
        await executeIntakePass(row.id,options);
        if(scenario==="dispatch-marker") await f.db.update(savIntakeEffects).set({state:"planned"}).where(eq(savIntakeEffects.executionId,row.id));
    }
    const runs = await f.db.select().from(savIntakeRuns), rotated = {...options.runtime,codeRevision:"b".repeat(40),configHash:intakeRuntimeHash("rotated")};
    expect(await catchupSavIntake(rotated)).toBe(0);
    expect(await enqueueSavIntakeMessage(messageId,rotated)).toBeNull();
    expect(await f.db.select().from(savIntakeRuns)).toEqual(runs);
    const newer = await storedMessage(threadId,new Date(Date.now()+1));
    expect(await enqueueSavIntakeMessage(newer.id,rotated)).toBeTruthy();
    expect((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.isCurrent,true)))[0].messageId).toBe(newer.id);
    expect(p.calls.filter(c=>c.path==="gmail/messages/send")).toHaveLength(1);
});

// Historical persisted intent and provider normalization, using synthetic data only.
it.each(["stored-ack", "missing-ack", "changed-text"] as const)("historical note reconciliation preserves %s attribution and never sends a second note", async scenario => {
    p.seedTicket({ stage: "open" });
    const row = await admission();
    expect(await executeIntakePass(row.id, options, {
        afterAck: async effect => {
            if (effect.kind !== "note_create") return;
            const intent = decryptSavPayload<EffectIntent>(effect.intentCiphertext);
            const currentBody = intent.properties!.hs_note_body;
            const markerParagraph = `<p>[Studio intake: ${intent.marker}]</p>`;
            const body = currentBody.slice(0, -markerParagraph.length);
            intent.properties!.hs_note_body = `${body}<!-- sav-intake:${intent.marker} -->`;
            const [stored] = (await getExecutionEffects(row.id)).filter(e => e.id === effect.id);
            const noteId = decryptSavPayload<EffectAck>(stored.ackCiphertext!).id!;
            p.objects.notes[noteId].properties.hs_note_body = body + (scenario === "changed-text" ? "Edited" : "\n");
            await f.db.update(savIntakeEffects).set({ intentCiphertext: encryptSavPayload(intent), ...(scenario === "missing-ack" ? { ackCiphertext: null } : {}) }).where(eq(savIntakeEffects.id, effect.id));
            throw Error("SYNTHETIC_CRASH_AFTER_NOTE_ACK");
        }
    })).toMatchObject({ state: "uncertain" });
    const noteEffect = (await getExecutionEffects(row.id)).find(e => e.kind === "note_create")!;
    expect(noteEffect.state).toBe("uncertain");
    const noteId = Object.keys(p.objects.notes)[0];
    if (scenario === "missing-ack") {
        await expect(reconcileIntakeEffectCandidate(noteEffect.id, noteId, "Synthetic operator ID is not a provider receipt", options.adapters)).rejects.toThrow("RECONCILIATION_REQUIRED");
        expect((await getExecutionEffects(row.id)).find(e => e.id === noteEffect.id)?.ackCiphertext).toBeNull();
    }
    await f.db.update(savIntakeEffects).set({ nextReconcileAt: null }).where(eq(savIntakeEffects.id, noteEffect.id));
    await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
    const recovered = (await getExecutionEffects(row.id)).find(e => e.id === noteEffect.id)!;
    expect(recovered.state).toBe(scenario === "stored-ack" ? "confirmed" : "uncertain");
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: scenario === "stored-ack" ? "confirmed" : "uncertain" });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/notes"))).toHaveLength(1);
    expect(p.links.get(`notes:${noteId}:tickets`) ?? []).toEqual(scenario === "stored-ack" ? ["201"] : []);
    if (scenario === "stored-ack") {
        const association = (await getExecutionEffects(row.id)).find(e => e.kind === "note_associate")!;
        expect(decryptSavPayload<EffectIntent>(association.intentCiphertext).confirmedNoteCreate).toEqual({ effectId: noteEffect.id, objectId: noteId });
        expect(association.state).toBe("confirmed");
    }
}, 20000);

async function localFence(row: { id: string }, external = false) {
    if (external) await f.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: "sav_dossier_completed_externally", entityType: "sav_message", entityId: messageId,
        technicalMetadata: { version: 1, threadId, batchId: randomUUID(), receivedBefore: new Date().toISOString(), reason: "processed_outside_studio" } });
    else await f.db.update(savThreads).set({ aiPaused: true, humanRequestedAt: new Date() }).where(eq(savThreads.id, threadId));
    expect((await f.db.select().from(savIntakeOccupations)).some(key => key.ownerId === row.id)).toBe(true);
}
it.each(["pause", "external"])("releases admitted but never-dispatched %s scope so the next same-contact dossier can be admitted", async fence => {
    const owner = await admission();
    await localFence(owner, fence === "external");
    expect(await releaseNeverDispatchedIntakeScopes(mailboxId)).toEqual({ released: 1 });
    expect(await releaseNeverDispatchedIntakeScopes(mailboxId)).toEqual({ released: 0 });
    expect((await f.db.select().from(savIntakeOccupations)).some(key => key.ownerId === owner.id)).toBe(false);
    expect(await getExecutionEffects(owner.id)).toEqual([]);
    const [nextThread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "customer@example.invalid" }).returning();
    threadId = nextThread.id; messageId = (await storedMessage()).id;
    const next = await admission();
    expect((await f.db.select().from(savIntakeOccupations)).find(key => key.key === "contact:101")?.ownerId).toBe(next.id);
    const journal = await f.db.select().from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId, owner.id));
    expect(journal.filter(event => event.kind === "never_dispatched_scope_released")).toHaveLength(1);
    expect(p.calls.filter(call => call.method === "POST" && !call.path.endsWith("/search") && !call.path.endsWith("/read"))).toHaveLength(0);
}, 20000);
it.each(["planned", "dispatched", "acked", "confirmed", "uncertain", "planned-token", "planned-date", "planned-ack", "planned-verification", "planned-confirmed-date", "empty-ack", "empty-verification", "execution-lease", "analysis-lease", "command-lease", "legacy-owner", "unknown-key", "new-inbound", "revoked-marker"])("never-dispatched scope recovery preserves the %s barrier", async barrier => {
    const owner = await admission();
    const external = ["new-inbound", "revoked-marker"].includes(barrier);
    await localFence(owner, external);
    if (["planned", "dispatched", "acked", "confirmed", "uncertain"].includes(barrier) || barrier.startsWith("planned-") || barrier.startsWith("empty-")) {
        const intent: EffectIntent = { kind: "ticket_create", permission: "create_ticket", key: `synthetic-unused-${owner.id}`, sourceMessageId: messageId };
        await f.db.insert(savIntakeEffects).values({ executionId: owner.id, businessKey: intent.key, kind: intent.kind, permission: intent.permission,
            state: ["planned", "dispatched", "acked", "confirmed", "uncertain"].includes(barrier) ? barrier : "planned", intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent),
            ...(barrier === "planned-token" ? { dispatchToken: randomUUID() } : {}), ...(barrier === "planned-date" ? { dispatchedAt: new Date() } : {}),
            ...(barrier === "planned-ack" ? { ackCiphertext: encryptSavPayload({ id: "901" }) } : {}), ...(barrier === "planned-verification" ? { verificationCiphertext: encryptSavPayload({ confirmed: true }) } : {}),
            ...(barrier === "planned-confirmed-date" ? { confirmedAt: new Date() } : {}), ...(barrier === "empty-ack" ? { ackCiphertext: "" } : {}), ...(barrier === "empty-verification" ? { verificationCiphertext: "" } : {}) });
    }
    if (barrier === "execution-lease") await f.db.update(savIntakeExecutions).set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) }).where(eq(savIntakeExecutions.id, owner.id));
    if (barrier === "analysis-lease") await f.db.update(savIntakeRuns).set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) }).where(eq(savIntakeRuns.id, runId));
    if (barrier === "command-lease") await f.db.insert(savIntakeHumanEvents).values({ threadId, messageId, parentRunId: runId, parentVersion: 1, baseConfigHash: options.runtime.configHash,
        sourceHash: "synthetic", kind: "refuse", state: "reading", commandKey: randomUUID(), leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000), payloadCiphertext: encryptSavPayload({}) });
    if (barrier === "legacy-owner") await f.db.update(savIntakeOccupations).set({ ownerKind: "legacy" }).where(eq(savIntakeOccupations.ownerId, owner.id));
    if (barrier === "unknown-key") await f.db.insert(savIntakeOccupations).values({ key: "contact:999", ownerId: owner.id, ownerKind: "intake" });
    if (barrier === "new-inbound") await storedMessage(threadId, new Date(Date.now() + 1000));
    if (barrier === "revoked-marker") {
        const [audit] = await f.db.select().from(auditLogs).where(eq(auditLogs.entityId, messageId));
        await f.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: "sav_dossier_external_completion_reverted", entityType: "sav_message", entityId: messageId,
            technicalMetadata: { version: 1, batchId: audit.technicalMetadata.batchId, completionId: audit.id }, createdAt: new Date(audit.createdAt.getTime() + 1) });
    }
    const keys = await f.db.select().from(savIntakeOccupations), effects = await getExecutionEffects(owner.id);
    expect(await releaseNeverDispatchedIntakeScopes(mailboxId)).toEqual({ released: barrier === "planned" ? 1 : 0 });
    expect(await getExecutionEffects(owner.id)).toEqual(effects);
    if (barrier !== "planned") expect(await f.db.select().from(savIntakeOccupations)).toEqual(keys);
}, 20000);

async function commonGuardRecoveryFixture() {
    const row = await admission();
    await executeIntakePass(row.id, options, { afterAck: async () => { throw Error("SYNTHETIC_CRASH_AFTER_ACK"); } });
    const [effect] = await getExecutionEffects(row.id);
    await f.db.update(savIntakeEffects).set({ nextReconcileAt: null }).where(eq(savIntakeEffects.id, effect.id));
    return { row, effect: (await getExecutionEffects(row.id))[0] };
}
it.each(["marker", "ack"])("common guard skips both recovery paths during an active worker lease after %s", async stage => {
    const row = await admission(), original = options.adapters.verify, verify = vi.fn(original);
    options.adapters.verify = verify;
    const check = async () => {
        const effects = await getExecutionEffects(row.id); if (effects.length !== 1) return;
        const [effect] = effects, before = structuredClone(effect);
        expect(await pendingIntakeEffectRecoveries()).toEqual([]);
        expect((await reconcileIntakeEffectsReadOnly(row.id, options.adapters)).checked).toBe(0);
        await expect(reconcileIntakeEffectCandidate(effect.id, "901", "Synthetic operator must wait for worker", options.adapters)).rejects.toThrow("RECOVERY_BUSY");
        expect(verify).not.toHaveBeenCalled();
        expect((await getExecutionEffects(row.id))[0]).toEqual(before);
    };
    expect(await executeIntakePass(row.id, options, stage === "marker" ? { afterMarker: check } : { afterAck: check })).toMatchObject({ state: "confirmed" });
    expect(p.calls.filter(call => call.method === "POST" && call.path.endsWith("/tickets"))).toHaveLength(1);
    expect((await getExecutionEffects(row.id)).every(effect => effect.reconcileAttempts === 0)).toBe(true);
}, 20000);
it("common guard revalidates a worker claim after recovery selection and resumes a recovered running/null execution", async () => {
    const { row, effect } = await commonGuardRecoveryFixture();
    expect((await pendingIntakeEffectRecoveries()).map(candidate => candidate.id)).toContain(row.id);
    const worker = (await claimExecution(row.id))!, verify = vi.spyOn(options.adapters, "verify");
    expect((await reconcileIntakeEffectsReadOnly(row.id, options.adapters)).checked).toBe(0);
    expect(verify).not.toHaveBeenCalled(); expect((await getExecutionEffects(row.id))[0]).toEqual(effect);
    expect((await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, row.id)))[0].leaseToken).toBe(worker.token);
    await f.db.update(savIntakeExecutions).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(savIntakeExecutions.id, row.id));
    expect(await reconcileIntakeExecutor({ env: () => environment, adapters: options.adapters })).toMatchObject({ state: "confirmed" });
    expect(p.calls.filter(call => call.method === "POST" && call.path.endsWith("/tickets"))).toHaveLength(1);
}, 20000);
it("common guard recovery owns a lease through verify and excludes another worker or recovery", async () => {
    const { row } = await commonGuardRecoveryFixture(), verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        expect(await claimExecution(row.id)).toBeNull();
        expect((await pendingIntakeEffectRecoveries()).some(candidate => candidate.id === row.id)).toBe(false);
        expect((await reconcileIntakeEffectsReadOnly(row.id, options.adapters)).checked).toBe(0);
        return verify(...args);
    };
    expect((await reconcileIntakeEffectsReadOnly(row.id, options.adapters)).checked).toBe(1);
    expect((await getExecutionEffects(row.id))[0].state).toBe("confirmed");
}, 20000);
it.each(["confirmed", "unknown", "throw"])("common guard discards a %s provider read after another worker reclaims the lease", async result => {
    const { row, effect } = await commonGuardRecoveryFixture(); let token: string | undefined;
    options.adapters.verify = async () => {
        await f.db.update(savIntakeExecutions).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(savIntakeExecutions.id, row.id));
        token = (await claimExecution(row.id))!.token;
        if (result === "throw") throw Error("SYNTHETIC_PROVIDER_UNAVAILABLE");
        return { confirmed: result === "confirmed", attributed: result === "confirmed", ack: { id: "901" } };
    };
    expect((await reconcileIntakeEffectsReadOnly(row.id, options.adapters)).checked).toBe(1);
    expect((await getExecutionEffects(row.id))[0]).toEqual(effect);
    expect((await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, row.id)))[0].leaseToken).toBe(token);
    expect(p.calls.filter(call => call.method === "POST" && call.path.endsWith("/tickets"))).toHaveLength(1);
}, 20000);
it.each([true, false])("common guard operator cannot persist an accepted=%s read after losing the lease", async accepted => {
    const { row, effect } = await commonGuardRecoveryFixture(); let token: string | undefined;
    options.adapters.verify = async () => {
        await f.db.update(savIntakeExecutions).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(savIntakeExecutions.id, row.id));
        token = (await claimExecution(row.id))!.token;
        return { confirmed: accepted, attributed: accepted, ack: { id: "901" } };
    };
    await expect(reconcileIntakeEffectCandidate(effect.id, "901", "Synthetic explicit recovery candidate", options.adapters)).rejects.toThrow("RECOVERY_BUSY");
    expect((await getExecutionEffects(row.id))[0]).toEqual(effect);
    expect((await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, row.id)))[0].leaseToken).toBe(token);
    const journal = await f.db.select().from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId, row.id));
    expect(journal.some(event => event.kind === "operator_candidate_checked")).toBe(false);
}, 20000);
it("common guard completed ticket-trigger invalidation cannot select or claim another model analysis", async () => {
    const row = await admission();
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    const [run] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
    expect(run.state).toBe("waiting");
    expect((await pendingSavIntakeRuns(options.runtime)).some(candidate => candidate.id === runId)).toBe(false);
    expect(await claimSavIntakeRun(runId, options.runtime)).toBeNull();
    const network = vi.fn(async () => { throw Error("MODEL_FORBIDDEN"); });
    expect(await analyseSavIntakeRuntime(runId, options.runtime, { env: () => environment, network })).toEqual({ skipped: "not_claimed" });
    expect(network).not.toHaveBeenCalled();
    expect((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId)))[0].attempts).toBe(run.attempts);
}, 20000);

function appendConcurrentEmail(ticketId: string, id: string) {
    p.objects.emails[id] = { id, properties: { hs_timestamp: new Date().toISOString(), hs_email_direction: "INCOMING_EMAIL", hs_email_subject: "Synthetic concurrently logged email", hs_email_text: "Synthetic CRM logging." } };
    const key = `tickets:${ticketId}:emails`;
    p.links.set(key, [...(p.links.get(key) ?? []), id]);
}
it("continues an already created ticket when CRM logs the inbound and auto-ack during email conservation", async () => {
    const row = await admission(), verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "email_create" && proof.confirmed) {
            const ticketId = Object.keys(p.objects.tickets)[0];
            appendConcurrentEmail(ticketId, "8801"); appendConcurrentEmail(ticketId, "8802");
        }
        return proof;
    };
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/emails"))).toHaveLength(1);
    expect(p.calls.filter(c => c.path === "gmail/messages/send")).toHaveLength(0);
    const writes = p.calls.filter(c => ["POST", "PUT", "PATCH"].includes(c.method)).length;
    await executeIntakePass(row.id, options);
    expect(p.calls.filter(c => ["POST", "PUT", "PATCH"].includes(c.method))).toHaveLength(writes);
});
it("finalizes all confirmed existing-ticket effects after native CRM emails arrive, without another mutation", async () => {
    p.seedTicket({ stage: "open" });
    const row = await admission(), verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "stage_new" && proof.confirmed) {
            appendConcurrentEmail("201", "8801"); appendConcurrentEmail("201", "8802");
        }
        return proof;
    };
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    expect((await getExecutionEffects(row.id)).every(e => e.state === "confirmed")).toBe(true);
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/notes"))).toHaveLength(1);
    expect(p.calls.filter(c => c.method === "PATCH")).toHaveLength(1);
    expect(p.calls.filter(c => c.path === "gmail/messages/send")).toHaveLength(0);
});
it("does not finalize concurrent CRM logging if Gmail has a newer customer reply", async () => {
    p.seedTicket({ stage: "open" });
    const row = await admission(), verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "stage_new" && proof.confirmed) {
            appendConcurrentEmail("201", "8801");
            options.adapters.gmailCurrent = async () => { throw Error("SAV_INTAKE_EXECUTION_GMAIL_CHANGED"); };
        }
        return proof;
    };
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "waiting", reason: "SAV_INTAKE_EXECUTION_GMAIL_CHANGED" });
});
it("distinguishes an incomplete CRM read from an actual changed snapshot", async () => {
    const row = await admission();
    options.adapters = createIntakeExecutorAdapters({ network: async () => new Response(null, { status: 503 }), gmailRequest: p.gmail, env: () => environment });
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "waiting", reason: "SAV_INTAKE_EXECUTION_CRM_READ_HUBSPOT_HTTP_503" });
    expect(await getExecutionEffects(row.id)).toHaveLength(0);
});
// Choice rule (Ugo, 27/10): an email HubSpot logs on the target before set-New (its own copy of
// the customer mail, an acknowledgement or any other email) no longer stops the reopening.
it.each(["automatic_ack","source_copy","unknown_email"] as const)("reopens after four confirmed effects even if a %s was logged meanwhile, without replay",async kind=>{
 p.seedTicket({stage:"closed",closedAt:new Date(Date.now()-1000).toISOString()});
 const row=await admission(),verify=options.adapters.verify;let inserted=false;
 options.adapters.verify=async(...args)=>{const proof=await verify(...args);if(args[0].kind==="email_associate"&&proof.confirmed&&!inserted){
  inserted=true;const native=kind==="source_copy";
  p.objects.emails["8801"]={id:"8801",properties:{hs_timestamp:new Date().toISOString(),hs_email_direction:native?"INCOMING_EMAIL":"EMAIL",hs_email_from_email:native?"customer@example.invalid":"support@example.invalid",hs_email_to_email:native?"support@example.invalid":"customer@example.invalid",hs_email_subject:kind==="unknown_email"?"Other":"Synthetic receipt",hs_email_text:"Synthetic logged email."}};
  p.links.set("tickets:201:emails",[...(p.links.get("tickets:201:emails")??[]),"8801"]);
 }return proof;};
 expect(await executeIntakePass(row.id,options)).toMatchObject({state:"confirmed"});
 const effects=await getExecutionEffects(row.id);expect(effects).toHaveLength(5);expect(effects.every(e=>e.state==="confirmed")).toBe(true);
 expect(p.calls.filter(c=>c.method==="POST"&&c.path.endsWith("/notes"))).toHaveLength(1);
 expect(p.calls.filter(c=>c.method==="POST"&&c.path.endsWith("/emails"))).toHaveLength(1);
 expect(p.calls.filter(c=>c.method==="POST"&&c.path.endsWith("/tickets"))).toHaveLength(0);
 expect(p.calls.filter(c=>c.method==="PATCH")).toHaveLength(1);expect(p.calls.filter(c=>c.path==="gmail/messages/send")).toHaveLength(0);
 const count=p.calls.filter(c=>["POST","PUT","PATCH"].includes(c.method)).length;await executeIntakePass(row.id,options);expect(p.calls.filter(c=>["POST","PUT","PATCH"].includes(c.method))).toHaveLength(count);
},20000);

// ---- Étape 2, lot 3: the single-call reader's plan through the unchanged executor and real HTTP adapters.
import { createSavIntakeSimpleReaders, memoizeIntakeCrmReaders } from "./simple-readers";
import { encodeSimpleWireFixture } from "./simple-wire.fixture";
import type { SimpleWireReferences } from "./simple-wire";
import type { IntakeGeminiCall } from "./model-readers";
type SimpleData = { outputReferences: SimpleWireReferences; tickets: { ticketId: string }[]; contacts: { contactId: string }[] };
const simpleAnswer = (data: SimpleData, over: Record<string, unknown> = {}) => ({
    messageId, nature: "request", requests: [{ id: "r1", kind: "support", summary: "La connexion échoue.", sourceIds: ["current"] }],
    ticketTitle: "Échec de connexion du client", ticketDescription: "Le client signale que sa connexion échoue.",
    identity: { kind: "unique", contactIds: [data.contacts[0]?.contactId].filter(Boolean), why: "Expéditeur." },
    tickets: data.tickets.map(t => ({ ticketId: t.ticketId, relation: "same", why: "Même panne de connexion.", sourceIds: ["current", `ticket-${t.ticketId}`] })),
    missing: [], rationale: "Panne de connexion.", ...over });
async function observedSimple(answer: (data: SimpleData) => Record<string, unknown>) {
    const runtime = options.runtime, id = (await enqueueSavIntakeMessage(messageId, runtime))!, lease = (await claimSavIntakeRun(id, runtime))!;
    const crm = memoizeIntakeCrmReaders(createSavIntakeHubspotReaders({ network: p.network }));
    const call: IntakeGeminiCall = async request => ({ json: encodeSimpleWireFixture(answer(JSON.parse(request.body.contents[0].parts[0].text) as SimpleData), (JSON.parse(request.body.contents[0].parts[0].text) as SimpleData).outputReferences),
        metadata: { inputTokens: 100, outputTokens: 20, thoughtTokens: 0, totalTokens: 120 } });
    const semantic = createSavIntakeSimpleReaders({ model: "gemini-3.6-flash", call, crm, policy: runtime.policy, provenance: lease.provenance });
    const plan = await planSavIntake(lease.input, { ...crm, ...semantic }, runtime.policy, {}, () => new Date());
    // As the runtime does: the pipeline fixed at the run's creation stays in its payload.
    const pipeline = decryptSavPayload<{ pipeline?: "simple" }>(lease.run.payloadCiphertext).pipeline;
    await saveSavIntakeResult(lease, runtime, { revision: SAV_INTAKE_RUNTIME_REVISION, effects: "not_connected", plan, input: lease.input, ...(pipeline ? { pipeline } : {}) },
        plan.decision.disposition.kind === "collect_context" ? "waiting" : "observed");
    return { id, plan };
}
const writes = () => p.calls.filter(c => ["PUT", "PATCH", "DELETE"].includes(c.method) || c.method === "POST" && !c.path.endsWith("/search") && !c.path.endsWith("/read"));
it("simple reader → executor: creates the ticket with the simple title, no owner, from email", async () => {
    const { id, plan } = await observedSimple(d => simpleAnswer(d));
    expect(plan.newTicket).toMatchObject({ title: "Échec de connexion du client", owner: "leave_unassigned" });
    const row = (await admitIntakeExecution(id, options))!;
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    const create = p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"));
    expect(create).toHaveLength(1);
    const properties = (create[0].body as { properties: Record<string, string> }).properties;
    expect(properties.subject).toBe("Échec de connexion du client");
    expect(properties.source_type).toBe("EMAIL");
    expect(properties).not.toHaveProperty("hubspot_owner_id");
});
// Composition SAV-72 × compact reader v4: the wire rebuilds a planner description from the
// request summaries; the CRM description stays the original incoming email, never those summaries.
it("SAV-72 compact reader → executor: the created description is the original email, not the rebuilt summaries", async () => {
    const text = "Bonjour,\n\nLa connexion échoue depuis ce matin sur deux postes.\nL'export reste aussi bloqué.\n\nCordialement,\nClient Exemple\n\nLe 1 oct. 2026 à 09:00, Support <support@example.invalid> a écrit :\n> Ancienne réponse citée";
    await f.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ text, headers: { "message-id": "<incoming@example.invalid>" }, attachments: [] }) }).where(eq(savMessages.id, messageId));
    const { id, plan } = await observedSimple(d => simpleAnswer(d, { requests: [
        { id: "r1", kind: "support", summary: "Résumé modèle connexion.", sourceIds: ["current"] },
        { id: "r2", kind: "support", summary: "Résumé modèle export.", sourceIds: ["current"] }] }));
    // The compact wire did rebuild the planner description from every summary.
    expect(plan.newTicket?.description).toContain("Résumé modèle connexion.\nRésumé modèle export.");
    const row = (await admitIntakeExecution(id, options))!;
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    const create = p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"));
    expect(create).toHaveLength(1);
    const content = (create[0].body as { properties: Record<string, string> }).properties.content;
    expect(content).toBe(`Objet : Synthetic connection failure\n\nBonjour,\n\nLa connexion échoue depuis ce matin sur deux postes.\nL'export reste aussi bloqué.\n\nCordialement,\nClient Exemple\n\n[Historique cité non recopié : il reste dans l'email associé au ticket.]\n\n[Studio intake: ${intakeRuntimeHash(`create:${messageId}`)}]`);
    expect(content).not.toContain("Résumé modèle");
    expect(content).not.toContain("Ancienne réponse citée");
    expect(Object.values(p.objects.tickets).map(t => t.properties.content)).toContain(content);
});
it.each([["open", undefined], ["closed", 3]] as const)("simple reader → executor: a relevant %s ticket goes back to New and keeps its owner", async (stage, closedDays) => {
    p.seedTicket({ stage, ownerId: "777", createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString(), ...(closedDays ? { closedAt: new Date(Date.now() - closedDays * 86_400_000).toISOString() } : {}) });
    const { id, plan } = await observedSimple(d => simpleAnswer(d));
    expect(plan.decision.disposition).toMatchObject({ kind: "ticket", target: { operation: stage === "closed" ? "reopen" : "link", ticketId: "201" } });
    const row = (await admitIntakeExecution(id, options))!;
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    const patches = p.calls.filter(c => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ properties: { hs_pipeline_stage: "1" } });
    expect(p.objects.tickets["201"].properties.hubspot_owner_id).toBe("777");
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(0);
});
it("simple reader → executor: a same-issue ticket closed 16 days ago gives a new ticket, the old one untouched", async () => {
    p.seedTicket({ stage: "closed", ownerId: "777", createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString(), closedAt: new Date(Date.now() - 16 * 86_400_000).toISOString() });
    const { id, plan } = await observedSimple(d => simpleAnswer(d));
    expect(plan.decision.disposition).toMatchObject({ kind: "ticket", target: { operation: "create", predecessor: { ticketId: "201" } } });
    const row = (await admitIntakeExecution(id, options))!;
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
    expect(p.calls.filter(c => c.method === "PATCH" && c.path.includes("/tickets/201"))).toHaveLength(0);
});
it("simple reader → executor: missing indispensable evidence is never admitted and nothing is written", async () => {
    p.seedTicket({ stage: "open" });
    const { id, plan } = await observedSimple(d => simpleAnswer(d, { missing: [{ kind: "image", why: "La capture citée par le client est illisible." }] }));
    expect(plan.steps).toEqual([]);
    expect(await admitIntakeExecution(id, options)).toBeNull();
    expect(writes()).toHaveLength(0);
});
it("simple reader → executor: a run created on simple keeps its execution after the switch really flips to current, without replay", async () => {
    // The run is created while the switch says simple.
    environment = { ...environment, SAV_INTAKE_PIPELINE: "simple" };
    options.runtime = savIntakeRuntimeConfig(environment)!;
    const { id } = await observedSimple(d => simpleAnswer(d));
    const [created] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, id));
    expect(decryptSavPayload<{ pipeline?: string }>(created.payloadCiphertext).pipeline).toBe("simple");
    const row = (await admitIntakeExecution(id, options))!;
    // After admission the environment really flips back to current.
    const before = options.runtime.configHash;
    environment = { ...environment, SAV_INTAKE_PIPELINE: "current" };
    options.runtime = savIntakeRuntimeConfig(environment)!;
    expect(options.runtime.pipeline).toBe("current");
    expect(options.runtime.configHash).toBe(before);
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    const confirmed = (await getExecutionEffects(row.id)).filter(e => e.state === "confirmed").map(e => e.id).sort();
    const writesAfterFirst = writes().length;
    // Running the same execution again never re-dispatches a confirmed effect.
    await executeIntakePass(row.id, options);
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
    expect(writes()).toHaveLength(writesAfterFirst);
    expect((await getExecutionEffects(row.id)).filter(e => e.state === "confirmed").map(e => e.id).sort()).toEqual(confirmed);
});

// ---- SAV-45 A: typed CRM diagnostics from the first check, exposed to the admin diagnostic.
import { recordIntakeCrmReads, intakeCrmEvidenceFingerprint } from "./crm-evidence-fingerprint";
import { readIntakeRunDiagnostics } from "./run-diagnostics";
/** Same as observed(), with the read recorder the runtime now uses. */
async function observedRecorded(mid = messageId) {
    const runtime = options.runtime, id = (await enqueueSavIntakeMessage(mid, runtime))!, lease = (await claimSavIntakeRun(id, runtime))!;
    const recorded = recordIntakeCrmReads(createSavIntakeHubspotReaders({ network: p.network }));
    const plan = await planSavIntake(lease.input, { ...recorded.readers,
        analyseMessage: async () => ({ messageId: mid, requests: [{ id: "r1", kind: "support", currentMessageId: mid }], ticketSummary: { title: "Synthetic connection failure", description: "The synthetic connection fails.", requestIds: ["r1"] } }),
        assessIssues: async ({ tickets, requests }) => ({ investigationComplete: true, tickets: tickets.map(({ ticket: t }) => ({ ticketId: t.id, relation: "same", requestIds: requests.map(r => r.id), evidenceIds: ["current", `ticket-${t.id}`, `history-${t.id}`] })) }),
    }, runtime.policy, {}, () => new Date());
    await saveSavIntakeResult(lease, runtime, { revision: SAV_INTAKE_RUNTIME_REVISION, effects: "not_connected", plan, input: lease.input, crmEvidence: intakeCrmEvidenceFingerprint(plan, recorded.snapshots()) }, "observed");
    return id;
}
const executionPayload = async (id: string) => decryptSavPayload<import("./execution-types").ExecutionPayload>((await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, id)))[0].payloadCiphertext);
it("SAV-45 A: a first-check description change names ticket.content from the analysis fingerprint and stays blocked; an owner change alone is traced", async () => {
    p.seedTicket({ stage: "open" });
    runId = await observedRecorded();
    const row = (await admitIntakeExecution(runId, options))!;
    const original = (await executionPayload(row.id)).originalCrm!;
    expect(Object.keys(original.entries)).toEqual(expect.arrayContaining(["email-lookup", "contact-101", "ticket-201", "history-201", "ticket-search-101"]));
    // Digest-only: no customer text or address is kept in the fingerprint.
    expect(JSON.stringify(original)).not.toMatch(/Synthetic full request|Synthetic connection failure|customer@example\.invalid/);
    p.objects.tickets["201"].properties.hubspot_owner_id = "999";
    p.objects.tickets["201"].properties.content = "Description changed by the team";
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "waiting", reason: "SAV_INTAKE_EXECUTION_CRM_CHANGED" });
    expect(await getExecutionEffects(row.id)).toHaveLength(0);
    expect((await readIntakeExecutionProgress(messageId))?.crmDelta).toMatchObject({ stage: "original", reason: "original_evidence_changed", classification: "business_change", fieldsKnown: true,
        ticketIds: ["201"], fields: expect.arrayContaining(["ticket.content", "tickets"]), evidence: expect.arrayContaining([{ id: "ticket-201", category: "ticket", state: "changed" }]) });
    // The decision now belongs to a person: restoring the description does not lift it (review P1).
    p.objects.tickets["201"].properties.content = "Synthetic full request";
    expect(await executeIntakePass(row.id, options)).toMatchObject({ skipped: "crm_review_required" });
    expect(await getExecutionEffects(row.id)).toHaveLength(0);
});
it("SAV-45 D1: an owner change alone does not alter the choice; it is traced and the dossier proceeds", async () => {
    p.seedTicket({ stage: "open" });
    runId = await observedRecorded();
    const row = (await admitIntakeExecution(runId, options))!;
    p.objects.tickets["201"].properties.hubspot_owner_id = "999";
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    expect((await f.db.select().from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId, row.id))).some(j => j.kind === "crm_change_ignored")).toBe(true);
});
it("SAV-45 A: an analysis recorded before the fingerprint keeps the typed refusal with an explicitly unknown detail", async () => {
    p.seedTicket({ stage: "open" });
    const row = await admission();
    expect((await executionPayload(row.id)).originalCrm).toBeUndefined();
    p.objects.tickets["201"].properties.hubspot_owner_id = "999";
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "waiting", reason: "SAV_INTAKE_EXECUTION_CRM_CHANGED" });
    expect((await readIntakeExecutionProgress(messageId))?.crmDelta).toMatchObject({ stage: "original", fieldsKnown: false, classification: "unknown", fields: ["tickets"] });
});
it("SAV-45 A: an automation owner set on the ticket Studio created no longer stops the remaining actions; it is traced", async () => {
    const row = await admission(), verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "ticket_create" && proof.confirmed) p.objects.tickets[proof.ack!.id!].properties.hubspot_owner_id = "999";
        return proof;
    };
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
    expect((await f.db.select().from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId, row.id))).some(j => j.kind === "crm_change_ignored")).toBe(true);
});
it("SAV-45 A: a human note on the created ticket is traced with its event id, not refused", async () => {
    const row = await admission(), verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "ticket_create" && proof.confirmed) {
            p.objects.notes["777"] = { id: "777", properties: { hs_note_body: "Synthetic human note", hs_timestamp: new Date().toISOString() } };
            p.links.set(`tickets:${proof.ack!.id!}:notes`, ["777"]);
        }
        return proof;
    };
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    const ignored = (await f.db.select().from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId, row.id))).filter(j => j.kind === "crm_change_ignored");
    expect(ignored.map(j => decryptSavPayload<{ changes: { eventIds: string[]; fields: string[] }[] }>(j.payloadCiphertext).changes).flat()).toEqual(expect.arrayContaining([expect.objectContaining({ eventIds: ["notes:777"], fields: expect.arrayContaining(["history.added_note"]) })]));
});
it("SAV-45 A: the admin diagnostic exposes the execution, its passes, delta and next step without customer text", async () => {
    p.seedTicket({ stage: "open" });
    runId = await observedRecorded();
    const row = (await admitIntakeExecution(runId, options))!;
    p.objects.tickets["201"].properties.content = "Description changed by the team";
    await executeIntakePass(row.id, options);
    const diagnostics = await readIntakeRunDiagnostics(threadId);
    expect(diagnostics?.execution).toMatchObject({ readable: true, state: "waiting", reason: "SAV_INTAKE_EXECUTION_CRM_CHANGED", waitingPasses: 1, originalCrmRecorded: true, nextStep: "human_decision",
        crmDelta: { reason: "original_evidence_changed", classification: "business_change" }, effects: [] });
    expect(JSON.stringify(diagnostics?.execution)).not.toMatch(/customer@example\.invalid|Synthetic full request|synthetic connection fails/i);
});

// ---- SAV-45 B: bounded, durable CRM rechecks that keep every confirmed effect.
type Shape = { name: string; seed?: "open"; cut: (confirmed: string[], planned: string[]) => boolean };
const shapes: Shape[] = [
    { name: "note created, association planned", seed: "open", cut: (c, p) => c.join() === "note_create" && p.includes("note_associate") },
    { name: "nothing sent yet", cut: (c, p) => !c.length && !p.length },
    { name: "note associated, email not created", seed: "open", cut: (c, p) => c.join() === "note_associate,note_create" && !p.length },
    { name: "note created only", seed: "open", cut: (c, p) => c.join() === "note_create" && !p.length },
    { name: "ticket, email and association confirmed, finalization blocked", cut: (c, p) => ["email_associate", "email_create", "ticket_create"].every(k => c.includes(k)) && !p.length },
    { name: "ticket created only", cut: (c, p) => c.join() === "ticket_create" && !p.length },
];
/** One transient CRM read failure at the chosen point of the execution. */
function cutReadOnce(rowId: string, when: Shape["cut"]) {
    const readCrm = options.adapters.readCrm;
    let cut = false;
    options.adapters.readCrm = async (...args) => {
        const effects = await getExecutionEffects(rowId);
        if (!cut && when(effects.filter(e => e.state === "confirmed").map(e => e.kind).sort(), effects.filter(e => e.state === "planned").map(e => e.kind))) {
            cut = true; throw Error("SAV_INTAKE_EXECUTION_CRM_READ_UNAVAILABLE");
        }
        return readCrm(...args);
    };
    return () => cut;
}
// HubSpot reads also use POST (search, batch/read): only mutations are counted.
const providerWrites = () => p.calls.filter(c => ["POST", "PUT", "PATCH", "DELETE"].includes(c.method) && !/\/(?:search|batch\/read)$/.test(c.path)).map(c => `${c.method} ${c.path}`);
it.each(shapes)("SAV-45 B: $name — the same execution resumes without replaying any confirmed effect", async shape => {
    if (shape.seed) p.seedTicket({ stage: shape.seed });
    const row = await admission(), cut = cutReadOnce(row.id, shape.cut);
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "waiting", reason: "SAV_INTAKE_EXECUTION_CRM_READ_UNAVAILABLE" });
    expect(cut()).toBe(true);
    const before = await getExecutionEffects(row.id), progress = await readIntakeExecutionProgress(messageId);
    expect(progress?.crmRecheck).toMatchObject({ attempts: 1, humanRequired: false, cause: "read_incomplete" });
    expect(before.every(e => ["planned", "confirmed"].includes(e.state))).toBe(true);
    // Before the due date, a direct pass (wake or cron alike) is refused at the claim.
    expect(await executeIntakePass(row.id, options)).toMatchObject({ skipped: "crm_recheck_pending" });
    expect(await getExecutionEffects(row.id)).toEqual(before);
    await age(row.id, 61_000);
    const aged = await getExecutionEffects(row.id);
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    const after = await getExecutionEffects(row.id);
    for (const old of aged.filter(e => e.state === "confirmed")) expect(after.find(e => e.id === old.id)).toEqual(old);
    expect(after.every(e => e.state === "confirmed")).toBe(true);
    // Each provider write happened once: no POST/PUT/PATCH of a confirmed effect is replayed.
    expect(new Set(providerWrites()).size).toBe(providerWrites().length);
    expect(p.calls.filter(c => c.path === "gmail/messages/send")).toHaveLength(0);
    expect((await readIntakeExecutionProgress(messageId))?.crmRecheck).toBeUndefined();
});
/** Ages the execution and its CRM schedule as if minutes had passed, without a clock fake. */
async function age(rowId: string, ms: number) {
    await f.client.exec(`UPDATE sav.intake_executions SET updated_at = updated_at - interval '${ms} milliseconds' WHERE id='${rowId}';
        UPDATE sav.intake_effect_journal SET created_at = created_at - interval '${ms} milliseconds' WHERE execution_id='${rowId}';
        UPDATE sav.intake_effects SET confirmed_at = confirmed_at - interval '${ms} milliseconds', created_at = created_at - interval '${ms} milliseconds' WHERE execution_id='${rowId}';
        UPDATE sav.intake_runs SET created_at = created_at - interval '${ms} milliseconds' WHERE message_id=(SELECT message_id FROM sav.intake_executions WHERE id='${rowId}')`);
}
const selected = async () => {
    const result = await reconcileIntakeExecutor({ env: () => environment, adapters: options.adapters });
    return "executionId" in result ? result.executionId : null;
};
it("SAV-45 B: a persistent read failure is rechecked with growing delays, five times at most, then left to a person", async () => {
    const row = await admission();
    options.adapters.readCrm = async () => { throw Error("SAV_INTAKE_EXECUTION_CRM_READ_UNAVAILABLE"); };
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "waiting" });
    for (let attempt = 1; attempt < 5; attempt++) {
        const delay = 60_000 * 2 ** (attempt - 1);
        await age(row.id, delay - 5_000);
        expect(await selected()).toBeNull();
        await age(row.id, 6_000);
        expect(await selected()).toBe(row.id);
        expect((await readIntakeExecutionProgress(messageId))?.crmRecheck).toMatchObject({ attempts: attempt + 1, humanRequired: attempt + 1 >= 5 });
    }
    // Bound reached: the schedule is durable in the journal, it is never selected again on its own.
    await age(row.id, 24 * 3_600_000);
    expect(await selected()).toBeNull();
    const diagnostics = await readIntakeRunDiagnostics(threadId);
    expect(diagnostics?.execution).toMatchObject({ nextStep: "human_decision", crmRecheck: { attempts: 5, max: 5, humanRequired: true, nextAt: null } });
    expect(await getExecutionEffects(row.id)).toHaveLength(0);
});
it("SAV-45 B: a real business change goes to a person at once and does not hold back another dossier", async () => {
    p.seedTicket({ stage: "open" });
    runId = await observedRecorded();
    const row = (await admitIntakeExecution(runId, options))!;
    p.objects.tickets["201"].properties.content = "Description changed by the team";
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "waiting", reason: "SAV_INTAKE_EXECUTION_CRM_CHANGED" });
    expect((await readIntakeExecutionProgress(messageId))?.crmRecheck).toMatchObject({ attempts: 0, humanRequired: true, cause: "business_change" });
    await age(row.id, 3_600_000);
    expect(await selected()).toBeNull();
    const journal = await f.db.select().from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId, row.id));
    expect(journal.filter(j => j.kind === "crm_review_required")).toHaveLength(1);
    expect(journal.filter(j => j.kind === "pass_waiting")).toHaveLength(1);
    // Another dossier of another customer is still selected and processed.
    const otherThread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: "gmail-thread-2", customerEmail: "customer@example.invalid" }).returning())[0].id;
    const other = await storedMessage(otherThread);
    p.setGmail(other.gmailMessageId!, "gmail-thread-2");
    const before = providerWrites().length;
    expect(before).toBe(0);
    const otherRun = await observed(other.id), otherRow = await admitIntakeExecution(otherRun, options);
    expect(otherRow).not.toBeNull();
    await age(otherRow!.id, 120_000);
    expect(await selected()).toBe(otherRow!.id);
    expect((await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, otherRow!.id)))[0].state).toBe("confirmed");
    // The dossier left to a person received no write; only the other one was processed.
    expect(await getExecutionEffects(row.id)).toHaveLength(0);
});
it("SAV-45 B: progress opens a new episode — the recheck count restarts after a confirmed effect", async () => {
    p.seedTicket({ stage: "open" });
    const row = await admission();
    cutReadOnce(row.id, (c, p) => !c.length && !p.length);
    await executeIntakePass(row.id, options);
    expect((await readIntakeExecutionProgress(messageId))?.crmRecheck).toMatchObject({ attempts: 1 });
    cutReadOnce(row.id, c => c.join() === "note_create");
    await age(row.id, 61_000);
    await executeIntakePass(row.id, options);
    expect((await getExecutionEffects(row.id)).filter(e => e.state === "confirmed").map(e => e.kind)).toEqual(["note_create"]);
    expect((await readIntakeExecutionProgress(messageId))?.crmRecheck).toMatchObject({ attempts: 1, humanRequired: false });
});
it("SAV-45 B: a newer analysis run reopens a dossier left to a person, without resetting the ledger", async () => {
    p.seedTicket({ stage: "open" });
    runId = await observedRecorded();
    const row = (await admitIntakeExecution(runId, options))!;
    p.objects.tickets["201"].properties.content = "Description changed by the team";
    await executeIntakePass(row.id, options);
    await age(row.id, 3_600_000);
    expect(await selected()).toBeNull();
    // A person asks for a new analysis: a newer current run of the same message exists.
    await f.client.exec(`UPDATE sav.intake_runs SET is_current=false WHERE id='${runId}'`);
    await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: 2, attempts: 0, isCurrent: true, state: "pending", configHash: "c".repeat(64), policyHash: options.runtime.policyHash, payloadCiphertext: encryptSavPayload({ revision: SAV_INTAKE_RUNTIME_REVISION, effects: "not_connected" }) });
    expect(await selected()).toBe(row.id);
    const journal = await f.db.select().from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId, row.id));
    expect(journal.filter(j => j.kind === "admitted")).toHaveLength(1);
    expect(providerWrites()).toHaveLength(0);
});

// ---- SAV-45 C: a confirmed execution whose follow-up is not bound says why.
import { ensureIntakeObservations } from "./observation-binding";
it("SAV-45 C: the follow-up of confirmed effects is bound, or held by a named condition, without any new CRM write", async () => {
    await f.db.insert(savSyncState).values({ key: "sav-intake-console-schema-v1", status: "installed" }).onConflictDoUpdate({ target: savSyncState.key, set: { status: "installed" } });
    const row = await admission();
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    const writesBefore = p.calls.filter(c => ["PUT", "PATCH"].includes(c.method) || c.method === "POST" && !/\/(?:search|batch\/read)$/.test(c.path)).length;
    // A newer customer message arrives: the follow-up of the older execution is held, with its reason.
    await storedMessage(threadId, new Date(Date.now() + 1000));
    expect(await ensureIntakeObservations()).toMatchObject({ created: 0 });
    expect((await readIntakeRunDiagnostics(threadId))?.execution).toBeNull();
    const [execution] = await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, row.id));
    const { intakeObservationBlocker } = await import("./observation-binding");
    expect((await f.db.transaction(tx => intakeObservationBlocker(tx, execution.id))).blocker).toBe("newer_inbound");
    expect(p.calls.filter(c => ["PUT", "PATCH"].includes(c.method) || c.method === "POST" && !/\/(?:search|batch\/read)$/.test(c.path))).toHaveLength(writesBefore);
});
it("SAV-45 C: with nothing holding it, the same scan binds the follow-up and the diagnostic shows it", async () => {
    await f.db.insert(savSyncState).values({ key: "sav-intake-console-schema-v1", status: "installed" }).onConflictDoUpdate({ target: savSyncState.key, set: { status: "installed" } });
    const row = await admission();
    await executeIntakePass(row.id, options);
    expect((await readIntakeRunDiagnostics(threadId))?.execution?.followup).toMatchObject({ bound: false, blocker: "scan_pending" });
    expect(await ensureIntakeObservations()).toMatchObject({ created: 1 });
    expect((await readIntakeRunDiagnostics(threadId))?.execution?.followup).toMatchObject({ bound: true, observationState: "pending_first_sync" });
});

// Independent review probes for SAV-45, synthetic database/provider only.
import { executeSavIntakeWake as reviewExecuteWake } from "./event-pipeline";
it("REVIEW45 wake honors a scheduled CRM recheck before acquiring the execution", async () => {
    const row = await admission();
    let reads = 0;
    options.adapters.readCrm = async () => { reads++; throw Error("SAV_INTAKE_EXECUTION_CRM_READ_UNAVAILABLE"); };
    expect(await executeIntakePass(row.id, options)).toMatchObject({state:"waiting"});
    expect((await readIntakeExecutionProgress(messageId))?.crmRecheck).toMatchObject({attempts:1,humanRequired:false});
    expect(reads).toBe(1);
    environment.SAV_INTAKE_EVENT_DISPATCH = "on";
    await reviewExecuteWake(runId, { env:()=>environment, adapters: options.adapters });
    // A fresh wake is merely a hint; it cannot move a durable due date forward.
    expect(reads).toBe(1);
    expect((await readIntakeExecutionProgress(messageId))?.crmRecheck?.attempts).toBe(1);
});
it("REVIEW45 wake does not bypass an explicit CRM human-decision hold", async () => {
    p.seedTicket({stage:"open"});
    runId = await observedRecorded();
    const row = (await admitIntakeExecution(runId, options))!;
    const content = p.objects.tickets["201"].properties.content;
    p.objects.tickets["201"].properties.content = "Synthetic different choice";
    expect(await executeIntakePass(row.id, options)).toMatchObject({state:"waiting",reason:"SAV_INTAKE_EXECUTION_CRM_CHANGED"});
    expect((await readIntakeExecutionProgress(messageId))?.crmRecheck).toMatchObject({humanRequired:true});
    p.objects.tickets["201"].properties.content = content;
    environment.SAV_INTAKE_EVENT_DISPATCH = "on";
    await reviewExecuteWake(runId,{env:()=>environment,adapters:options.adapters});
    // No new analysis or human approval occurred after the review-required marker.
    expect(providerWrites()).toHaveLength(0);
    expect((await readIntakeExecutionProgress(messageId))?.state).toBe("waiting");
});

// ---- SAV-45 E: witnesses of the claim gate (review P1). Same real engine, executor and provider.
it("SAV-45 E: once the recheck is due, a wake rereads the CRM and the dossier proceeds", async () => {
    const row = await admission();
    let reads = 0;
    const readCrm = options.adapters.readCrm;
    options.adapters.readCrm = async (...args) => { if (++reads === 1) throw Error("SAV_INTAKE_EXECUTION_CRM_READ_UNAVAILABLE"); return readCrm(...args); };
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "waiting" });
    await age(row.id, 61_000);
    environment.SAV_INTAKE_EVENT_DISPATCH = "on";
    await reviewExecuteWake(runId, { env: () => environment, adapters: options.adapters });
    expect(reads).toBeGreaterThan(1);
    expect((await readIntakeExecutionProgress(messageId))?.state).toBe("confirmed");
});
it("SAV-45 E: only a newer analysis lifts a human hold, through the wake as through the cron", async () => {
    p.seedTicket({ stage: "open" });
    runId = await observedRecorded();
    const row = (await admitIntakeExecution(runId, options))!;
    p.objects.tickets["201"].properties.content = "Description changed by the team";
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "waiting", reason: "SAV_INTAKE_EXECUTION_CRM_CHANGED" });
    await age(row.id, 24 * 3_600_000);
    expect(await executeIntakePass(row.id, options)).toMatchObject({ skipped: "crm_review_required" });
    expect(providerWrites()).toHaveLength(0);
    await f.client.exec(`UPDATE sav.intake_runs SET is_current=false WHERE id='${runId}'`);
    await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: 2, attempts: 0, isCurrent: true, state: "pending", configHash: "d".repeat(64), policyHash: options.runtime.policyHash, payloadCiphertext: encryptSavPayload({}) });
    // The claim now passes; the executor's own version checks decide what follows, unchanged.
    const pass = await executeIntakePass(row.id, options) as { skipped?: string };
    expect(pass.skipped).toBeUndefined();
    expect((await f.db.select().from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId, row.id))).filter(j => j.kind === "admitted")).toHaveLength(1);
});
it("SAV-45 E: read-only recovery of an uncertain effect is not held by a CRM decision and never dispatches", async () => {
    const row = await admission(), dispatch = options.adapters.dispatch;
    options.adapters.dispatch = async (...args) => { await dispatch(...args); throw Error("LOST_ACK"); };
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "uncertain" });
    await f.db.insert(savIntakeEffectJournal).values({ executionId: row.id, kind: "crm_review_required", payloadCiphertext: encryptSavPayload({ synthetic: true }) });
    await f.db.update(savIntakeEffects).set({ nextReconcileAt: null }).where(eq(savIntakeEffects.executionId, row.id));
    options.adapters.dispatch = async () => { throw Error("DISPATCH_FORBIDDEN_IN_RECOVERY"); };
    await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
    expect((await getExecutionEffects(row.id))[0].state).toBe("confirmed");
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
});

// ---- SAV-11/SAV-44 (pôle A, 28/10, contract v9 30/10): V2 owner through this ledger, and the V1 → V2 relay.
// Same real engine, executor, adapters and provider; the case store, port and relay are the real ones.
import { listCaseEvents, readCaseByTicket } from "../cases/case-store";
import { caseDedupeKey, caseRequestSearchText, type CaseAdmissionQualification } from "../cases/case-types";
import { recordAcceptedIntakeSemantics, SAV_INTAKE_SEMANTIC_RECORD_REVISION, type AcceptedIntakeSemantics } from "./semantic-records";
import { SAV_INTAKE_MODEL_REVISION } from "./model-readers";
import { recordCaseAfterConfirmedIntake, sweepCaseRelays, type CaseBoundaryDeps } from "../cases/intake-boundary";
import { v2OwnerAtCreationPort, v2OwnerAttributionAdapter } from "../cases/owner-attribution";
const V2_OWNER = "90000001", HUMAN_OWNER = "70000001";
const V2_POLICY = { revision: "policy-r1", admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: "20000000-0000-4000-8000-000000000001", approvedAt: "2026-10-28T08:00:00.000Z" };
const ownerWrites = () => p.calls.filter(c => c.method === "PATCH" && (c.body as { properties?: Record<string, unknown> })?.properties && "hubspot_owner_id" in (c.body as { properties: Record<string, unknown> }).properties);
/** The deps the ROOT/C seam must give both the port and the relay: the same policy and the same
 * qualification, so the V2 owner is asked for exactly the entries the relay will admit. */
function v2Deps(family: "access" | "finance" = "access"): CaseBoundaryDeps {
    return {
        env: { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" }, readAdmissionPolicy: async () => V2_POLICY,
        readQualification: async ({ requests }): Promise<CaseAdmissionQualification> => ({
            requests: requests.map(request => ({ requestId: request.requestId, family, provenance: { kind: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000001", at: "2026-10-28T08:00:00.000Z" } })),
            identity: { status: "confirmed", source: { type: "hubspot_object", id: "101" } }, crmContext: "complete", teamSignals: [],
        }),
    };
}
function v2Port(asked: { n: number }, deps = v2Deps(), before?: () => void) {
    // Built as the adapter factory would: the executed message comes from the decision, not from the test.
    const port = v2OwnerAttributionAdapter({ ...deps, readTicketOwner: async ticketId => (p.objects.tickets[ticketId]?.properties.hubspot_owner_id as string | null | undefined) ?? null });
    return async (input: Parameters<typeof port>[0]) => {
        asked.n++;
        const decided = await port(input);
        before?.();
        return decided;
    };
}
describe("SAV-11 A: V1 → V2 owner and relay", () => {
    // The file's setup keeps the V2 case tables, and these tests all use ticket 201: each starts with none.
    beforeEach(async () => { await f.client.exec("TRUNCATE sav.cases, sav.case_events, sav.case_timers CASCADE"); });
    it("SAV-11 A: without the V2 permission in the policy, V1 confirms exactly as before and the port is never asked", async () => {
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        p.seedTicket({ stage: "open" });
        const asked = { n: 0 };
        options.adapters.v2OwnerAttribution = v2Port(asked);
        const row = await admission();
        expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
        expect(asked.n).toBe(0);
        expect(ownerWrites()).toHaveLength(0);
        expect((await getExecutionEffects(row.id)).map(e => e.kind)).not.toContain("owner_assign");
    });
    it("SAV-11 A R1: a new ticket created without owner stays without owner even with the permission and a positive decision; the port is never asked and the case stays the team's", async () => {
        await writePolicy([...mutations, "assign_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        const asked = { n: 0 };
        options.adapters.v2OwnerAttribution = v2Port(asked);
        const row = await admission();
        expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
        const effects = await getExecutionEffects(row.id);
        expect(effects.map(e => e.kind)[0]).toBe("ticket_create");
        expect(effects.map(e => e.kind)).not.toContain("owner_assign");
        expect(asked.n).toBe(0);
        const ticketId = (await readIntakeExecutionProgress(messageId))!.ticketId!;
        const creation = p.calls.find(c => c.method === "POST" && c.path.endsWith("/tickets"))!;
        expect((creation.body as { properties: Record<string, unknown> }).properties.hubspot_owner_id).toBeUndefined();
        expect(ownerWrites()).toHaveLength(0);
        expect(p.objects.tickets[ticketId].properties.hubspot_owner_id).toBeFalsy();
        // Admitted on the V2 side, but without a verified V2 owner the case stays with the team.
        expect(await recordCaseAfterConfirmedIntake(messageId, v2Deps())).toMatchObject({ created: true, owner: "human", admission: { target: "agent" } });
        expect((await readCaseByTicket(ticketId))!.phase).toBe("handoff_pending");
        expect(await executeIntakePass(row.id, options)).toMatchObject({ skipped: "occupied" });
        expect(ownerWrites()).toHaveLength(0);
    });
    it("SAV-11 A v9: an existing human owner is never captured, keeps the ticket through « Nouveau », and its case never reaches the agent", async () => {
        await writePolicy([...mutations, "assign_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        p.seedTicket({ stage: "open", ownerId: HUMAN_OWNER });
        options.adapters.v2OwnerAttribution = v2Port({ n: 0 });
        const row = await admission();
        expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
        expect(p.calls.filter(c => c.method === "PATCH").map(c => c.body)).toEqual([{ properties: { hs_pipeline_stage: "1" } }]);
        expect(p.objects.tickets["201"].properties).toMatchObject({ hubspot_owner_id: HUMAN_OWNER, hs_pipeline_stage: "1" });
        expect((await getExecutionEffects(row.id)).map(e => e.kind)).not.toContain("owner_assign");
        // Admitted on the V2 side, but without the verified V2 owner the case stays with the team.
        expect(await recordCaseAfterConfirmedIntake(messageId, v2Deps())).toMatchObject({ owner: "human", admission: { target: "agent" } });
        expect((await readCaseByTicket("201"))!.phase).toBe("handoff_pending");
    });
    it("SAV-11 A v9: finance, cancellation or a mixed mail never gets the V2 owner, whatever the qualification port says", async () => {
        await writePolicy([...mutations, "assign_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        p.seedTicket({ stage: "open" });
        options.adapters.v2OwnerAttribution = v2Port({ n: 0 }, v2Deps("finance"));
        const row = await admission();
        expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
        expect(ownerWrites()).toHaveLength(0);
        expect(await recordCaseAfterConfirmedIntake(messageId, v2Deps("finance"))).toMatchObject({ owner: "human", admission: { target: "team" } });
    });
    // Review R1 (31/10): HubSpot has no conditional PATCH, so a read then a write let a human who took
    // the ticket in between be overwritten. Same window as the review's two reproductions, on this head.
    const humanTakesTicketAtEachRead = (reads: { n: number }): typeof fetch => async (url, init) => {
        const response = await p.network(url, init);
        if (new URL(String(url)).pathname === "/crm/v3/objects/tickets/201" && (init?.method ?? "GET") === "GET") {
            reads.n++;
            p.objects.tickets["201"].properties.hubspot_owner_id = HUMAN_OWNER;
        }
        return response;
    };
    it("SAV-11 A R1: the adapter refuses an owner write before any call, so the review's read-then-write window cannot overwrite a human", async () => {
        p.seedTicket({ stage: "open" });
        const reads = { n: 0 }, before = p.calls.length;
        const adapters = createIntakeExecutorAdapters({ network: humanTakesTicketAtEachRead(reads), gmailRequest: p.gmail, gmailPermissions: async () => {}, env: () => environment });
        await expect(adapters.dispatch({ kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${messageId}:201`, ticketId: "201", sourceMessageId: messageId, expectedOwnerId: null,
            properties: { hubspot_owner_id: V2_OWNER } }, AbortSignal.timeout(1000))).rejects.toThrow("SAV_INTAKE_EXECUTION_OWNER_UNGUARDED");
        expect(reads.n).toBe(0);
        expect(p.calls).toHaveLength(before);
        expect(ownerWrites()).toHaveLength(0);
        expect(p.objects.tickets["201"].properties.hubspot_owner_id).toBeNull();
    });
    it("SAV-11 A R1: through the real engine, a human who takes the ticket after a read keeps it; no owner effect, and the case never reaches the agent", async () => {
        await writePolicy([...mutations, "assign_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        p.seedTicket({ stage: "open" });
        const asked = { n: 0 }, reads = { n: 0 };
        options.adapters.v2OwnerAttribution = v2Port(asked);
        const race = createIntakeExecutorAdapters({ network: humanTakesTicketAtEachRead(reads), gmailRequest: p.gmail, gmailPermissions: async () => {}, env: () => environment });
        options.adapters.dispatch = race.dispatch;
        options.adapters.verify = race.verify;
        const row = await admission();
        expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
        // The window did open: the stage check read the ticket and the human took it right then.
        expect(reads.n).toBeGreaterThan(0);
        expect(asked.n).toBe(0);
        expect((await getExecutionEffects(row.id)).map(e => e.kind)).not.toContain("owner_assign");
        expect(ownerWrites()).toHaveLength(0);
        expect(p.objects.tickets["201"].properties.hubspot_owner_id).toBe(HUMAN_OWNER);
        expect(await recordCaseAfterConfirmedIntake(messageId, v2Deps())).toMatchObject({ owner: "human" });
        expect(await readCaseByTicket("201")).toMatchObject({ owner: "human", phase: "handoff_pending" });
    });
    it("SAV-11 A: the wake relays a confirmed intake to its case exactly once, and the sweep catches a lost relay up", async () => {
        environment.SAV_INTAKE_EVENT_DISPATCH = "on";
        environment.SAV_CASE_RECORDING = "on";
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        runId = await observed();
        expect(await reviewExecuteWake(runId, { env: () => environment, adapters: options.adapters })).toMatchObject({ state: "confirmed" });
        const ticketId = (await readIntakeExecutionProgress(messageId))!.ticketId!;
        const created = (await readCaseByTicket(ticketId))!;
        expect(created).toMatchObject({ owner: "human" });
        const gmailId = (await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0].gmailMessageId!;
        expect((await listCaseEvents(created.caseId)).filter(e => e.dedupeKey === caseDedupeKey.inbound(gmailId))).toHaveLength(1);
        // A second wake, then the sweep: nothing new.
        await reviewExecuteWake(runId, { env: () => environment, adapters: options.adapters });
        expect(await sweepCaseRelays({ limit: 50 })).toMatchObject({ relayed: 0 });
        expect((await readCaseByTicket(ticketId))!.version).toBe(created.version);
        // A relay lost before the case existed (the next mail's wake crashed after V1 confirmed).
        environment.SAV_CASE_RECORDING = "off";
        const next = await storedMessage(threadId, new Date(Date.now() + 1000));
        messageId = next.id;
        p.setGmail(next.gmailMessageId!, "gmail-thread");
        runId = await observed(next.id);
        expect(await reviewExecuteWake(runId, { env: () => environment, adapters: options.adapters })).toMatchObject({ state: "confirmed" });
        expect((await listCaseEvents(created.caseId)).some(e => e.dedupeKey === caseDedupeKey.inbound(next.gmailMessageId!))).toBe(false);
        expect(await sweepCaseRelays({ limit: 50 })).toMatchObject({ relayed: 1 });
        expect(await sweepCaseRelays({ limit: 50 })).toMatchObject({ relayed: 0 });
        expect((await listCaseEvents(created.caseId)).filter(e => e.dedupeKey === caseDedupeKey.inbound(next.gmailMessageId!))).toHaveLength(1);
    });
    it("SAV-11 A13: a mail V1 attached whose receipt the wake lost is confirmed by the cron worker, which does not relay; the cron's catch-up relays it once, with no provider write", async () => {
        environment.SAV_INTAKE_EVENT_DISPATCH = "on";
        environment.SAV_CASE_RECORDING = "on";
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        p.seedTicket({ stage: "open" });
        const dispatch = options.adapters.dispatch;
        options.adapters.dispatch = async (...args) => {
            const result = await dispatch(...args);
            if (args[0].kind === "email_associate") throw Error("LOST_ACK");
            return result;
        };
        runId = await observed();
        expect(await reviewExecuteWake(runId, { env: () => environment, adapters: options.adapters })).toMatchObject({ state: "uncertain" });
        expect(await readCaseByTicket("201")).toBeNull();
        options.adapters.dispatch = dispatch;
        await f.db.update(savIntakeEffects).set({ nextReconcileAt: null }).where(eq(savIntakeEffects.state, "uncertain"));
        expect(await reconcileIntakeExecutor({ env: () => environment, adapters: options.adapters })).toMatchObject({ state: "confirmed" });
        expect((await readIntakeExecutionProgress(messageId))!).toMatchObject({ state: "confirmed", ticketId: "201", confirmed: true });
        expect(await readCaseByTicket("201")).toBeNull();
        const writes = providerWrites();
        expect(await sweepCaseRelays({ limit: 50 })).toMatchObject({ relayed: 1 });
        expect(await sweepCaseRelays({ limit: 50 })).toMatchObject({ relayed: 0 });
        const gmailId = (await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0].gmailMessageId!;
        const created = (await readCaseByTicket("201"))!;
        expect(created).toMatchObject({ owner: "human" });
        expect((await listCaseEvents(created.caseId)).filter(e => e.dedupeKey === caseDedupeKey.inbound(gmailId))).toHaveLength(1);
        expect(providerWrites()).toEqual(writes);
        expect(ownerWrites()).toHaveLength(0);
    });
    it("SAV-11 A R1: with the permission granted, the sweep relays a confirmed intake once with no HubSpot effect, and the case stays the team's", async () => {
        await writePolicy([...mutations, "assign_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        p.seedTicket({ stage: "open" });
        options.adapters.v2OwnerAttribution = v2Port({ n: 0 });
        const row = await admission();
        expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
        expect(await readCaseByTicket("201")).toBeNull();
        const writes = p.calls.length;
        expect(await sweepCaseRelays({ limit: 50, deps: v2Deps() })).toMatchObject({ relayed: 1 });
        expect(await sweepCaseRelays({ limit: 50, deps: v2Deps() })).toMatchObject({ relayed: 0 });
        expect((await readCaseByTicket("201"))!).toMatchObject({ owner: "human", phase: "handoff_pending" });
        expect(p.calls.length).toBe(writes);
        expect(ownerWrites()).toHaveLength(0);
    });
    it("SAV-11 A R1: an older owner effect is only verified, read-only: confirmed when the V2 owner is read back, never while a human holds the ticket, never rewritten", async () => {
        p.seedTicket({ stage: "open", ownerId: HUMAN_OWNER });
        const adapters = createIntakeExecutorAdapters({ network: p.network, gmailRequest: p.gmail, gmailPermissions: async () => {}, env: () => environment });
        const intent = { kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${messageId}:201`, ticketId: "201", sourceMessageId: messageId, expectedOwnerId: null,
            properties: { hubspot_owner_id: V2_OWNER } } as const, signal = AbortSignal.timeout(1000), writes = () => p.calls.filter(c => c.method !== "GET").length, before = writes();
        expect(await adapters.verify(intent, { id: "201" }, new Date(), signal)).toMatchObject({ confirmed: false, attributed: false });
        p.objects.tickets["201"].properties.hubspot_owner_id = V2_OWNER;
        // A receipt alone attributes nothing; the read-back owner confirms.
        expect(await adapters.verify(intent, null, new Date(), signal)).toMatchObject({ confirmed: true, attributed: false });
        expect(await adapters.verify(intent, { id: "201" }, new Date(), signal)).toMatchObject({ confirmed: true, attributed: true });
        expect(writes()).toBe(before);
        expect(p.objects.tickets["201"].properties.hubspot_owner_id).toBe(V2_OWNER);
    });
    it("SAV-11 A v10: the relayed request's searchable subject is V1's own accepted summary, recorded by V1's recorder, with its provenance", async () => {
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        p.seedTicket({ stage: "open" });
        const runtime = options.runtime, id = (await enqueueSavIntakeMessage(messageId, runtime))!, lease = (await claimSavIntakeRun(id, runtime))!;
        const semantics: AcceptedIntakeSemantics = { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION, records: [] };
        const accepted = recordAcceptedIntakeSemantics({
            analyseMessage: async () => ({ messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId }],
                ticketSummary: { title: "Connexion impossible", description: "La connexion échoue depuis la mise à jour, compte 123456789.", requestIds: ["r1"] } }),
            assessIssues: async ({ tickets, requests }) => ({ investigationComplete: true, tickets: tickets.map(({ ticket: t }) => ({ ticketId: t.id, relation: "same", requestIds: requests.map(r => r.id), evidenceIds: ["current", `ticket-${t.id}`, `history-${t.id}`] })) }),
            assessIdentity: async () => { throw Error("NOT_USED"); },
        }, semantics, () => {});
        const plan = await planSavIntake(lease.input, { ...createSavIntakeHubspotReaders({ network: p.network }), ...accepted }, runtime.policy, {}, () => new Date());
        await saveSavIntakeResult(lease, runtime, { revision: SAV_INTAKE_RUNTIME_REVISION, effects: "not_connected", plan, input: lease.input, semantics }, "observed");
        expect(semantics.records.map(r => r.method)).toContain("analyseMessage");
        const row = (await admitIntakeExecution(id, options))!;
        expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
        await recordCaseAfterConfirmedIntake(messageId, { env: { SAV_CASE_RECORDING: "on" } });
        const [request] = (await readCaseByTicket("201"))!.body.openRequests;
        expect(request!.summary).toMatch(/relevée par l'analyse V1/);
        expect(request!.subject).toEqual({ status: "available", text: "Connexion impossible. La connexion échoue depuis la mise à jour, compte [numéro masqué].",
            provenance: { source: "v1_accepted_analysis", field: "ticketSummary", runId: id, runVersion: row.runVersion, resultHash: semantics.records.find(r => r.method === "analyseMessage")!.resultHash,
                validatorRevision: SAV_INTAKE_MODEL_REVISION, acceptedAt: semantics.records.find(r => r.method === "analyseMessage")!.acceptedAt } });
        expect(caseRequestSearchText(request!)).toBe(request!.subject!.status === "available" ? request!.subject!.text : "unreachable");
    });
});
describe("pilot access route 3A (3/11, local, SYN): V1 creates the ticket with the V2 owner in the POST itself", () => {
    beforeEach(async () => { await f.client.exec("TRUNCATE sav.cases, sav.case_events, sav.case_timers CASCADE"); });
    const created = () => p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"));
    const createdOwner = () => (created()[0]!.body as { properties: Record<string, unknown> }).properties.hubspot_owner_id;
    const creationPort = (asked: { n: number }, deps = v2Deps()) => { const port = v2OwnerAtCreationPort(deps); return async (input: Parameters<typeof port>[0]) => { asked.n++; return port(input); }; };
    const readOwner = async (ticketId: string) => (p.objects.tickets[ticketId]?.properties.hubspot_owner_id as string | null | undefined) ?? null;
    const createIntent = async (rowId: string) => decryptSavPayload<EffectIntent>((await getExecutionEffects(rowId)).find(e => e.kind === "ticket_create")!.intentCiphertext);
    async function v2Pause(level: "fully_paused" | null) {
        await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
        if (level) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed", cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "v2", level, setBy: "fixture@example.invalid", setAt: "2026-11-03T08:00:00.000Z", reason: "pause fictive" }) });
    }
    it("without the permission, the port is never asked and the POST is the one of today (no owner property at all)", async () => {
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        const asked = { n: 0 };
        options.adapters.v2OwnerAtCreation = creationPort(asked);
        const row = await admission();
        expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
        expect(asked.n).toBe(0);
        expect(Object.keys((created()[0]!.body as { properties: Record<string, unknown> }).properties)).not.toContain("hubspot_owner_id");
        expect(Object.keys((await createIntent(row.id)).properties!)).not.toContain("hubspot_owner_id");
    });
    it("with the permission: the POST carries the V2 owner, V1 verifies exactly that owner, no PATCH; the relay then reads it and gives the case to the agent (no fixture)", async () => {
        await writePolicy([...mutations, "create_ticket_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        const asked = { n: 0 };
        options.adapters.v2OwnerAtCreation = creationPort(asked);
        const row = await admission();
        expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
        // Asked when planned, and again just before the marker (review F2).
        expect(asked.n).toBe(2);
        expect(created()).toHaveLength(1);
        expect(createdOwner()).toBe(V2_OWNER);
        expect((await createIntent(row.id)).properties!.hubspot_owner_id).toBe(V2_OWNER);
        expect(ownerWrites()).toHaveLength(0);
        const ticketId = (await readIntakeExecutionProgress(messageId))!.ticketId!;
        expect(await recordCaseAfterConfirmedIntake(messageId, { ...v2Deps(), readCreatedTicketOwner: readOwner })).toMatchObject({ owner: "agent", admission: { target: "agent" } });
        const attribution = (await listCaseEvents((await readCaseByTicket(ticketId))!.caseId)).filter(e => e.kind === "owner_changed" && (e.detail as { transition?: string }).transition === "v2_attribution");
        expect(attribution).toHaveLength(1);
        expect(JSON.stringify(attribution[0])).toContain("hubspot_owner_at_creation");
    });
    it("a person who sets an owner right after the creation wins: V1 confirms its creation from the owner history, writes nothing, and the case never reaches the agent", async () => {
        await writePolicy([...mutations, "create_ticket_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        options.adapters.v2OwnerAtCreation = creationPort({ n: 0 });
        const dispatch = options.adapters.dispatch;
        options.adapters.dispatch = async (intent, signal) => {
            const sent = await dispatch(intent, signal);
            if (intent.kind === "ticket_create") for (const id of Object.keys(p.objects.tickets)) p.objects.tickets[id].properties.hubspot_owner_id = HUMAN_OWNER;
            return sent;
        };
        const row = await admission();
        // Review F3 (3/11): the creation is proven by HubSpot's history (first owner = V2 owner, at createdate), not by today's owner.
        expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
        expect(created()).toHaveLength(1);
        expect(ownerWrites()).toHaveLength(0);
        expect(Object.values(p.objects.tickets).map(t => t.properties.hubspot_owner_id)).toEqual([HUMAN_OWNER]);
        expect(await recordCaseAfterConfirmedIntake(messageId, { ...v2Deps(), readCreatedTicketOwner: readOwner })).toMatchObject({ owner: "human" });
    });
    it("finance, or a V2 pause, creates the ticket without owner, as today", async () => {
        await writePolicy([...mutations, "create_ticket_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        const asked = { n: 0 };
        options.adapters.v2OwnerAtCreation = creationPort(asked, v2Deps("finance"));
        const row = await admission();
        expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
        expect(asked.n).toBe(1);
        expect(createdOwner()).toBeUndefined();
        expect(await recordCaseAfterConfirmedIntake(messageId, { ...v2Deps("finance"), readCreatedTicketOwner: readOwner })).toMatchObject({ owner: "human", admission: { target: "team" } });
    });
    it("a V2 pause at planning time: no owner in the POST, the relay keeps the case for the team", async () => {
        await writePolicy([...mutations, "create_ticket_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        await v2Pause("fully_paused");
        try {
            options.adapters.v2OwnerAtCreation = creationPort({ n: 0 });
            const row = await admission();
            expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
            expect(createdOwner()).toBeUndefined();
        } finally { await v2Pause(null); }
        expect(await recordCaseAfterConfirmedIntake(messageId, { ...v2Deps(), readCreatedTicketOwner: readOwner })).toMatchObject({ owner: "human" });
    });
    it("a port that throws, or answers a malformed owner, creates without owner", async () => {
        await writePolicy([...mutations, "create_ticket_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        options.adapters.v2OwnerAtCreation = async () => ({ assign: true, ownerId: "SAV Pilote" });
        const row = await admission();
        expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
        expect(createdOwner()).toBeUndefined();
    });

    // UX review of bc5d53b (3/11), F1-F3. SYN only; every provider call goes to the in-memory fake.
    const timeoutAfterCreate = () => {
        const dispatch = options.adapters.dispatch;
        options.adapters.dispatch = async (intent, signal) => { const sent = await dispatch(intent, signal); if (intent.kind === "ticket_create") throw Error("SYNTHETIC_TIMEOUT_AFTER_POST"); return sent; };
        return () => { options.adapters.dispatch = dispatch; };
    };
    const withdrawn = async (rowId: string) => (await f.client.query("SELECT id FROM sav.intake_effect_journal WHERE execution_id = $1 AND kind = 'v2_owner_withdrawn'", [rowId])).rows;
    it("F1: permission revoked between planning and the marker: no POST at all (the policy binding stops it before any owner leaves)", async () => {
        await writePolicy([...mutations, "create_ticket_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        options.adapters.v2OwnerAtCreation = creationPort({ n: 0 });
        const row = await admission();
        await executeIntakePass(row.id, options, { beforeMarker: async () => { throw Error("SYNTHETIC_CRASH_BEFORE_MARKER"); } });
        expect((await createIntent(row.id)).properties!.hubspot_owner_id).toBe(V2_OWNER);
        await writePolicy(mutations);
        expect(await executeIntakePass(row.id, options)).not.toMatchObject({ state: "confirmed" });
        expect(created()).toHaveLength(0);
        expect(ownerWrites()).toHaveLength(0);
    });
    const ownerChanges: [string, (deps: CaseBoundaryDeps) => Promise<void>][] = [
        ["a V2 pause", async () => { await v2Pause("fully_paused"); }],
        ["the V2 owner un-configured", async deps => { delete (deps.env as Record<string, string | undefined>).SAV_V2_HUBSPOT_OWNER_ID; }],
    ];
    it.each(ownerChanges)("F2: %s after planning, before the marker: the creation leaves WITHOUT owner (journaled), the team keeps it", async (_label, change) => {
        await writePolicy([...mutations, "create_ticket_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        const deps = v2Deps(), asked = { n: 0 };
        options.adapters.v2OwnerAtCreation = creationPort(asked, deps);
        const row = await admission();
        try {
            expect(await executeIntakePass(row.id, options, { beforeMarker: async effect => { if (effect.kind === "ticket_create") await change(deps); } })).toMatchObject({ state: "confirmed" });
        } finally { await v2Pause(null); }
        expect(asked.n).toBe(2);
        expect(created()).toHaveLength(1);
        expect(createdOwner()).toBeUndefined();
        expect(Object.keys((await createIntent(row.id)).properties!)).not.toContain("hubspot_owner_id");
        expect(await withdrawn(row.id)).toHaveLength(1);
        expect(ownerWrites()).toHaveLength(0);
        expect(await recordCaseAfterConfirmedIntake(messageId, { ...v2Deps(), readCreatedTicketOwner: readOwner })).not.toMatchObject({ owner: "agent" });
    });
    it("after the marker: a V2 pause changes nothing but verification; one POST, the stored owner, never a second POST nor a PATCH", async () => {
        await writePolicy([...mutations, "create_ticket_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        options.adapters.v2OwnerAtCreation = creationPort({ n: 0 });
        const restore = timeoutAfterCreate(), row = await admission();
        expect(await executeIntakePass(row.id, options)).not.toMatchObject({ state: "confirmed" });
        restore();
        await v2Pause("fully_paused");
        try {
            await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
            await executeIntakePass(row.id, options);
        } finally { await v2Pause(null); }
        expect(created()).toHaveLength(1);
        expect(createdOwner()).toBe(V2_OWNER);
        expect(await withdrawn(row.id)).toHaveLength(0);
        expect(ownerWrites()).toHaveLength(0);
    });
    it("F3: crash after the POST, a person takes the ticket before recovery: confirmed from the history, the person keeps it, nothing written", async () => {
        await writePolicy([...mutations, "create_ticket_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        options.adapters.v2OwnerAtCreation = creationPort({ n: 0 });
        const restore = timeoutAfterCreate(), row = await admission();
        await executeIntakePass(row.id, options);
        restore();
        const [ticketId] = Object.keys(p.objects.tickets);
        p.objects.tickets[ticketId].properties.hubspot_owner_id = HUMAN_OWNER;
        // The first verification is scheduled later: the recovery reads only what is due (as "lost create ACK reconciles" does).
        await f.db.update(savIntakeEffects).set({ nextReconcileAt: null }).where(eq(savIntakeEffects.executionId, row.id));
        await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
        await executeIntakePass(row.id, options);
        expect(created()).toHaveLength(1);
        expect((await getExecutionEffects(row.id)).find(e => e.kind === "ticket_create")!.state).toBe("confirmed");
        expect(p.objects.tickets[ticketId].properties.hubspot_owner_id).toBe(HUMAN_OWNER);
        expect(ownerWrites()).toHaveLength(0);
        // Review R3, CT3b witness: on an effect already confirmed the operator's candidate path refuses (nothing left to reconcile).
        const effect = (await getExecutionEffects(row.id)).find(e => e.kind === "ticket_create")!;
        await expect(reconcileIntakeEffectCandidate(effect.id, ticketId, "Synthetic exact candidate already confirmed", options.adapters)).rejects.toThrow("SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED");
        expect(await recordCaseAfterConfirmedIntake(messageId, { ...v2Deps(), readCreatedTicketOwner: readOwner })).not.toMatchObject({ owner: "agent" });
    });
    it("F3 (review R3): history unreadable at recovery, readable later: the operator's candidate path confirms the creation, read only, the person keeps the ticket", async () => {
        await writePolicy([...mutations, "create_ticket_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        options.adapters.v2OwnerAtCreation = creationPort({ n: 0 });
        const restore = timeoutAfterCreate(), row = await admission();
        await executeIntakePass(row.id, options);
        restore();
        const [ticketId] = Object.keys(p.objects.tickets), original = p.ownerHistory.get(ticketId)!;
        p.objects.tickets[ticketId].properties.hubspot_owner_id = HUMAN_OWNER;
        p.ownerHistory.set(ticketId, []);
        await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
        await executeIntakePass(row.id, options);
        const effect = (await getExecutionEffects(row.id)).find(e => e.kind === "ticket_create")!;
        expect(effect.state).not.toBe("confirmed");
        p.ownerHistory.set(ticketId, original);
        const writes = p.calls.filter(c => c.method !== "GET").length;
        await reconcileIntakeEffectCandidate(effect.id, ticketId, "Synthetic exact candidate held by a person", options.adapters);
        expect((await getExecutionEffects(row.id)).find(e => e.id === effect.id)!.state).toBe("confirmed");
        expect(p.calls.filter(c => c.method !== "GET").length).toBe(writes);
        expect(created()).toHaveLength(1);
        expect(p.objects.tickets[ticketId].properties.hubspot_owner_id).toBe(HUMAN_OWNER);
        expect(ownerWrites()).toHaveLength(0);
    });
    const weakHistories: [string, (at: string) => { value: string; timestamp: string }[]][] = [
        ["no history", () => []],
        ["a first owner that is the person", at => [{ value: HUMAN_OWNER, timestamp: at }]],
        ["a first owner set long after the creation", at => [{ value: "", timestamp: at }, { value: V2_OWNER, timestamp: new Date(Date.parse(at) + 60000).toISOString() }]],
        ["two owners at the creation time", at => [{ value: V2_OWNER, timestamp: at }, { value: HUMAN_OWNER, timestamp: at }]],
    ];
    it.each(weakHistories)("F3: a person holds the ticket and the history proves nothing (%s): the creation stays uncertain, also for an operator, nothing sent", async (_label, history) => {
        await writePolicy([...mutations, "create_ticket_v2_owner"]);
        vi.stubEnv("SAV_CASE_RECORDING", "on");
        options.adapters.v2OwnerAtCreation = creationPort({ n: 0 });
        const restore = timeoutAfterCreate(), row = await admission();
        await executeIntakePass(row.id, options);
        restore();
        const [ticketId] = Object.keys(p.objects.tickets);
        p.objects.tickets[ticketId].properties.hubspot_owner_id = HUMAN_OWNER;
        p.ownerHistory.set(ticketId, [...history(p.objects.tickets[ticketId].properties.createdate as string)]);
        const calls = p.calls.filter(c => c.method !== "GET").length;
        await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
        await executeIntakePass(row.id, options);
        const effect = (await getExecutionEffects(row.id)).find(e => e.kind === "ticket_create")!;
        expect(effect.state).not.toBe("confirmed");
        await expect(reconcileIntakeEffectCandidate(effect.id, ticketId, "Synthetic exact candidate held by a person", options.adapters)).rejects.toThrow();
        expect(p.calls.filter(c => c.method !== "GET").length).toBe(calls);
        expect(p.objects.tickets[ticketId].properties.hubspot_owner_id).toBe(HUMAN_OWNER);
    });
});
// SAV-31 qualification: MCP → native reconciliation → PGlite, synthetic provider, never a second send.
async function sav31Mcp(name: string, extra: Record<string, unknown> = {}) {
    await f.db.insert(savSyncState).values({ key: "sav-intake-console-schema-v1", status: "installed" }).onConflictDoNothing();
    const { readIntakeConsoleDetail } = await import("./console-detail"), { intakeVersionToken } = await import("@/lib/mcp/tools"), { handleStudioMcpRequest } = await import("@/lib/mcp/server");
    const versionToken = intakeVersionToken((await readIntakeConsoleDetail(threadId))!);
    const response = await handleStudioMcpRequest(new Request("https://studio.example.invalid/api/mcp", { method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { threadId, versionToken, ...extra } } }),
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer synthetic" } }),
        { env: { STUDIO_MCP_ENABLED: "true", STUDIO_MCP_WRITES_ENABLED: "true" }, resolveUser: async () => state.user as never });
    return (await response.json()).result?.structuredContent;
}
async function uncertainIdentityAfterRevocation() {
    p.setContacts([]);
    const row = await admission(), verify = options.adapters.verify;
    options.adapters.verify = async () => ({ confirmed: false, attributed: false });
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "uncertain" });
    await revokeIntakeExecutionPolicy(options.config.policyId, "Synthetic rotation after a real verified send");
    options.adapters.verify = verify;
    state.adapterDefaults = { network: p.network, gmailRequest: p.gmail, gmailPermissions: async () => {}, env: () => environment };
    return row;
}
it("SAV-31 reconcile_identification through the MCP confirms the existing receipt and never resends", async () => {
    try {
        const row = await uncertainIdentityAfterRevocation(), sends = p.calls.filter(c => c.path === "gmail/messages/send").length;
        expect(await sav31Mcp("reconcile_identification")).toMatchObject({ outcome: "done", data: { confirmed: 1 } });
        expect((await getExecutionEffects(row.id))[0].state).toBe("confirmed");
        expect(p.calls.filter(c => c.path === "gmail/messages/send")).toHaveLength(sends);
        expect((await f.db.select().from(auditLogs)).filter(a => a.action === "studio_mcp_write")).toMatchObject([{ technicalMetadata: { tool: "reconcile_identification", outcome: "done" } }]);
    } finally { state.adapterDefaults = null; }
});
it("SAV-31 reconcile_identification with a lost receipt stays uncertain and sends nothing", async () => {
    try {
        const row = await uncertainIdentityAfterRevocation(), before = p.calls.length;
        await f.db.update(savIntakeEffects).set({ ackCiphertext: null }).where(eq(savIntakeEffects.executionId, row.id));
        expect(await sav31Mcp("reconcile_identification")).toMatchObject({ outcome: "refused", code: "SAV_INTAKE_RECOVERY_CONFLICT" });
        expect((await getExecutionEffects(row.id))[0].state).not.toBe("confirmed");
        expect((await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, row.id)))[0].state).toBe("uncertain");
        expect(p.calls).toHaveLength(before);
    } finally { state.adapterDefaults = null; }
});
async function historicalNoteAwaitingClosure(associated: boolean) {
    p.seedTicket({ stage: "open" });
    const row = await admission();
    expect(await executeIntakePass(row.id, options, { afterAck: async effect => { if (effect.kind === "note_create") throw Error("SYNTHETIC_CRASH_AFTER_NOTE_ACK"); } })).toMatchObject({ state: "uncertain" });
    const effects = await getExecutionEffects(row.id), note = effects.find(e => e.kind === "note_create")!;
    const noteId = decryptSavPayload<EffectAck>(note.ackCiphertext!).id!;
    // The single historical note creation this repair addresses: other planned steps of the revoked continuation are removed.
    for (const other of effects.filter(e => e.id !== note.id)) {
        await f.client.query("DELETE FROM sav.intake_effect_journal WHERE effect_id = $1", [other.id]);
        await f.client.query("DELETE FROM sav.intake_effects WHERE id = $1", [other.id]);
    }
    if (associated) { p.links.set(`notes:${noteId}:tickets`, ["201"]); p.links.set(`tickets:201:notes`, [noteId]); }
    await revokeIntakeExecutionPolicy(options.config.policyId, "Synthetic rotation after a historical note");
    state.adapterDefaults = { network: p.network, gmailRequest: p.gmail, gmailPermissions: async () => {}, env: () => environment };
    return { row, note, noteId };
}
it.each([true, false])("SAV-31 reconcile_note through the MCP verifies the existing note without creating one (associated: %s)", async associated => {
    try {
        const { row, note } = await historicalNoteAwaitingClosure(associated);
        const posts = () => p.calls.filter(c => c.method === "POST" && c.path.endsWith("/notes")).length, before = posts();
        const result = await sav31Mcp("reconcile_note");
        expect(result).toMatchObject(associated ? { outcome: "done" } : { outcome: "refused", code: "SAV_INTAKE_NOTE_RECONCILIATION_REQUIRED" });
        expect(posts()).toBe(before);
        expect((await f.db.select().from(auditLogs)).filter(a => a.action === "sav_existing_note_reconciled_for_closure")).toHaveLength(associated ? 1 : 0);
        expect((await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, row.id)))[0].state).toBe("uncertain");
        if (!associated) expect(p.links.get(`notes:${decryptSavPayload<EffectAck>(note.ackCiphertext!).id}:tickets`) ?? []).toEqual([]);
    } finally { state.adapterDefaults = null; }
});

it("V1 integrated: absence, real reply, partial history, then observation outage after the email is linked", async () => {
    const { savIntakeObservationBindings, savIntakeModelCalls } = await import("@/db/schema");
    const { ensureIntakeObservations } = await import("./observation-binding");
    const { syncSavObservation } = await import("../observations");
    const { readSavIntakeCurrent } = await import("./runtime-store");
    const analyse = async (id: string, network: typeof fetch) =>
        analyseSavIntakeRuntime(id, options.runtime, { env: () => environment, network });
    // Gmail stored a verifiable out-of-office response. The next inbound has the same subject.
    const { parseGmailMessage } = await import("../gmail");
    const parsed = parseGmailMessage("support@example.invalid", { id: "vacation", threadId: "gmail-thread",
        internalDate: String(Date.now()), payload: { mimeType: "text/plain", body: { size: Buffer.byteLength("Je suis absent."), data: Buffer.from("Je suis absent.").toString("base64url") }, headers: [
            { name: "Subject", value: "Re: Synthetic connection failure" },
            { name: "From", value: "customer@example.invalid" }, { name: "To", value: "support@example.invalid" },
            { name: "Auto-Submitted", value: "auto-replied" }, { name: "In-Reply-To", value: "<campaign@example.invalid>" }] } });
    await f.db.update(savMessages).set({ subject: parsed.subject, bodyCiphertext: encryptSavPayload({ text: parsed.bodyText, headers: parsed.headers, attachments: [] }) })
        .where(eq(savMessages.id, messageId));
    await analyse((await enqueueSavIntakeMessage(messageId, options.runtime))!, async () => { throw Error("unexpected network"); });
    expect((await readSavIntakeCurrent(threadId, options.runtime))?.payload.reason).toBe("SAV_INTAKE_AUTOMATED_REPLY");
    expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(0);

    const human = await storedMessage();
    await f.db.update(savMessages).set({ subject: parsed.subject }).where(eq(savMessages.id, human.id));
    p.setGmail(human.gmailMessageId!, "gmail-thread");
    const ticket = p.seedTicket({ stage: "open" });
    p.objects.notes["401"] = { id: "401", properties: { hs_note_body: "The synthetic connection fails.", hs_timestamp: new Date().toISOString() } };
    p.links.set("tickets:" + ticket + ":notes", ["401"]);
    let partial = true;
    const network: typeof fetch = async (url, init) => {
        if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
            const prompt = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
            const cite = (sourceId: string) => prompt.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === sourceId).id;
            const answer = !prompt.tickets ? { messageId: human.id, requests: [{ id: "r1", kind: "support", currentMessageId: human.id, quoteId: cite("current") }],
                ticketSummary: { title: "Synthetic connection failure", description: "The synthetic connection fails.", requestIds: ["r1"] } }
                : { investigationComplete: true, tickets: [{ ticketId: ticket, relation: "same", requestIds: ["r1"],
                    rationale: "Same failure", evidenceIds: ["current", "ticket-" + ticket, "history-" + ticket],
                    grounding: ["current", "ticket-" + ticket, "history-" + ticket].map(source => ({ quoteId: cite(source) })) }] };
            return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }],
                usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
        }
        if (partial && String(url).includes("/associations/notes"))
            return Response.json({ results: [], paging: { next: { after: "same-cursor" } } });
        return p.network(url, init);
    };
    const id = (await enqueueSavIntakeMessage(human.id, options.runtime))!;
    await analyse(id, network);
    const spent = (await f.db.select().from(savIntakeModelCalls)).length;
    expect(spent).toBeGreaterThan(0);
    await analyse(id, network);
    expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(spent);
    partial = false;
    await analyse(id, network);
    const execution = await admitIntakeExecution(id, options);
    expect(execution, JSON.stringify(await readIntakeRunDiagnostics(threadId))).toBeTruthy();
    expect(await executeIntakePass(execution!.id, options)).toMatchObject({ state: "confirmed" });
    expect(p.objects.tickets[ticket]).toBeTruthy();
    expect(Object.keys(p.objects.tickets)).toHaveLength(1);
    expect(Object.keys(p.objects.emails)).toHaveLength(1);
    expect(p.links.get("tickets:" + ticket + ":emails")).toEqual(Object.keys(p.objects.emails));

    await ensureIntakeObservations();
    const [binding] = await f.db.select().from(savIntakeObservationBindings).where(eq(savIntakeObservationBindings.executionId, execution!.id));
    const writesBefore = writes().length;
    const failed = await syncSavObservation(binding.observationId, async () => { throw Error("Synthetic CRM outage"); });
    expect(failed.status).toBe("sources_incomplete");
    await syncSavObservation(binding.observationId, async ticketId => {
        expect(ticketId).toBe(ticket);
        return { ticketId, subject: "Synthetic connection failure", status: "open", updatedAt: new Date().toISOString(), events: [], errors: [] };
    });
    expect((await readIntakeRunDiagnostics(threadId))?.execution?.followup).toMatchObject({ observationState: "active", sourceErrors: 0 });
    expect(writes()).toHaveLength(writesBefore);
});
