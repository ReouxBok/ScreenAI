import { describe, expect, it } from "vitest";
import { chunkPilotItemIds, SAV_PILOT_WORKFLOW_CONCURRENCY } from "./index";

describe("SAV pilot workflow batching", () => {
  it("limits the default AI concurrency to three messages", () => {
    const ids = Array.from({ length: 10 }, (_, index) => `mail-${index + 1}`);
    expect(SAV_PILOT_WORKFLOW_CONCURRENCY).toBe(3);
    expect(chunkPilotItemIds(ids)).toEqual([
      ["mail-1", "mail-2", "mail-3"],
      ["mail-4", "mail-5", "mail-6"],
      ["mail-7", "mail-8", "mail-9"],
      ["mail-10"],
    ]);
  });

  it("never creates a zero-sized execution group", () => {
    expect(chunkPilotItemIds(["mail-1", "mail-2"], 0)).toEqual([["mail-1"], ["mail-2"]]);
  });
});
