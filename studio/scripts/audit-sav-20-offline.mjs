// Diagnostic only: executes a historical engine with in-memory dependencies.
// No credentials, database connections, provider calls, or application changes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const revision = "9b29635632ef80681b8078a4780a0d410eed02da";
const repository = fileURLToPath(new URL("../..", import.meta.url));
function historicalSource(name) {
  const result = spawnSync("git", ["show", `${revision}:studio/src/lib/sav/${name}.ts`], {
    cwd: repository, encoding: "utf8", maxBuffer: 2_000_000,
  });
  if (result.status !== 0) throw new Error(`Historical source unavailable: ${name}`);
  return result.stdout;
}
const sources = Object.fromEntries(["config", "policy", "intelligence"].map(name => [name, historicalSource(name)]));

function harness({ key = true, response = "503" } = {}) {
  const traces = [];
  const calls = { legacy: 0, adk: 0 };
  const environment = { SAV_ADK_MODE: "pilot", SAV_AI_ANALYSIS: "true", SAV_GEMINI_API_KEY: key ? "offline-fixture-not-a-key" : "" };
  const modules = {};
  const dependencies = {
    "server-only": {}, zod: require("zod"),
    "@/db": { requireDb: () => ({ insert: () => ({ values: value => ({ returning: async () => {
      traces.push(value); return [{ id: `offline-${traces.length}` }];
    } }) }) }) },
    "@/db/schema": { savAgentRuns: {} },
    "@/lib/search": { searchKnowledge: async () => ({ revision: "offline", results: [] }) },
    "./conversation": { loadSavConversation: async () => ({ senderMatchesCustomer: true, aiPaused: false }) },
    "./crypto": { savContentHash: () => "offline-hash" },
    "./agent/orchestrator": { runSavAdkAgent: async () => {
      calls.adk++;
      return { output: { category: "how_to", urgency: "normal", ticketRequired: true,
        reasonCode: "offline_human", explanation: "Une vérification humaine est nécessaire.",
        confidence: 0.99, requiresHuman: true, replyDraft: "Réponse contextualisée fictive.", internalNote: "Dossier fictif." },
      evidence: [], model: "offline", promptRevision: "offline", toolTrace: [], durationMs: 0 };
    } },
  };
  function load(name) {
    if (modules[name]) return modules[name];
    const loadedModule = { exports: {} };
    const compiled = ts.transpileModule(sources[name], { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText;
    const context = vm.createContext({ module: loadedModule, exports: loadedModule.exports,
      require: specifier => {
        if (["./config", "./policy"].includes(specifier)) return load(specifier.slice(2));
        if (!(specifier in dependencies)) throw new Error(`Unexpected import: ${specifier}`);
        return dependencies[specifier];
      },
      process: { env: environment }, console,
      AbortController, setTimeout, clearTimeout,
      fetch: async () => {
        calls.legacy++;
        if (response === "invalid-json") return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "not JSON" }] } }] }) };
        return { ok: false, status: 503 };
      },
    });
    vm.runInContext(compiled, context, { filename: `historical-${name}.js`, timeout: 5_000 });
    modules[name] = loadedModule.exports;
    return loadedModule.exports;
  }
  return { analyze: load("intelligence").analyzeSavMessage, policy: load("policy"), calls, traces };
}

const input = { from: "client@example.com", subject: "Utilisation", body: "Comment changer la couleur ?" };
let passed = 0;
async function check(name, test) { await test(); passed++; console.log(`PASS ${name}`); }
await check("pilot + normal entrant selects legacy, not ADK", async () => {
  const h = harness(); await h.analyze(input, { messageId: "offline" });
  assert.equal(h.calls.legacy, 1); assert.equal(h.calls.adk, 0);
});
await check("HTTP 503 becomes rules draft with succeeded trace and no error code", async () => {
  const h = harness(); const result = await h.analyze(input, { messageId: "offline" });
  assert.equal(result.model, "rules-v1"); assert.equal(result.replyDraft, h.policy.safeSavTriageDraft());
  assert.equal(h.traces[0].status, "succeeded"); assert.equal(h.traces[0].errorCode, undefined);
});
await check("invalid JSON produces the same generic draft", async () => {
  const h = harness({ response: "invalid-json" }); const result = await h.analyze(input, { messageId: "offline" });
  assert.equal(result.replyDraft, h.policy.safeSavTriageDraft()); assert.equal(h.traces[0].status, "succeeded");
});
await check("missing key also produces the same draft without network", async () => {
  const h = harness({ key: false }); const result = await h.analyze(input, { messageId: "offline" });
  assert.equal(h.calls.legacy, 0); assert.equal(result.replyDraft, h.policy.safeSavTriageDraft());
});
await check("pilot batch selects ADK but human-required draft is substituted", async () => {
  const h = harness(); const result = await h.analyze(input, { messageId: "offline", pilotBatchId: "fixture" });
  assert.equal(h.calls.adk, 1); assert.equal(h.calls.legacy, 0);
  assert.equal(result.replyDraft, h.policy.safeSavHumanHandoffDraft());
});
for (const body of ["Demande de résiliation de mon abonnement.", "Je souhaite résilier mon abonnement.", "Please cancel my subscription."]) {
  await check(`cancellation is not specifically routed and receives a generic draft: ${body}`, async () => {
    const h = harness(); const result = await h.analyze({ ...input, subject: "Abonnement", body }, { messageId: "offline" });
    assert.equal(result.proposal.kind, "ticket_pending");
    assert.equal(result.proposal.requiresHumanApproval, false);
    assert.equal(result.replyDraft, h.policy.safeSavTriageDraft());
  });
}
await check("sensitive request creates a fixed handoff draft before model invocation", async () => {
  const h = harness(); const result = await h.analyze({ ...input, body: "Je demande un remboursement." }, { messageId: "offline" });
  assert.equal(result.proposal.requiresHumanApproval, true);
  assert.equal(result.replyDraft, h.policy.safeSavHumanHandoffDraft());
  assert.equal(h.calls.legacy, 0); assert.equal(h.calls.adk, 0);
});
console.log(`${passed}/9 historical-engine checks passed; no live system accessed.`);
