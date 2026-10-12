import { z } from "zod";
import { deterministicDecision } from "./policy";
export const SAV_RULE_REPLAY_REVISION = "sav-technical-preflight-replay-v2";

export const savReplayCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  partition: z.enum(["development", "control"]),
  input: z.object({ from: z.string(), subject: z.string(), body: z.string(), autoSubmitted: z.string().optional() }),
  expected: z.object({ kind: z.string(), requiresHumanApproval: z.boolean() }),
}).strict();

export type SavReplayCase = z.infer<typeof savReplayCaseSchema>;

export function runSavRuleReplay(rawCases: unknown) {
  const cases = z.array(savReplayCaseSchema).min(1).parse(rawCases);
  const results = cases.map((testCase) => {
    const actual = deterministicDecision(testCase.input);
    const evaluated = actual.reasonCode !== "semantic_understanding_required";
    const passed = evaluated && actual.kind === testCase.expected.kind && actual.requiresHumanApproval === testCase.expected.requiresHumanApproval;
    return { id: testCase.id, partition: testCase.partition, passed, evaluated, expected: testCase.expected, actual: { kind: actual.kind, requiresHumanApproval: actual.requiresHumanApproval, reasonCode: actual.reasonCode } };
  });
  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => result.evaluated && !result.passed).length,
    notEvaluated: results.filter((result) => !result.evaluated).length,
    development: results.filter((result) => result.partition === "development"),
    control: results.filter((result) => result.partition === "control"),
    results,
  };
}
