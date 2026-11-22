import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, categories, contentItems, knowledgeProjectionCandidates, savKnowledgeActivations, savKnowledgeProposalDrafts, staffUsers } from "@/db/schema";

const state = vi.hoisted(() => ({ gate: null as null | (() => Promise<void>), db: null as unknown, embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(1))) }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
vi.mock("@/lib/embeddings", () => ({ embedTexts: state.embed }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => { throw Error("NO_SESSION_ON_MCP"); }, clerkClient: async () => { throw Error("NO_REAL_CLERK"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Race hook: runs once inside the publish, after the hash check and before the submission.
vi.mock("@/lib/knowledge/workspace", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/knowledge/workspace")>();
  return { ...actual, previewSavKnowledgeProposal: async (...args: Parameters<typeof actual.previewSavKnowledgeProposal>) => {
    const gate = state.gate; state.gate = null; if (gate) await gate();
    return actual.previewSavKnowledgeProposal(...args);
  } };
});
import { handleStudioMcpRequest, resetStudioMcpRateLimit } from "./server";
import { saveSavKnowledgeProposal } from "@/lib/knowledge/workspace";
import { searchKnowledge } from "@/lib/search";

/** Studio MCP knowledge fiches: the Connaissances page's own functions, as the key's staff member. Fictional data only. */
let f: Awaited<ReturnType<typeof createSavTestDb>>;
type User = { id: string; primaryEmailAddress: { emailAddress: string; verification: { status: string } } };
const user = (id: string, email: string): User => ({ id, primaryEmailAddress: { emailAddress: email, verification: { status: "verified" } } });
const ugo = user("user_ugo", "ugo@limova.ai"), reouven = user("user_reouven", "reouven@limova.ai"), contact = user("user_contact", "contact@limova.ai");
let current: User = ugo;
const env = { STUDIO_MCP_ENABLED: "true", STUDIO_MCP_WRITES_ENABLED: "true" };
type Result = { outcome: string; code: string; message: string; data?: Record<string, unknown> & { [key: string]: unknown } };
async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const response = await handleStudioMcpRequest(new Request("https://studio.example.invalid/api/mcp", { method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer synthetic-token-0123456789" } }),
  { env, resolveUser: async () => current as never });
  const body = await response.json() as { result?: { structuredContent?: Result }; error?: unknown };
  return body.result?.structuredContent ?? { outcome: "error", code: "MCP_PROTOCOL", message: JSON.stringify(body.error ?? body) };
}
const key = () => crypto.randomUUID();
const SECRET_INSTRUCTION = "Ouvrir les réglages du carnet fictif, choisir Archiver puis confirmer.";
const document = { schemaVersion: 1 as const, objective: "Archiver un carnet de démonstration", applicability: "sav_only" as const, locale: "fr-FR",
  prerequisites: ["Disposer des droits de gestion du carnet fictif."], expectedResult: "Le carnet apparaît dans les archives.", exceptions: ["Un carnet partagé doit d’abord être retiré du partage."],
  escalation: "Transmettre à un humain si le carnet reste visible.", supportContext: { symptoms: ["archiver carnet", "carnet fictif"], diagnosticQuestions: [], responseTemplate: "" },
  steps: [{ id: "notebook.archive", userLabel: "Archiver le carnet", objective: "Masquer le carnet", instruction: SECRET_INSTRUCTION, expectedResult: "Le carnet disparaît de la liste.", prerequisites: [], exceptions: [], escalation: "", variants: [] }] };
const fiche = { title: "Archiver un carnet de démonstration", document, reason: "Formaliser une procédure fictive et sourcée.", sources: [{ ref: "https://docs.example.test/carnets", label: "Procédure fictive vérifiée" }] };
const search = async (query = "Archiver un carnet") => (await searchKnowledge({ query, scope: "sav", contentTypes: ["article"] })).results;
async function propose(args: Record<string, unknown> = fiche) { const result = await call("propose_fiche", { ...args, idempotencyKey: key() }); expect(result).toMatchObject({ outcome: "done" }); return result.data as { draftId: string; contentHash: string; missing: string[] }; }
async function publish(draft: { draftId: string; contentHash: string }) { return call("publish_fiche", { draftId: draft.draftId, contentHash: draft.contentHash, idempotencyKey: key() }); }

beforeAll(async () => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-mcp-knowledge-test-key"); f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await f.client.exec("TRUNCATE public.staff_users, sav_knowledge_proposal_drafts, sav.learning_candidates, knowledge_families, content_items, categories CASCADE; TRUNCATE audit_logs");
  await f.db.insert(categories).values({ slug: "depannage", label: "Dépannage" });
  await f.db.insert(staffUsers).values([{ clerkId: "user_ugo", email: "ugo@limova.ai", name: "Ugo", role: "admin" },
    { clerkId: "user_reouven", email: "reouven@limova.ai", name: "Reouven", role: "admin" }, { clerkId: "user_contact", email: "contact@limova.ai", name: "Contact", role: "member" }]);
  current = ugo; state.gate = null; resetStudioMcpRateLimit();
  state.embed.mockReset().mockImplementation(async (texts: string[]) => texts.map(() => Array(768).fill(1)));
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("Studio MCP knowledge fiches", () => {
  it("refuses every knowledge tool without the admin role, before anything is read or written", async () => {
    current = contact;
    const draftId = crypto.randomUUID();
    for (const [name, args] of [["search_fiches", {}], ["get_fiche", { draftId }], ["propose_fiche", { ...fiche, idempotencyKey: key() }],
      ["propose_fiche_update", { ...fiche, itemId: crypto.randomUUID(), idempotencyKey: key() }], ["publish_fiche", { draftId, contentHash: "a".repeat(64), idempotencyKey: key() }]] as const)
      expect(await call(name, args)).toMatchObject({ outcome: "refused", code: "SAV_KNOWLEDGE_MCP_FORBIDDEN" });
    expect(await f.db.select().from(savKnowledgeProposalDrafts)).toHaveLength(0);
  });

  it("propose_fiche creates a draft only, as the MCP staff member, idempotently on retry", async () => {
    const idempotencyKey = key();
    const first = await call("propose_fiche", { ...fiche, idempotencyKey });
    expect(first).toMatchObject({ outcome: "done", data: { missing: [], publishable: true, delivery: "procedure", targetItemId: null } });
    const data = first.data as { draftId: string; contentHash: string };
    expect(data.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const retry = await call("propose_fiche", { ...fiche, idempotencyKey });
    expect(retry).toMatchObject({ outcome: "already_done", data: { draftId: data.draftId, contentHash: data.contentHash } });
    const drafts = await f.db.select().from(savKnowledgeProposalDrafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: "draft", createdBy: "ugo@limova.ai", mode: "new" });
    expect(await f.db.select().from(knowledgeProjectionCandidates)).toHaveLength(0);
    expect(await f.db.select().from(savKnowledgeActivations)).toHaveLength(0);
    expect(await search()).toHaveLength(0);
    const receipt = (await f.db.select().from(auditLogs)).find(row => row.action === "studio_mcp_write");
    expect(receipt).toMatchObject({ actorEmail: "ugo@limova.ai", technicalMetadata: { tool: "propose_fiche", outcome: "done", receipt_draftId: data.draftId } });
    expect(await call("get_fiche", { draftId: data.draftId })).toMatchObject({ outcome: "done", data: { draft: { draftId: data.draftId, contentHash: data.contentHash, title: fiche.title } } });
  });

  it("publish_fiche refuses a wrong or stale hash, then activates through the UI path and makes the fiche searchable", async () => {
    const draft = await propose();
    expect(await call("publish_fiche", { draftId: draft.draftId, contentHash: "0".repeat(64), idempotencyKey: key() })).toMatchObject({ outcome: "refused", code: "SAV_MCP_FICHE_CHANGED" });
    // The draft is edited afterwards in the Studio: the hash given by propose is stale.
    await saveSavKnowledgeProposal({ draftId: draft.draftId, expectedRevision: 1, mode: "new", ...fiche, document: { ...document, expectedResult: "Le carnet est rangé dans les archives." },
      delivery: { version: 1, mode: "procedure", internalStepIds: [], groups: [{ id: "fiche.main", label: document.objective, stepIds: ["notebook.archive"], requiresHuman: false, prerequisiteIndexes: [0], exceptionIndexes: [0], includeExpectedResult: true, includeEscalation: true }] } }, "ugo@limova.ai");
    expect(await publish(draft)).toMatchObject({ outcome: "refused", code: "SAV_MCP_FICHE_CHANGED" });
    expect(await f.db.select().from(knowledgeProjectionCandidates)).toHaveLength(0);
    const fresh = (await call("get_fiche", { draftId: draft.draftId })).data!.draft as { contentHash: string };
    expect(fresh.contentHash).not.toBe(draft.contentHash);
    const published = await publish({ draftId: draft.draftId, contentHash: fresh.contentHash });
    expect(published).toMatchObject({ outcome: "done", data: { steps: ["submitted", "approved", "published", "activated"] } });
    const { itemId, versionId } = published.data as { itemId: string; versionId: string };
    expect((await f.db.select().from(savKnowledgeActivations))[0]).toMatchObject({ itemId, versionId, activatedBy: "ugo@limova.ai" });
    expect((await search())[0]).toMatchObject({ contentVersionId: versionId });
    expect(state.embed).toHaveBeenCalled();
    const listed = await call("search_fiches", { query: "carnet" });
    expect(listed).toMatchObject({ outcome: "done", data: { total: 1, rows: [{ itemId, status: "production", version: 1 }] } });
    // Same request again: nothing to redo.
    expect(await publish({ draftId: draft.draftId, contentHash: fresh.contentHash })).toMatchObject({ outcome: "done", data: { steps: [] } });
  });

  it("publish_fiche refuses a draft edited between the hash check and the submission, and submits nothing", async () => {
    const draft = await propose();
    state.gate = async () => { await saveSavKnowledgeProposal({ draftId: draft.draftId, expectedRevision: 1, mode: "new", ...fiche, reason: "Motif fictif modifié pendant la publication.",
      delivery: { version: 1, mode: "procedure", internalStepIds: [], groups: [{ id: "fiche.main", label: document.objective, stepIds: ["notebook.archive"], requiresHuman: false, prerequisiteIndexes: [0], exceptionIndexes: [0], includeExpectedResult: true, includeEscalation: true }] } }, "ugo@limova.ai"); };
    expect(await publish(draft)).toMatchObject({ outcome: "refused", code: "SAV_MCP_FICHE_CHANGED" });
    expect(state.gate).toBeNull();
    expect(await f.db.select().from(knowledgeProjectionCandidates)).toHaveLength(0);
    expect((await f.db.select().from(savKnowledgeProposalDrafts))[0]).toMatchObject({ status: "draft", revision: 2 });
    expect(await f.db.select().from(savKnowledgeActivations)).toHaveLength(0);
  });

  it("propose_fiche_update keeps the active version live until publish_fiche", async () => {
    const first = await publish(await propose());
    const { itemId, versionId: v1 } = first.data as { itemId: string; versionId: string };
    const changed = { ...document, steps: [{ ...document.steps[0], instruction: "Ouvrir le menu du carnet fictif, choisir Archiver et valider." }] };
    const update = await call("propose_fiche_update", { itemId, title: fiche.title, document: changed, reason: "Le menu fictif a changé de place.", idempotencyKey: key() });
    expect(update).toMatchObject({ outcome: "done", data: { targetItemId: itemId, activeVersionId: v1, missing: [] } });
    const draft = update.data as { draftId: string; contentHash: string };
    expect((await f.db.select().from(savKnowledgeActivations))[0].versionId).toBe(v1);
    expect((await search())[0].contentVersionId).toBe(v1);
    const read = await call("get_fiche", { itemId });
    expect(read).toMatchObject({ outcome: "done", data: { active: { versionId: v1 }, drafts: [{ draftId: draft.draftId, contentHash: draft.contentHash }] } });
    expect(JSON.stringify((read.data as { active: unknown }).active)).toContain(SECRET_INSTRUCTION);
    const published = await publish(draft);
    expect(published).toMatchObject({ outcome: "done", data: { itemId, previousActiveVersionId: v1 } });
    const v2 = (published.data as { versionId: string }).versionId;
    expect(v2).not.toBe(v1);
    expect((await f.db.select().from(savKnowledgeActivations))[0].versionId).toBe(v2);
    expect((await search())[0].contentVersionId).toBe(v2);
    expect(await f.db.select().from(contentItems)).toHaveLength(1);
  });

  it("publication stays reserved to Ugo: another admin can propose but not publish", async () => {
    current = reouven;
    const draft = await propose();
    expect(await publish(draft)).toMatchObject({ outcome: "refused", code: "KNOWLEDGE_UGO_APPROVAL_REQUIRED" });
    expect(await f.db.select().from(knowledgeProjectionCandidates)).toHaveLength(0);
    expect((await f.db.select().from(savKnowledgeProposalDrafts))[0].status).toBe("draft");
  });

  it("refuses an incomplete draft before any step and logs codes and ids, never fiche content", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const incomplete = await propose({ ...fiche, document: { ...document, prerequisites: [] } });
    expect(incomplete.missing.length).toBeGreaterThan(0);
    expect(await publish(incomplete)).toMatchObject({ outcome: "refused", code: "KNOWLEDGE_PROPOSAL_INCOMPLETE" });
    await publish(await propose());
    await call("search_fiches", { query: "carnet" });
    const logged = JSON.stringify([...vi.mocked(console.info).mock.calls, ...error.mock.calls]);
    expect(vi.mocked(console.info).mock.calls.some(([tag]) => tag === "studio_mcp")).toBe(true);
    for (const text of [SECRET_INSTRUCTION, fiche.title, document.objective, fiche.reason, document.prerequisites[0]!]) expect(logged).not.toContain(text);
    const receipts = JSON.stringify((await f.db.select().from(auditLogs)).filter(row => row.action.startsWith("studio_mcp")));
    for (const text of [SECRET_INSTRUCTION, fiche.title, fiche.reason]) expect(receipts).not.toContain(text);
  });
});
