function text(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : '';
}

export function createEvaluationResponseEvidence(history) {
  if (!Array.isArray(history?.data)) throw new Error('Historique requis pour vérifier la réponse Studio.');
  const existing = new Set(history.data.map(message => message?.id).filter(id => typeof id === 'string'));
  let latest, pending = false, failed = false;
  return {
    consume(frame) {
      if (frame?.event === 'error') { failed = true; return; }
      if (frame?.event === 'custom') {
        if (frame.data?.type === 'extension.action_requested') { pending = true; latest = undefined; }
        if (frame.data?.type === 'extension.turn_state') {
          pending = frame.data.state !== 'completed';
          if (pending) latest = undefined;
        }
      }
      if (frame?.event === 'values' && Array.isArray(frame.data?.messages)) latest = frame.data.messages;
    },
    finish() {
      if (failed || pending || !latest?.length) return null;
      const human = latest.findLastIndex(message => ['human', 'user'].includes(message?.type ?? message?.role));
      const answer = latest.at(-1);
      if (human < 0 || human === latest.length - 1 || !['ai', 'assistant'].includes(answer?.type ?? answer?.role)
        || typeof answer.id !== 'string' || existing.has(answer.id) || answer.toShow === false
        || (Array.isArray(answer.tool_calls) && answer.tool_calls.length) || !text(answer.content).trim()) return null;
      return { id: answer.id, event: { kind: 'response', status: 'ok' } };
    },
  };
}
