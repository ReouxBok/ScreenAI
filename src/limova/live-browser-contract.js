export const liveUuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const natural = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max, min = 0) => typeof value === 'string' && value.length >= min && value.length <= max;

export function validLiveBrowserPage(page) {
  if (!keys(page, ['tabId', 'origin', 'contextVersion']) || !natural(page.tabId)
    || !natural(page.contextVersion) || !text(page.origin, 2048, 1)) return false;
  try { const url = new URL(page.origin); return url.protocol === 'https:' && url.origin === page.origin; }
  catch { return false; }
}

export function liveBrowserBinding(session, page) {
  if (session === undefined && page === undefined) return {};
  if (!liveUuid(session) || !validLiveBrowserPage(page)) throw new TypeError('Invalid live browser binding');
  return { browserSession: session, browserContext: { ...page } };
}

export function liveBrowserContinuation(value) {
  if (!keys(value, ['turnId', 'kind', 'browserContext', 'browserResult', 'browserTurnId'])
    || !liveUuid(value.turnId) || !validLiveBrowserPage(value.browserContext)) throw new TypeError('Invalid live browser continuation');
  const payload = { turnId: value.turnId, kind: value.kind, browserContext: { ...value.browserContext } };
  if (value.kind === 'browser_resume' && liveUuid(value.browserTurnId) && value.browserResult === undefined) {
    return { ...payload, browserTurnId: value.browserTurnId };
  }
  const result = value.browserResult;
  if (value.kind !== 'browser_tool_result' || value.browserTurnId !== undefined
    || !keys(result, ['turnId', 'actionId', 'toolCallId', 'contextVersion', 'status', 'observation', 'imageFileId', 'pageContext'])
    || !liveUuid(result.turnId) || !text(result.actionId, 256, 1) || !text(result.toolCallId, 128, 1)
    || !natural(result.contextVersion) || !['completed', 'rejected', 'failed'].includes(result.status)
    || !text(result.observation, 32000) || (result.imageFileId !== undefined && !liveUuid(result.imageFileId))
    || (result.pageContext !== undefined && !validLiveBrowserPage(result.pageContext))) throw new TypeError('Invalid live browser result');
  return { ...payload, browserResult: structuredClone(result) };
}

export function liveBrowserContextReply(value) {
  if (!keys(value, ['turnId', 'requestId', 'browserContext']) || !liveUuid(value.turnId)
    || !liveUuid(value.requestId) || !validLiveBrowserPage(value.browserContext))
    throw new TypeError('Invalid live browser context response');
  return { turnId: value.turnId, requestId: value.requestId, browserContext: { ...value.browserContext } };
}
