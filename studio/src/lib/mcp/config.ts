/** Studio MCP kill switches, OFF unless explicitly enabled. Writes need both flags. */
export function studioMcpConfig(env: Record<string, string | undefined> = process.env) {
  const enabled = env.STUDIO_MCP_ENABLED === "true";
  return { enabled, writes: enabled && env.STUDIO_MCP_WRITES_ENABLED === "true" };
}
