import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ after: [] as (() => unknown)[], accept: vi.fn(), process: vi.fn(), verify: vi.fn() }));
vi.mock("next/server", () => ({ after: (work: () => unknown) => { state.after.push(work); } }));
vi.mock("@/lib/sav/gmail", () => ({ acceptGmailWebhook: state.accept, processGmailReceipt: state.process, verifyGmailWebhookRequest: state.verify }));
const fallback = vi.hoisted(() => ({ run: vi.fn(), ensure: vi.fn() }));
vi.mock("@/lib/sav/self-scheduler", () => ({ runSavSelfSchedulerFromWebhook: fallback.run }));
vi.mock("@/lib/sav/self-scheduler-heartbeat", () => ({ ensureSavHeartbeat: fallback.ensure }));
const watchdog = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock("@/lib/sav/monitor-watchdog", () => ({ watchSavReconcilePulse: watchdog.watch }));
import { POST } from "./route";

const request = () => new Request("https://studio.example.invalid/api/webhooks/gmail", { method: "POST", body: JSON.stringify({ message: { data: "e30=" } }) });
beforeEach(() => {
  state.after = []; state.accept.mockReset(); state.process.mockReset(); state.verify.mockReset(); state.verify.mockResolvedValue(true);
  fallback.run.mockReset(); fallback.run.mockResolvedValue({ status: "checked" }); fallback.ensure.mockReset();
  watchdog.watch.mockReset(); watchdog.watch.mockResolvedValue({ checked: true, stale: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

it("12a. acknowledges 204 once the receipt is durable, before any model or CRM work", async () => {
  let persisted = false;
  state.accept.mockImplementation(async () => { persisted = true; return { duplicate: false, receipt: { id: "receipt-1" } }; });
  state.process.mockImplementation(() => new Promise(() => {})); // model/CRM never settle in this test
  const response = await POST(request());
  expect(response.status).toBe(204); expect(persisted).toBe(true);
  expect(state.process).not.toHaveBeenCalled();
  expect(state.after).toHaveLength(1);
  void state.after[0]();
  expect(state.process).toHaveBeenCalledWith("receipt-1");
});

it("12b. a duplicate notification is acknowledged without a second processing", async () => {
  state.accept.mockResolvedValue({ duplicate: true, receipt: { id: "receipt-1" } });
  expect((await POST(request())).status).toBe(204);
  expect(state.after).toHaveLength(0);
});

it("12c. a persistence failure is never acknowledged as success", async () => {
  state.accept.mockRejectedValue(Error("DATABASE_UNAVAILABLE"));
  const response = await POST(request());
  expect(response.status).toBe(500);
  expect(state.after).toHaveLength(0);
});

it("12d. an unauthenticated notification persists nothing", async () => {
  state.verify.mockResolvedValue(false);
  expect((await POST(request())).status).toBe(401);
  expect(state.accept).not.toHaveBeenCalled();
});

it("12e. the self-scheduler fallback runs after the 204 beside the receipt, and its failure changes neither the response nor the processing", async () => {
  state.accept.mockResolvedValue({ duplicate: false, receipt: { id: "receipt-1" } });
  state.process.mockResolvedValue(undefined);
  fallback.run.mockRejectedValue(Error("FALLBACK_EXPLODED"));
  const response = await POST(request());
  expect(response.status).toBe(204); expect(await response.text()).toBe("");
  expect(fallback.run).not.toHaveBeenCalled(); expect(state.after).toHaveLength(1);
  await expect(state.after[0]()).resolves.toBeUndefined();
  expect(state.process).toHaveBeenCalledWith("receipt-1"); expect(fallback.run).toHaveBeenCalledTimes(1);
  expect(fallback.run.mock.calls[0][0].requestStartedAt).toEqual(expect.any(Number));
  await fallback.run.mock.calls[0][0].ensureHeartbeat();
  expect(fallback.ensure).toHaveBeenCalledWith({ trigger: "gmail_webhook" });
  expect(console.error).toHaveBeenCalledWith("sav_self_scheduler_webhook", { status: "failed" });
});

it("12f. a receipt rejection does not cut the fallback: the post-commit work waits for it, then surfaces the receipt's error", async () => {
  state.accept.mockResolvedValue({ duplicate: false, receipt: { id: "receipt-2" } });
  state.process.mockRejectedValue(Error("SAV_RECEIPT_FAILED"));
  let finish!: () => void, fallbackDone = false;
  fallback.run.mockImplementation(() => new Promise<void>(resolve => { finish = () => { fallbackDone = true; resolve(); }; }));
  expect((await POST(request())).status).toBe(204);
  let settled = false;
  const work = Promise.resolve(state.after[0]()).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(fallback.run).toHaveBeenCalledTimes(1); expect(settled).toBe(false);
  finish();
  await expect(work).rejects.toThrow("SAV_RECEIPT_FAILED");
  expect(fallbackDone).toBe(true); expect(watchdog.watch).toHaveBeenCalledTimes(1);
});

it("12g. the watchdog of the scheduled catch-up runs only after the acknowledgement, with the receipt, and never for a duplicate or a rejection", async () => {
  watchdog.watch.mockReset(); watchdog.watch.mockResolvedValue({ checked: true, stale: false });
  state.accept.mockResolvedValue({ duplicate: false, receipt: { id: "receipt-2" } });
  state.process.mockResolvedValue(undefined);
  expect((await POST(request())).status).toBe(204);
  expect(watchdog.watch).not.toHaveBeenCalled();
  expect(state.after).toHaveLength(1);
  await state.after[0]();
  expect(state.process).toHaveBeenCalledWith("receipt-2"); expect(watchdog.watch).toHaveBeenCalledTimes(1);
  state.after = []; state.accept.mockResolvedValue({ duplicate: true, receipt: { id: "receipt-2" } });
  expect((await POST(request())).status).toBe(204); expect(state.after).toHaveLength(0);
  state.verify.mockResolvedValue(false);
  expect((await POST(request())).status).toBe(401);
  expect(watchdog.watch).toHaveBeenCalledTimes(1);
});
