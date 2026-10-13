import { Gemini } from "@google/adk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSavAdkAgent } from "./orchestrator";
import { SAV_AGENT_TOOL_NAMES, type SavAgentOutput } from "./contracts";
import type { readSavHubspotContext } from "../hubspot";

vi.mock("@/lib/search", () => ({ searchKnowledge: vi.fn() }));
vi.mock("../hubspot", () => ({ readSavHubspotContext: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

const output: SavAgentOutput = {
  category: "technical", urgency: "normal", ticketRequired: true,
  reasonCode: "needs_review", explanation: "Une vérification humaine est nécessaire.",
  confidence: 0.7, requiresHuman: true, responseKind: "none", replyDraft: "",
  internalNote: "", evidenceIds: [], citations: [],
};

describe("installed SAV ADK runner", () => {
  it.each([false, true])("preserves read-only tool execution and rejects unavailable evidence (%s)", async (failedSearch) => {
    let calls = 0;
    const model = vi.spyOn(Gemini.prototype, "generateContentAsync").mockImplementation(async function* () {
      calls += 1;
      if (calls === 1) {
        yield { content: { role: "model", parts: SAV_AGENT_TOOL_NAMES.map((name, index) => ({
          functionCall: { id: `sav-call-${index}`, name, args: name === "search_resolution_cards" ? { query: "connexion" } : {} },
        })) } };
      } else if (calls === 2) {
        yield { content: { role: "model", parts: [{ functionCall: { id: "sav-output", name: "set_model_response", args: output } }] } };
      } else {
        throw new Error("UNEXPECTED_MODEL_RETRY");
      }
    });
    const searchKnowledge = vi.fn(async () => {
      if (failedSearch) throw new Error("SEARCH_UNAVAILABLE");
      return { results: [], revision: "test" };
    });
    const readHubspotContext = vi.fn<typeof readSavHubspotContext>(async () => ({
      contactFound: false, contactId: undefined, tickets: [],
      routing: { kind: "new", reason: "no_open_ticket", candidateIds: [] },
    }));
    const pending = runSavAdkAgent({ from: "fixture@example.test", subject: "Connexion", body: "Je ne peux pas me connecter." }, {
      apiKey: "unused-test-key", model: "local-fixture", searchKnowledge, readHubspotContext,
    });
    if (failedSearch) {
      await expect(pending).rejects.toThrow("SAV_REQUIRED_TOOL_UNAVAILABLE:search_resolution_cards");
    } else {
      const result = await pending;
      expect(result.output).toEqual(output);
      expect(result.evidence).toEqual([]);
      expect(result.toolTrace.map((trace) => trace.name).sort()).toEqual([...SAV_AGENT_TOOL_NAMES].sort());
      expect(result.toolTrace.every((trace) => trace.status === "succeeded")).toBe(true);
    }
    expect(model).toHaveBeenCalledTimes(2);
    expect(searchKnowledge).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scope: "sav", contentTypes: ["article"] }));
    expect(readHubspotContext).toHaveBeenCalledExactlyOnceWith({ email: "fixture@example.test", subject: "Connexion", currentTicketId: undefined });
  });
});
