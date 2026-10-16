import { z } from "zod";
import { savFactKeySchema } from "@/lib/sav/playbook-contract";

const text = z.string().trim().min(1).max(2000);
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,159}$/);
export const diagnosticKnowledgeSchema = z.object({
  requiredFacts: z.array(z.object({ key: savFactKeySchema, label: text, question: text,
    questionEn: z.string().trim().max(2000).optional(), requiredFor: z.array(id).max(50),
  }).strict()).max(50),
  checks: z.array(z.object({ id, instruction: text, expectedResult: z.string().trim().max(2000),
    ifExpected: id.nullable(), ifNot: id.nullable(), prerequisites: z.array(savFactKeySchema).max(30),
    evidenceStepId: id,
  }).strict()).max(50),
  knownCauses: z.array(z.object({ symptom: text, cause: text, fix: text, evidence: z.array(id).min(1).max(20) }).strict()).max(30),
}).strict().superRefine((value, ctx) => {
  const ids = new Set(value.checks.map(c => c.id));
  if (ids.size !== value.checks.length || new Set(value.requiredFacts.map(f => f.key)).size !== value.requiredFacts.length)
    ctx.addIssue({ code: "custom", message: "SAV_DIAGNOSTIC_IDS_MUST_BE_UNIQUE" });
  for (const check of value.checks) for (const next of [check.ifExpected, check.ifNot])
    if (next && (!ids.has(next) || next === check.id)) ctx.addIssue({ code: "custom", message: "SAV_DIAGNOSTIC_BRANCH_INVALID" });
  const finished = new Set<string>();
  const cyclic = (start: string, path: Set<string>): boolean => {
    if (path.has(start)) return true;
    if (finished.has(start)) return false;
    const check = value.checks.find(c => c.id === start);
    if (!check) return false;
    const nextPath = new Set(path).add(start);
    const result = [check.ifExpected, check.ifNot].some(next => next ? cyclic(next, nextPath) : false);
    if (!result) finished.add(start);
    return result;
  };
  if (value.checks.some(check => cyclic(check.id, new Set()))) ctx.addIssue({ code: "custom", message: "SAV_DIAGNOSTIC_CYCLE" });
  for (const fact of value.requiredFacts) if (fact.requiredFor.some(ref => !ids.has(ref))) ctx.addIssue({ code: "custom", message: "SAV_DIAGNOSTIC_FACT_REFERENCE_INVALID" });
  for (const cause of value.knownCauses) if (cause.evidence.some(ref => !ids.has(ref))) ctx.addIssue({ code: "custom", message: "SAV_DIAGNOSTIC_CAUSE_REFERENCE_INVALID" });
});
export type DiagnosticKnowledge = z.infer<typeof diagnosticKnowledgeSchema>;
