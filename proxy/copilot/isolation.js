const EXTENSION_TOOL_NAMES = new Set([
  'inspect_current_page',
  'capture_current_view',
  'click_element',
  'fill_field',
  'scroll_page',
  'navigate_internal',
  'verify_expected_result',
  'search_knowledge_base'
]);

const FORBIDDEN_SAV_FRAGMENTS = ['gmail', 'hubspot', 'ticket', 'support_message', 'resolution_cards', 'sav_'];

function assertExtensionAgentIsolation(toolNames) {
  const names = [...toolNames].map(name => String(name).toLowerCase());
  const unknown = names.filter(name => !EXTENSION_TOOL_NAMES.has(name));
  const savScoped = names.filter(name => FORBIDDEN_SAV_FRAGMENTS.some(fragment => name.includes(fragment)));
  const violations = [...new Set([...unknown, ...savScoped])];
  if (violations.length) throw new Error(`EXTENSION_AGENT_TOOL_SCOPE_VIOLATION:${violations.join(',')}`);
  return true;
}

module.exports = { EXTENSION_TOOL_NAMES, assertExtensionAgentIsolation };
