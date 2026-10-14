import { describe, expect, it } from 'vitest';
import { createEvaluationResponseEvidence } from '../../../src/limova/evaluation-response.js';
const human = { id: 'h', type: 'human', content: 'Question' };
const answer = { id: 'new', type: 'ai', content: 'Private answer', tool_calls: [] };
const values = messages => ({ event: 'values', data: { messages } });
describe('canonical evaluation response evidence', () => {
  it('projects a new canonical answer without its content', () => {
    const c = createEvaluationResponseEvidence({ data: [{ id: 'old' }] });
    c.consume(values([human, answer]));
    expect(c.finish()).toEqual({ id: 'new', event: { kind: 'response', status: 'ok' } });
  });
  it('does not count a replayed history answer', () => {
    const c = createEvaluationResponseEvidence({ data: [answer] }); c.consume(values([human, answer]));
    expect(c.finish()).toBeNull();
  });
  it.each([
    values([human]), values([answer]), values([human, { ...answer, toShow: false }]),
    values([human, { ...answer, tool_calls: [{ id: 'tool' }] }]),
    values([human, { ...answer, content: '' }]),
    { event: 'values|subagent', data: { messages: [human, answer] } },
    { event: 'messages', data: [answer, {}] },
  ])('ignores incomplete, hidden and delegated responses: %j', frame => {
    const c = createEvaluationResponseEvidence({ data: [] }); c.consume(frame); expect(c.finish()).toBeNull();
  });
  it('does not count a final-looking answer after a stream error or pending action', () => {
    for (const frame of [{ event: 'error' }, { event: 'custom', data: { type: 'extension.action_requested' } }]) {
      const c = createEvaluationResponseEvidence({ data: [] }); c.consume(values([human, answer])); c.consume(frame);
      expect(c.finish()).toBeNull();
    }
  });
  it('requires a readable history baseline', () => {
    expect(() => createEvaluationResponseEvidence(null)).toThrow();
  });
});
