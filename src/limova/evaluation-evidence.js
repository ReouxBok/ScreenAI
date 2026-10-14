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


export function projectEvaluationObservation(action, receipt, mutation) {
  if (!mutation || action?.input?.operation !== 'read_page' || receipt?.state !== 'completed'
    || receipt.result?.status !== 'completed' || receipt.result.actionId !== action.actionId
    || receipt.result.contextVersion !== action.target?.contextVersion
    || typeof receipt.observedAt !== 'string') return null;
  const observed = Date.parse(receipt.observedAt);
  const age = Date.now() - observed;
  if (!Number.isFinite(observed) || age < 0 || age > 60_000 || observed < mutation.observedAt
    || action.target.contextVersion <= mutation.contextVersion) return null;
  try {
    const page = JSON.parse(receipt.result.observation);
    const url = new URL(page.url);
    if (url.origin !== action.target.origin || url.protocol !== 'https:' || url.username || url.password
      || url.search || url.hash || url.pathname.length > 1000
      || typeof page.text !== 'string' || !page.text.trim() || page.text.length > 32_000
      || !Number.isSafeInteger(page.contextVersion) || page.contextVersion <= action.target.contextVersion) return null;
    return { kind: 'native_verification', observation: { text: page.text, origin: url.origin, path: url.pathname,
      contextVersion: page.contextVersion, observedAt: receipt.observedAt } };
  } catch { return null; }
}
