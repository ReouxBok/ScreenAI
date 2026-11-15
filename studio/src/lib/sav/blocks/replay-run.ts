import { runSavBlockReplay, SAV_REPLAY_LIMITS, type SavReplayItem, type SavReplayPorts, type SavReplayReport } from "./block-replay";
import type { SavBlockAttributionThresholds, SavBlockDraft } from "./block-attribution";
import { createSavReplayDecisionPort, createSavReplaySpendMeter, createSavReplayStubModel, type SavReplayModelTransport, type SavReplaySpendTotals } from "./replay-decision";
import { savReplayMarkdownSummary } from "./replay-summary";

/*
 * SAV-92 harness, phase 1b: the server-side entry of « Rejouer sur de vrais mails » (no HTTP route). Stored mails (Gmail ids), stored
 * cases or inline phrases are replayed for ONE block: attribution by cards, then, for the mails that block takes, the real V2 decision
 * path in memory (`replay-decision.ts`). Returns the JSON report and a short French summary. The read ports and the model are injected:
 * the stub is the default; the live model exists only when the caller builds it (`replay-decision-live.ts`). Zero effect.
 */

export type SavBlockReplayRunInput = Readonly<{
  blockId: string; blocks: readonly SavBlockDraft[]; items: readonly SavReplayItem[]; now: Date;
  /** Read-only ports (`createSavReplayReadPorts`, or fakes); no `decide` port: it is built here on the given model. */
  ports: Omit<SavReplayPorts, "decide">;
  /** Default: the deterministic stub (no network, no cost). */
  model?: SavReplayModelTransport;
  /** Per-run cap (default 2 USD, at most 10 USD) and per-mail cap (default 0.5 USD, at most the run cap). */
  budget?: Readonly<{ runUsd?: number; mailUsd?: number }>;
  locale?: string; thresholds?: SavBlockAttributionThresholds;
}>;
export type SavBlockReplayRunResult = Readonly<{ report: SavReplayReport; summary: string; spend: SavReplaySpendTotals; model: string; transport: "stub" | "live" }>;

export async function runSavBlockReplayWithDecision(input: SavBlockReplayRunInput): Promise<SavBlockReplayRunResult> {
  if (!input.blocks.some(block => block.blockId === input.blockId)) throw new Error("SAV_REPLAY_BLOCK_UNKNOWN");
  const meter = createSavReplaySpendMeter({ ...(input.budget?.runUsd !== undefined ? { runCapUsd: input.budget.runUsd } : {}), ...(input.budget?.mailUsd !== undefined ? { mailCapUsd: input.budget.mailUsd } : {}) });
  const model = input.model ?? createSavReplayStubModel();
  const decide = createSavReplayDecisionPort({ model, meter, now: input.now, ...(input.locale ? { locale: input.locale } : {}) });
  const report = await runSavBlockReplay(input.items, {
    blocks: input.blocks, now: input.now, ...(input.locale ? { locale: input.locale } : {}), ...(input.thresholds ? { thresholds: input.thresholds } : {}),
    // The meter is the authority on money; the replay's own bound only caps the number of decided mails.
    decision: { enabled: true, blockId: input.blockId, maxCalls: SAV_REPLAY_LIMITS.decisionMaxCalls, maxCostUsd: meter.runCapUsd },
  }, { ...input.ports, decide });
  const spend = meter.totals();
  return { report, spend, model: model.model, transport: model.kind, summary: savReplayMarkdownSummary(report, { blockId: input.blockId, model: model.model, transport: model.kind, spend }) };
}
