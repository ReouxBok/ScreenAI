import { describe, expect, it } from "vitest";
import { SAV_AGENT_TOOL_NAMES } from "./contracts";
import { assertSavAgentIsolation } from "./isolation";

describe("SAV agent isolation", () => {
  it("accepts only the Gmail, HubSpot and SAV resolution tools", () => {
    expect(assertSavAgentIsolation(SAV_AGENT_TOOL_NAMES)).toBe(true);
  });

  it("rejects extension and browser tools", () => {
    expect(() => assertSavAgentIsolation([...SAV_AGENT_TOOL_NAMES, "click_element"])).toThrow("SAV_AGENT_TOOL_SCOPE_VIOLATION");
    expect(() => assertSavAgentIsolation(["inspect_current_page"])).toThrow("SAV_AGENT_TOOL_SCOPE_VIOLATION");
  });
});
