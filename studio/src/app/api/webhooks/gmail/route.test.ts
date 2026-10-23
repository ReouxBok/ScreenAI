import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ after: [] as (() => unknown)[], accept: vi.fn(), process: vi.fn(), verify: vi.fn() }));
vi.mock("next/server", () => ({ after: (work: () => unknown) => { state.after.push(work); } }));
vi.mock("@/lib/sav/gmail", () => ({ acceptGmailWebhook: state.accept, processGmailReceipt: state.process, verifyGmailWebhookRequest: state.verify }));
import { POST } from "./route";

const request = () => new Request("https://studio.example.invalid/api/webhooks/gmail", { method: "POST", body: JSON.stringify({ message: { data: "e30=" } }) });
beforeEach(() => {
  state.after = []; state.accept.mockReset(); state.process.mockReset(); state.verify.mockReset(); state.verify.mockResolvedValue(true);
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
