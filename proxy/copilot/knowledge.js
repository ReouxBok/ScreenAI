const ACTIONS = new Set(['click', 'input', 'external_popup']);
const CONFIDENCE = new Set(['strong', 'medium', 'weak']);

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function textList(value, maxItems, maxLength) {
  return Array.isArray(value) ? value.map(item => text(item, maxLength)).filter(Boolean).slice(0, maxItems) : [];
}

function sanitizeActionHint(raw, index) {
  if (!raw || typeof raw !== 'object' || !ACTIONS.has(raw.action)) return null;
  const target = raw.target && typeof raw.target === 'object' ? raw.target : {};
  const expected = raw.expected && typeof raw.expected === 'object' ? raw.expected : {};
  const cleanTarget = Object.fromEntries([
    ['controlType', text(target.controlType, 60)],
    ['tag', text(target.tag, 30)],
    ['role', text(target.role, 50)],
    ['domId', text(target.domId, 120)],
    ['testId', text(target.testId, 120)],
    ['hrefPath', text(target.hrefPath, 300)],
    ['zone', text(target.zone, 40)],
    ['section', text(target.section, 160)],
    ['ariaLabel', text(target.ariaLabel, 160)],
    ['title', text(target.title, 160)]
  ].filter(([, value]) => value));
  if (Number.isInteger(target.occurrence) && target.occurrence > 0 && target.occurrence <= 100) cleanTarget.occurrence = target.occurrence;
  const cleanExpected = {
    pageMarkers: textList(expected.pageMarkers, 10, 180),
    network: textList(expected.network, 10, 200)
  };
  const expectedPath = text(expected.path, 1_000);
  if (expectedPath) cleanExpected.path = expectedPath;
  if (expected.popup === 'opened_then_closed') cleanExpected.popup = expected.popup;
  if (expected.fieldFilled === true) cleanExpected.fieldFilled = true;
  return {
    order: Number.isInteger(raw.order) ? Math.max(1, Math.min(100, raw.order)) : index + 1,
    action: raw.action,
    path: text(raw.path, 1_000) || '/',
    label: text(raw.label, 500) || 'Contrôle démontré',
    confidence: CONFIDENCE.has(raw.confidence) ? raw.confidence : 'weak',
    ...(Object.keys(cleanTarget).length ? { target: cleanTarget } : {}),
    preconditions: textList(raw.preconditions, 10, 180),
    expected: cleanExpected
  };
}

function sanitizeKnowledgeResponse(data) {
  return {
    revision: data?.revision || null,
    results: Array.isArray(data?.results) ? data.results.slice(0, 5).map(result => {
      const actionHints = Array.isArray(result?.actionHints)
        ? result.actionHints.slice(0, 50).map(sanitizeActionHint).filter(Boolean)
        : [];
      return {
        id: result?.id,
        title: text(result?.title, 300),
        content: text(result?.content, 5_000),
        score: Number(result?.score) || 0,
        source: text(result?.source, 500),
        ...(actionHints.length ? { actionHints } : {})
      };
    }) : []
  };
}

module.exports = { sanitizeActionHint, sanitizeKnowledgeResponse };
