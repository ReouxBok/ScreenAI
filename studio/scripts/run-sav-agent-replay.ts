import "dotenv/config";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { runSavAdkAgent } from "../src/lib/sav/agent/orchestrator";

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

const apiKey = process.env.SAV_GEMINI_API_KEY;
if (!apiKey) throw new Error("SAV_GEMINI_API_KEY_MISSING");
const model = process.env.SAV_AI_MODEL ?? "gemini-3.6-flash";
const corpus = z.array(caseSchema).parse(JSON.parse(await readFile(new URL("../test/fixtures/sav-agent-replay-v1.json", import.meta.url), "utf8")));
const results = [];
for (const testCase of corpus) {
  try {
    const run = await runSavAdkAgent(testCase.input, {
      apiKey, model,
      searchKnowledge: async () => ({ revision: "sav-agent-replay-v1", results: testCase.knowledge }),
      readHubspotContext: async () => ({ contactFound: true, contactId: "fixture-contact", tickets: [], routing: { kind: "new", reason: "no_candidates", candidateIds: [] } }),
    });
    const passed = run.output.category === testCase.expected.category
      && run.output.requiresHuman === testCase.expected.requiresHuman
      && run.output.responseKind === testCase.expected.responseKind
      && (!testCase.expected.evidenceId || run.output.evidenceIds.includes(testCase.expected.evidenceId));
    results.push({ id: testCase.id, partition: testCase.partition, passed, actual: {
      category: run.output.category, requiresHuman: run.output.requiresHuman, responseKind: run.output.responseKind,
      evidenceIds: run.output.evidenceIds, totalTokens: run.totalTokens, durationMs: run.durationMs,
    } });
  } catch (error) {
    results.push({ id: testCase.id, partition: testCase.partition, passed: false, errorCode: error instanceof Error ? error.message : "UNKNOWN_ERROR" });
  }
}
const failures = results.filter((result) => !result.passed);
console.log(JSON.stringify({ corpus: "sav-agent-replay-v1", model, total: results.length, passed: results.length - failures.length, failures, results }, null, 2));
if (failures.length) process.exitCode = 1;
