import { afterEach, describe, expect, it, vi } from "vitest";
import { createSavHubspotTransport } from "./hubspot-transport";
import { readSavTicketHistory } from "./ticket-history";

const snapshot = new Date("2026-10-16T10:00:00Z");
const occurredAt = "2026-10-15T09:00:00Z";
type Read = Parameters<typeof readSavTicketHistory>[2];

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function delayedTransport() {
  let active = 0, peak = 0;
  const network = vi.fn<typeof fetch>(async (url, init) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 200));
    active--;
    if (String(url).includes("/associations/")) return Response.json({ results: [{ toObjectId: 10 }] });
    const id = JSON.parse(String(init?.body)).inputs[0].id;
    return Response.json({ status: "COMPLETE", results: [{ id, updatedAt: occurredAt,
      properties: { hs_timestamp: occurredAt, hs_note_body: "Note vérifiée", hs_email_text: "Email vérifié" } }] });
  });
  const transport = createSavHubspotTransport(network);
  const read: Read = (path, init) => transport(path, init ?? {}, status => `HUBSPOT_HTTP_${status}`);
  return { read, network, peak: () => peak, active: () => active };
}

describe("parallel associated HubSpot history", () => {
  it.each([{ tickets: ["1"], duration: 400, concurrency: 2 }, { tickets: ["1", "2"], duration: 600, concurrency: 3 }])(
    "finishes $tickets in $duration ms with the existing transport limit", async ({ tickets, duration, concurrency }) => {
      vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-19T10:00:00Z"));
      vi.spyOn(console, "info").mockImplementation(() => {});
      const fixture = delayedTransport(), started = Date.now();
      let elapsed = 0;
      const pending = readSavTicketHistory(tickets, snapshot, fixture.read).then(result => { elapsed = Date.now() - started; return result; });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(elapsed).toBe(duration);
      expect(fixture.peak()).toBe(concurrency);
      expect(fixture.active()).toBe(0);
      expect(fixture.network).toHaveBeenCalledTimes(tickets.length * 4);
      expect(result.events).toHaveLength(tickets.length * 2);
      expect(result.limitations).toEqual([]);
      for (const [url, init] of fixture.network.mock.calls) {
        expect(!init?.method || init.method === "POST" && String(url).endsWith("/batch/read")).toBe(true);
      }
    },
  );

  it("keeps a stable result and text budget regardless of completion order", async () => {
    vi.useFakeTimers();
    async function run(reverse: boolean) {
      const read: Read = async <T>(path: string): Promise<T> => {
        const ticketId = path.includes("/tickets/1/") ? "1" : "2";
        const slow = path.includes("/notes") !== reverse;
        await new Promise(resolve => setTimeout(resolve, slow ? 100 : 10));
        if (path.includes("/associations/")) return { results: [{ toObjectId: 10 }], paging: { next: {} } } as T;
        return { status: "COMPLETE", results: [{ id: "10", updatedAt: occurredAt, properties: {
          hs_timestamp: occurredAt, hs_note_body: `note${ticketId}`.repeat(400), hs_email_text: "email".repeat(400),
        } }] } as T;
      };
      const pending = readSavTicketHistory(["1", "2"], snapshot, read);
      await vi.runAllTimersAsync();
      return pending;
    }
    const first = await run(false), second = await run(true);
    expect(first).toEqual(second);
    expect(first.events.map(e => [e.kind, e.ticketId])).toEqual([["email", "1"], ["email", "2"], ["note", "1"], ["note", "2"]]);
    expect(first.events.reduce((sum, e) => sum + e.text.length, 0)).toBe(6000);
    expect(first.limitations).toEqual(["emails_association_limit", "history_content_limited", "notes_association_limit"]);
  });

  it("keeps successful email history when the notes branch reaches the shared deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), signals: AbortSignal[] = [];
    const read: Read = async <T>(path: string, init?: RequestInit): Promise<T> => {
      signals.push(init!.signal!);
      if (init?.signal?.aborted) throw new Error("cancelled");
      if (path.includes("/notes")) await new Promise<void>((_, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
      if (path.includes("/associations/")) return { results: [{ toObjectId: 10 }] } as T;
      return { status: "COMPLETE", results: [{ id: "10", properties: { hs_timestamp: occurredAt, hs_email_text: "Email conservé" } }] } as T;
    };
    const pending = readSavTicketHistory(["1"], snapshot, read, controller.signal);
    setTimeout(() => controller.abort(), 8000);
    await vi.advanceTimersByTimeAsync(8000);
    const result = await pending;
    expect(result.events).toEqual([expect.objectContaining({ kind: "email", text: "Email conservé" })]);
    expect(result.limitations).toEqual(["notes_unavailable"]);
    expect(signals.every(signal => signal === controller.signal)).toBe(true);
  });
});
