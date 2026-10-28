import "server-only";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { requireIntakeConsoleStaff } from "./console-auth";
import { readSavIntakeComparisonReport, runSavIntakeComparisonBatch, savIntakeComparisonConfig } from "./comparison-campaign";
const command = z.object({ stage: z.enum(["sentinels", "remaining"]), reviewed: z.boolean().default(false), expectedMessageId: z.uuid(), expectedCampaignId: z.string().regex(/^[a-z0-9-]{1,64}$/) }).strict();
type Environment = () => Record<string, string | undefined>;
type Report = Awaited<ReturnType<typeof readSavIntakeComparisonReport>>;
const detailSchema = z.object({ coverage: z.array(z.string()), simple: z.object({
  summary: z.record(z.string(), z.unknown()), technical: z.null(), uncertain: z.literal(false),
}).passthrough() }).passthrough();
async function administrator() {
  const staff = await requireIntakeConsoleStaff();
  if (staff.role !== "admin") throw Error("SAV_INTAKE_COMPARISON_UNAUTHORIZED");
  return staff;
}
function configured(env: Environment) {
  const values = env(), config = savIntakeComparisonConfig(values);
  if (!config) throw Error("SAV_INTAKE_COMPARISON_CONFIGURATION_REQUIRED");
  if (config.messageIds.length < 10 || config.messageIds.length > 60) throw Error("SAV_INTAKE_COMPARISON_SCOPE_INVALID");
  if ((values.SAV_INTAKE_PIPELINE ?? "current") !== "current") throw Error("SAV_INTAKE_COMPARISON_LIVE_READER_CHANGED");
  return config;
}
/** Completion is not semantic approval: the administrator must additionally attest that
 * the ten independent references were checked. Current-reader failures stay visible. */
export function comparisonSentinelsReady(report: Report) {
  return report.configured && report.rows.slice(0, 10).length === 10
    && report.rows.slice(0, 10).every(row => row.state === "done" && detailSchema.safeParse(row.detail).success
      && detailSchema.parse(row.detail).coverage.length === 0);
}
/** A lost response/unfinished claim or unusable simple result must not advance
 * to a second dossier merely because its claim is already taken. */
export function comparisonPhaseCanContinue(report: Report, stage: "sentinels" | "remaining") {
  if (!report.configured) return false;
  const rows = stage === "sentinels" ? report.rows.slice(0, 10) : report.rows.slice(10);
  return rows.every(row => row.state === "pending" || row.state === "done" && detailSchema.safeParse(row.detail).success
    && detailSchema.parse(row.detail).coverage.length === 0);
}
export async function readIntakeComparisonPanel() {
  await administrator();
  return readSavIntakeComparisonReport();
}
/** Only the reviewed campaign list from the server grants scope. Rendered campaign/dossier
 * tokens detect stale commands; they cannot select another ID, model, transport or money limit. */
export async function runIntakeComparisonOperator(raw: unknown, options: { env?: Environment; network?: typeof fetch } = {}) {
  const staff = await administrator(), input = command.parse(raw), env = options.env ?? (() => process.env), config = configured(env);
  if (input.expectedCampaignId !== config.campaignId) throw Error("SAV_INTAKE_COMPARISON_STALE_COMMAND");
  const report = await readSavIntakeComparisonReport(env);
  if (input.stage === "remaining") {
    if (!input.reviewed || !comparisonSentinelsReady(report)) throw Error("SAV_INTAKE_COMPARISON_SENTINELS_REVIEW_REQUIRED");
  }
  if (!comparisonPhaseCanContinue(report, input.stage)) throw Error("SAV_INTAKE_COMPARISON_PREVIOUS_RESULT_REVIEW_REQUIRED");
  if (!report.configured) throw Error("SAV_INTAKE_COMPARISON_CONFIGURATION_REQUIRED");
  const rows = input.stage === "sentinels" ? report.rows.slice(0, 10) : report.rows.slice(10);
  const next = rows.find(row => row.state === "pending");
  if (!next) return { campaignId: config.campaignId, compared: [] };
  const allowed = input.stage === "sentinels" ? config.messageIds.slice(0, 10) : config.messageIds.slice(10);
  if (!allowed.includes(next.messageId)) throw Error("SAV_INTAKE_COMPARISON_SCOPE_INVALID");
  // A delayed replay of a previously rendered form must never select a later dossier.
  if (next.messageId !== input.expectedMessageId) throw Error("SAV_INTAKE_COMPARISON_STALE_COMMAND");
  const signature = JSON.stringify(config), scoped = { ...config,
    // Concurrent submissions select the SAME next ID. The durable claim lets only
    // one run; the loser cannot silently pay for the following dossier.
    messageIds: [next.messageId],
    maxNanoUsd: Math.min(config.maxNanoUsd, input.stage === "sentinels" ? 5_000_000_000 : 20_000_000_000) };
  if (!scoped.messageIds.length) throw Error("SAV_INTAKE_COMPARISON_SCOPE_INVALID");
  const scopedEnvironment = () => {
    if (JSON.stringify(configured(env)) !== signature) throw Error("SAV_INTAKE_COMPARISON_CONFIGURATION_CHANGED");
    return { ...env(), SAV_INTAKE_COMPARISON_JSON: JSON.stringify(scoped) };
  };
  await requireDb().insert(auditLogs).values({ actorEmail: staff.email, action: "sav_intake_comparison_operator",
    entityType: "sav_intake_comparison", entityId: config.campaignId,
    technicalMetadata: { stage: input.stage, reviewed: input.reviewed, maximumNanoUsd: scoped.maxNanoUsd, listed: scoped.messageIds.length } });
  // One dossier per request keeps the work within the function's duration. The
  // existing durable claims prevent a double click or interrupted batch from resending.
  return runSavIntakeComparisonBatch({ env: scopedEnvironment, ...(options.network ? { network: options.network } : {}), limit: 1 });
}
