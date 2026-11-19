import { SAV_BENCH_CORPUS_A } from "./bench-corpus-a.fixture";
import { SAV_BENCH_CORPUS_B } from "./bench-corpus-b.fixture";
import { SAV_BENCH_CORPUS_C } from "./bench-corpus-c.fixture";
import { SAV_BENCH_CORPUS_D } from "./bench-corpus-d.fixture";
import { savBenchConversationSchema, type SavBenchConversation, type SavBenchConversationInput, type SavBenchFamily } from "./bench-types";

/*
 * SAV-109: the bench corpus, v1 (120 fictional conversations, 6 per family). Written by agents other than the agent's builders, without reading
 * the agent's skills. Extensible to 500: add a file `bench-corpus-<x>.fixture.ts` and list it here; `bench-corpus.test.ts` keeps it valid
 * (schema, known cards, fictional addresses, unique ids, no near duplicate).
 */
export const SAV_BENCH_CORPUS_REVISION = "sav-bench-corpus-2026-11-20.v1";
export const SAV_BENCH_CORPUS_SOURCES: readonly (readonly SavBenchConversationInput[])[] = [SAV_BENCH_CORPUS_A, SAV_BENCH_CORPUS_B, SAV_BENCH_CORPUS_C, SAV_BENCH_CORPUS_D];
export const SAV_BENCH_CORPUS: readonly SavBenchConversation[] = SAV_BENCH_CORPUS_SOURCES.flat().map(row => savBenchConversationSchema.parse(row));

export function savBenchCorpusCounts(corpus: readonly SavBenchConversation[] = SAV_BENCH_CORPUS) {
  const byFamily: Partial<Record<SavBenchFamily, number>> = {};
  for (const row of corpus) byFamily[row.family] = (byFamily[row.family] ?? 0) + 1;
  return { conversations: corpus.length, turns: corpus.reduce((n, row) => n + row.turns.length, 0), risky: corpus.filter(row => row.risky).length, byFamily };
}

/** Selects the conversations of a run: all, the risky subset, some families, or some ids. */
export function selectSavBenchCorpus(options: Readonly<{ subset?: "all" | "risky"; families?: readonly string[]; ids?: readonly string[]; limit?: number }>, corpus = SAV_BENCH_CORPUS) {
  let rows = corpus.filter(row => options.subset !== "risky" || row.risky);
  if (options.families?.length) rows = rows.filter(row => options.families!.includes(row.family));
  if (options.ids?.length) rows = rows.filter(row => options.ids!.includes(row.id));
  return options.limit ? rows.slice(0, options.limit) : rows;
}
