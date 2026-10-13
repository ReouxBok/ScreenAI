import "server-only";

import { findEvaluationByToken } from "./evaluations";

export async function readStudioEvaluationContext(code: string) {
  const detail = await findEvaluationByToken(code);
  if (!detail || !["ready", "running"].includes(detail.run.status) || detail.item.agentKey === "sav") return null;
  return {
    runId: detail.run.id,
    expiresAt: detail.run.expiresAt.toISOString(),
    scenario: {
      id: detail.testCase.id,
      kind: detail.testCase.kind,
      title: detail.testCase.title,
      prompt: detail.testCase.prompt,
      expectation: detail.testCase.expectation,
    },
    draft: {
      id: detail.item.id,
      versionId: detail.version.id,
      title: detail.item.title,
      summary: detail.item.summary,
      bodyMarkdown: detail.version.bodyMarkdown,
      metadata: detail.version.metadata,
    },
  };
}
