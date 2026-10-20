// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
import { SavContextProgress } from "./context-progress";
let host: HTMLDivElement, root: Root;
const fetchStatus = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchStatus);
  window.history.replaceState(null, "", "/studio/sav/thread?review=saved&refreshId=request#sav-draft");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render() { await act(async () => { root.render(createElement(SavContextProgress, { threadId: "thread", requestId: "request" })); }); }
it.each(["completed", "failed"])("refreshes data on %s without navigating over a pending action", async context => {
  const url = window.location.href;
  fetchStatus.mockResolvedValue({ ok: true, json: async () => ({ context }) });
  await render();
  expect(router.refresh).toHaveBeenCalledTimes(1); expect(router.replace).not.toHaveBeenCalled();
  expect(window.location.href).toBe(url);
  expect(host.textContent).toContain(context === "completed" ? "Contexte client actualisé." : "Contexte non confirmé.");
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(fetchStatus).toHaveBeenCalledTimes(1);
});
it("keeps pending or failed HTTP reads recoverable without reporting completion", async () => {
  fetchStatus.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => ({ context: "pending" }) });
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(fetchStatus).toHaveBeenCalledTimes(2); expect(router.refresh).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Actualisation du contexte client en cours");
  expect(fetchStatus.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
});
it("stops polling at the existing limit and never invents a successful result", async () => {
  fetchStatus.mockResolvedValue({ ok: true, json: async () => ({ context: "pending" }) });
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
  expect(fetchStatus).toHaveBeenCalledTimes(100);
  expect(host.textContent).toContain("Contexte non confirmé.");
  expect(router.refresh).not.toHaveBeenCalled(); expect(router.replace).not.toHaveBeenCalled();
});
it("ignores a decoded receipt arriving after unmount and cancels its request", async () => {
  let complete!: (value: { context: string }) => void;
  fetchStatus.mockResolvedValue({ ok: true, json: () => new Promise(resolve => { complete = resolve; }) });
  await render();
  await act(async () => root.render(null));
  expect(fetchStatus.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => { complete({ context: "completed" }); });
  expect(router.refresh).not.toHaveBeenCalled(); expect(router.replace).not.toHaveBeenCalled();
});
