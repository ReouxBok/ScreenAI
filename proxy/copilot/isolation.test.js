const test = require('node:test');
const assert = require('node:assert/strict');
const { EXTENSION_TOOL_NAMES, assertExtensionAgentIsolation } = require('./isolation');

test('extension harness accepts its own DOM and knowledge tools', () => {
  assert.equal(assertExtensionAgentIsolation(EXTENSION_TOOL_NAMES), true);
});

test('extension harness rejects SAV tools', () => {
  assert.throws(
    () => assertExtensionAgentIsolation([...EXTENSION_TOOL_NAMES, 'find_related_hubspot_tickets']),
    /EXTENSION_AGENT_TOOL_SCOPE_VIOLATION/,
  );
});
