import { evaluationBatchSchema, evaluationHash, type EvaluationBatch } from "../src/lib/sav/intake/server-contract";
export function evaluationBatch(): EvaluationBatch {
  const now = "2026-10-19T10:00:00.000Z";
  return evaluationBatchSchema.parse({ version: 1, campaignId: "synthetic-pilot", cases: [1, 2, 3].map(index => ({ caseId: "case-" + index,
    input: { message: { id: "10000000-0000-4000-8000-00000000000" + index, threadId: "20000000-0000-4000-8000-00000000000" + index,
      receivedAt: now, fromEmail: "fixture@example.invalid", toEmails: ["support@example.invalid"], currentText: "My product displays an error.", contentComplete: true, direction: "inbound" },
      latestInboundMessageId: "10000000-0000-4000-8000-00000000000" + index, conversation: { status: "complete", data: [], observedAt: now }, now, mode: "current", identificationAttemptId: "synthetic-" + index },
    policy: { relationRevision: "synthetic", admittedRelations: [], resources: {} },
    snapshots: { lookups: { "fixture@example.invalid": { status: "complete", data: [], observedAt: now } }, contacts: {}, associations: {}, tickets: {}, histories: {} },
  })) });
}
export function evaluationEnvironment(batch = evaluationBatch(), now = Date.now()) {
  return { NODE_ENV: "production", VERCEL_ENV: "production", SAV_INTAKE_EVAL_ENABLED: "1", SAV_INTAKE_EVAL_CAMPAIGN_ID: batch.campaignId,
    SAV_INTAKE_EVAL_MANIFEST_SHA256: evaluationHash(JSON.stringify(batch)), SAV_INTAKE_EVAL_CODE_SHA: "a".repeat(40), VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
    SAV_INTAKE_EVAL_ORIGIN: "https://studio.example.invalid", SAV_INTAKE_EVAL_EXPIRES_AT: new Date(now + 3_600_000).toISOString(), SAV_AI_MODEL: "gemini-3.6-flash",
    SAV_GEMINI_API_KEY: "synthetic-only-not-a-key", SAV_ENCRYPTION_KEY_V1: "synthetic-only-intake-server-key-at-least32" };
}
