import { afterEach, expect, it, vi } from "vitest";
import { loadSavHubspotTicketEmails } from "./hubspot";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("blocks incomplete learning evidence before a bounded CRM batch can omit emails", async () => {
  const network = vi.fn(); vi.stubGlobal("fetch", network);
  const emails = Array.from({ length: 201 }, (_, n) => ({ id: String(n) }));
  await expect(loadSavHubspotTicketEmails({ id: "synthetic-ticket", properties: {}, associations: { emails: { results: emails } } })).rejects.toThrow("HUBSPOT_EMAILS_TRUNCATED");
  expect(network).not.toHaveBeenCalled();
});
