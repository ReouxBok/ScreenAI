import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithSavRetrievalCardSizeFix, savRetrievalCardSizeFixOn } from "./request-retrieval";

/*
 * SAV_RETRIEVAL_CARD_SIZE_FIX scoped override (shadow replay only, 26/11): the override holds for the async work started inside
 * `runWithSavRetrievalCardSizeFix` and nowhere else, even when a request outside runs at the same time in the same process (Fluid).
 */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));
afterEach(() => { vi.unstubAllEnvs(); });

describe("SAV_RETRIEVAL_CARD_SIZE_FIX: scoped override", () => {
  it("no override: the env alone decides (absent, other values off; `on` on)", () => {
    expect(savRetrievalCardSizeFixOn()).toBe(false);
    vi.stubEnv("SAV_RETRIEVAL_CARD_SIZE_FIX", "ON");
    expect(savRetrievalCardSizeFixOn()).toBe(false);
    vi.stubEnv("SAV_RETRIEVAL_CARD_SIZE_FIX", "on");
    expect(savRetrievalCardSizeFixOn()).toBe(true);
  });
  it("concurrency: a call outside the replay, interleaved with a `run(true)`, stays off; the override never leaks after the run", async () => {
    const seenInside: boolean[] = [], seenOutside: boolean[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const outside = (async () => { for (let i = 0; i < 5; i += 1) { seenOutside.push(savRetrievalCardSizeFixOn()); await tick(); } })();
    const inside = runWithSavRetrievalCardSizeFix(true, async () => {
      seenInside.push(savRetrievalCardSizeFixOn());
      await gate;
      seenInside.push(savRetrievalCardSizeFixOn());
      await Promise.all([tick().then(() => seenInside.push(savRetrievalCardSizeFixOn())), tick()]);
      return savRetrievalCardSizeFixOn();
    });
    await tick(); release();
    expect(await inside).toBe(true);
    await outside;
    expect(seenInside).toEqual([true, true, true]);
    expect(seenOutside).toEqual([false, false, false, false, false]);
    expect(savRetrievalCardSizeFixOn()).toBe(false);
  });
  it("the override wins over the env in both directions, for its own work only", async () => {
    vi.stubEnv("SAV_RETRIEVAL_CARD_SIZE_FIX", "on");
    expect(await runWithSavRetrievalCardSizeFix(false, async () => { await tick(); return savRetrievalCardSizeFixOn(); })).toBe(false);
    expect(savRetrievalCardSizeFixOn()).toBe(true);
  });
});
