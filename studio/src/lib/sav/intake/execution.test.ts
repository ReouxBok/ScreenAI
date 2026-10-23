import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
import { savMailboxes, savThreads, savMessages, staffUsers, savIntakeExecutionPolicies, savIntakeExecutionBudget, savIntakeExecutions, savIntakeEffects, savIntakeOccupations, savIntakeRuns, savActions, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({
    db: null as unknown, user: null as unknown
}));
vi.mock("@/db", () => ({
    requireDb: () => {
        if (!state.db)
            throw Error("NO_DB_ALLOWED");
        return state.db;
    }
}));
vi.mock("@clerk/nextjs/server", () => ({
    currentUser: async () => state.user
}));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { planSavIntake } from "./engine";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { savIntakeRuntimeConfig, intakeRuntimeHash, SAV_INTAKE_RUNTIME_REVISION } from "./runtime-contract";
import { executionPolicySchema, executionAdministrator, intakeExecutionConfig, approveIntakeExecutionPolicy, revokeIntakeExecutionPolicy, readIntakeExecutionAuthority, type ExecutionPolicy } from "./execution-policy";
import { enqueueSavIntakeMessage, claimSavIntakeRun, saveSavIntakeResult, catchupSavIntake } from "./runtime-store";
import { createIntakeExecutorAdapters } from "./execution-adapters";
import { admitIntakeExecution, getExecutionEffects, occupationSchemaInstalled, assertNoLegacyConflict, claimExecution, endExecutionPass, occupyKeys, finishVerifiedIdentityRecovery } from "./execution-store";
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
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30000);
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
it("human ticket changes after create confirmation invalidate the continuation", async () => {
    const row = await admission(), verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "ticket_create" && proof.confirmed)
            p.objects.tickets[proof.ack!.id!].properties.content = "Human changed content";
        return proof;
    };
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "waiting", reason: "SAV_INTAKE_EXECUTION_CRM_CHANGED"
    });
    expect((await getExecutionEffects(row.id))).toHaveLength(1);
});
it("human note edit and closure after PATCH are not subtracted as own deltas", async () => {
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
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "waiting", reason: "SAV_INTAKE_EXECUTION_CRM_CHANGED"
    });
    expect((await getExecutionEffects(row.id)).find(e => e.kind === "stage_new")?.state).toBe("confirmed");
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
it.each(["owner", "history"])("human %s change on created ticket blocks subsequent archive", async (change) => {
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
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "waiting", reason: "SAV_INTAKE_EXECUTION_CRM_CHANGED"
    });
    expect((await getExecutionEffects(row.id))).toHaveLength(1);
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
it.each(["disappeared", "human_closed"] as const)("review735 linked ticket %s after PATCH still invalidates", async (change) => {
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
    expect(await executeIntakePass(row.id, options)).toMatchObject({
        state: "waiting", reason: "SAV_INTAKE_EXECUTION_CRM_CHANGED"
    });
    expect((await getExecutionEffects(row.id)).find(e => e.kind === "stage_new")?.state).toBe("confirmed");
    expect((await f.db.select().from(savThreads).where(eq(savThreads.id, threadId)))[0].hubspotTicketId).toBeNull();
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
    p.seedTicket({ stage: "new" });
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
