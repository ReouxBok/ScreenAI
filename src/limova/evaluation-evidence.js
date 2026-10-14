const TOOL_NAMES = Object.freeze({
  click: 'click_element', type_text: 'fill_field', navigate: 'navigate_internal',
  scroll: 'scroll_page', read_page: 'read_page', screenshot: 'screenshot', highlight: 'highlight',
});

export function projectEvaluationAction(action, receipt) {
  const operation = action?.input?.operation;
  const toolName = Object.hasOwn(TOOL_NAMES, operation ?? '') ? TOOL_NAMES[operation] : undefined;
  if (!toolName || typeof action?.actionId !== 'string' || !action.actionId || action.actionId.length > 256) return null;
  const result = receipt?.state === 'completed' ? receipt.result : undefined;
  if (result && result.actionId !== action.actionId) return null;
  const status = result?.status === 'completed' ? 'ok'
    : result?.status === 'rejected' ? 'blocked' : 'failed';
  return { kind: 'tool_result', toolName, status,
    contextVersion: Number.isSafeInteger(action.target?.contextVersion) ? action.target.contextVersion : 0 };
}
