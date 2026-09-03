import { EXTENSION_ONLY_TOOL_NAMES, SAV_AGENT_TOOL_NAMES } from "./contracts";

const forbiddenSavFragments = ["dom", "page", "navigate", "click", "fill_field", "onboarding", "extension"];

export function assertSavAgentIsolation(toolNames: readonly string[] = SAV_AGENT_TOOL_NAMES) {
  const normalized = toolNames.map((name) => name.toLocaleLowerCase("en"));
  const overlap = normalized.filter((name) => (EXTENSION_ONLY_TOOL_NAMES as readonly string[]).includes(name));
  if (overlap.length) throw new Error(`SAV_AGENT_TOOL_SCOPE_VIOLATION:${overlap.join(",")}`);
  const suspicious = normalized.filter((name) => forbiddenSavFragments.some((fragment) => name.includes(fragment)));
  if (suspicious.length) throw new Error(`SAV_AGENT_TOOL_SCOPE_VIOLATION:${suspicious.join(",")}`);
  return true;
}
