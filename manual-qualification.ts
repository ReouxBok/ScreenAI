import "server-only";
import { z } from "zod";
import { readSavV2QualificationScope } from "./qualification-scope";

const proof = z.object({ scopeHash: z.string().regex(/^[a-f0-9]{64}$/), executionId: z.uuid(), runVersion: z.number().int().positive(), caseId: z.uuid() }).strict();
export const manualQualificationRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("preview"), messageId: z.uuid() }).strict(),
  z.object({ operation: z.literal("run"), messageId: z.uuid(), expected: proof }).strict(),
]);
type Target = { executionId: string; runId: string | null; runVersion: number; ticketId: string; caseId: string };
export type ManualQualificationPorts = {
  now(): Date;
  paused(): Promise<boolean>;
  target(messageId: string): Promise<Target | null>;
  eligible(messageId: string, target: Target): Promise<boolean>;
  relay(messageId: string): Promise<{ caseId?: string; owner?: string }>;
  continue(caseId: string): Promise<{ status: string }>;
};
/** One explicit operator passage, never a sweep or a substitute model prompt. A preview is read-only.
 * Every live gate is rechecked on run; the canonical relay/continuation keep their own locks and receipts.
 * An expected proof prevents a stale preview from silently switching source, case or scope. It is not an auth token.
 */
export async function manualQualification(raw: unknown, env: Record<string, string | undefined>, ports: ManualQualificationPorts) {
  const request = manualQualificationRequest.parse(raw);
  const scope = readSavV2QualificationScope(env, ports.now());
  if (scope.mode !== "qualification") return { status: "refused", code: scope.mode === "closed" ? scope.problem : "qualification_required" } as const;
  if (env.SAV_CASE_RECORDING !== "on" || env.SAV_V2_ENTRY !== "on" || env.SAV_V2_INVESTIGATION !== "observe") return { status: "refused", code: "investigation_off" } as const;
  if (await ports.paused()) return { status: "refused", code: "paused" } as const;
  const target = await ports.target(request.messageId);
  if (!target || !await ports.eligible(request.messageId, target)) return { status: "refused", code: "source_not_eligible" } as const;
  const expected = { scopeHash: scope.configHash, executionId: target.executionId, runVersion: target.runVersion, caseId: target.caseId };
  if (request.operation === "preview") return { status: "ready", messageId: request.messageId, ticketId: target.ticketId, expected, expiresAt: scope.scope.expiresAt } as const;
  if (Object.keys(expected).some(key => expected[key as keyof typeof expected] !== request.expected[key as keyof typeof expected])) return { status: "refused", code: "preview_stale" } as const;
  const relay = await ports.relay(request.messageId);
  if (relay.caseId !== target.caseId || relay.owner !== "agent") return { status: "refused", code: "relay_not_agent" } as const;
  const current = readSavV2QualificationScope(env, ports.now());
  if (current.mode !== "qualification" || current.configHash !== expected.scopeHash || await ports.paused() || !await ports.eligible(request.messageId, target)) return { status: "refused", code: "gate_changed" } as const;
  // The continuation re-reads the owner, admission, pauses, expiry and budget before every cost.
  const result = await ports.continue(target.caseId);
  return { status: "attempted", caseId: target.caseId, ticketId: target.ticketId, outcome: /^[a-z0-9_]{1,80}$/.test(result.status) ? result.status : "unknown" } as const;
}
