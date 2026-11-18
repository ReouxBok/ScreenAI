import { describe, expect, expectTypeOf, it } from "vitest";
import { CORPUS_GROUPS, type CorpusCase, type CorpusGroup, type CorpusLabel, type RequestRoute } from "./corpus-contract";

describe("corpus contract", () => {
  it("exposes each supported group exactly once", () => {
    expect(CORPUS_GROUPS).toEqual(["positive", "neighbour", "sensitive", "mixed", "trap"]);
    expectTypeOf<CorpusCase["group"]>().toEqualTypeOf<CorpusGroup>();
  });

  it("can label multiple requests independently and reserves sensitivity for expected labels", () => {
    const row = {
      id: "two-requests", group: "mixed", text: "The export is stuck. Could you also cancel the next charge?",
      requests: [
        { requestId: "export", expected: { kind: "block", blockId: "exports" } },
        { requestId: "charge", expected: { kind: "sensitive" } },
      ],
    } as const satisfies CorpusCase;
    expect(row.requests.map(({ expected }) => expected.kind)).toEqual(["block", "sensitive"]);
    expectTypeOf<Exclude<CorpusLabel, RequestRoute>>().toEqualTypeOf<Readonly<{ kind: "sensitive" }>>();
  });
});
