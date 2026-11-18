export const CORPUS_GROUPS = ["positive", "neighbour", "sensitive", "mixed", "trap"] as const;
export type CorpusGroup = typeof CORPUS_GROUPS[number];

export type RequestRoute =
  | Readonly<{ kind: "block"; blockId: string }>
  | Readonly<{ kind: "team" }>
  | Readonly<{ kind: "clarify" }>;

/** A sensitive request requires the whole mail to stay with the team. */
export type CorpusLabel = RequestRoute | Readonly<{ kind: "sensitive" }>;

export type CorpusRequest = Readonly<{ requestId: string; expected: CorpusLabel }>;

/** An authored fictional case. Request IDs are local to the case. */
export type CorpusCase = Readonly<{
  id: string;
  group: CorpusGroup;
  requests: readonly CorpusRequest[];
  subject?: string;
  text: string;
}>;
