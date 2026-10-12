import { readFile } from "node:fs/promises";
import { z } from "zod";
import { analyzeSavMessage } from "../src/lib/sav/intelligence";

const caseSchema = z.object({
  id: z.string(),
  partition: z.enum(["development", "control"]),
  input: z.object({ from: z.string(), subject: z.string(), body: z.string() }),
  knowledge: z.array(z.object({
    id: z.string(), title: z.string(), content: z.string(), score: z.number(), source: z.string(), verifiedAt: z.string(),
    resolution: z.record(z.string(), z.unknown()),
  })),
  expected: z.object({
    category: z.string(), requiresHuman: z.boolean(), responseKind: z.string(), evidenceId: z.string().optional(),
  }),
});

// Smoke fixtures only, never a release-quality score. Use a dedicated evaluation key.
if (Object.keys(process.env).some(name => /DATABASE_URL|HUBSPOT.*(?:TOKEN|SECRET)|GMAIL.*(?:TOKEN|SECRET)|SAV_GEMINI_API_KEY/.test(name) && process.env[name])) throw new Error("SAV_EVALUATION_CREDENTIALS_NOT_ISOLATED");
const apiKey = process.env.SAV_EVAL_GEMINI_API_KEY;
if (!apiKey) throw new Error("SAV_EVAL_GEMINI_API_KEY_MISSING");
const model = process.env.SAV_AI_MODEL ?? "gemini-3.6-flash";
const corpus = z.array(caseSchema).parse(JSON.parse(await readFile(new URL("../test/fixtures/sav-agent-replay-v1.json", import.meta.url), "utf8")));
const results = [];
for (const testCase of corpus) {
  try {
    const run = await analyzeSavMessage(testCase.input, { evaluation: {
      apiKey, model, mode: "on",
      searchKnowledge: async () => ({ revision: "sav-agent-replay-v1", results: testCase.knowledge }),
      readHubspotContext: async () => ({ errorCode: null, contactFound: true, contactId: "fixture-contact", identityCandidates: [], tickets: [], routing: { kind: "new", reason: "no_candidates", candidateIds: [] } }),
    } });
    const passed = run.category === testCase.expected.category
      && run.proposal.requiresHumanApproval === testCase.expected.requiresHuman
      && run.replyAssessment?.kind === (testCase.expected.responseKind === "handoff" ? "human_handoff" : "contextualized")
      && (!testCase.expected.evidenceId || run.evidence.some(e => e.sourceId === testCase.expected.evidenceId));
    results.push({ id: testCase.id, partition: testCase.partition, passed, actual: {
      category: run.category, requiresHuman: run.proposal.requiresHumanApproval, replyKind: run.replyAssessment?.kind,
      evidenceIds: run.evidence.map(e => e.sourceId), totalTokens: (run.understanding?.trace.totalTokens ?? 0) + (run.generationMetadata?.totalTokens ?? 0) + (run.replyAssessment?.coherence?.totalTokens ?? 0), durationMs: (run.understanding?.trace.durationMs ?? 0) + (run.generationDurationMs ?? 0) + (run.replyAssessment?.coherence?.durationMs ?? 0),
    } });
  } catch (error) {
    results.push({ id: testCase.id, partition: testCase.partition, passed: false, errorCode: error instanceof Error ? error.message : "UNKNOWN_ERROR" });
  }
}
const failures = results.filter((result) => !result.passed);
console.log(JSON.stringify({ purpose: "synthetic_smoke_not_release_evaluation", corpus: "sav-agent-replay-v1", model, total: results.length, passed: results.length - failures.length, failures, results }, null, 2));
if (failures.length) process.exitCode = 1;
