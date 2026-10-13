import { describe, expect, it } from 'vitest';
import { createConversationView } from '../../../src/limova/conversation-view.js';

describe('Deep Agent conversation projection', () => {
  it('joins native chunks then reconciles the checkpoint without duplicate text', () => {
    const view = createConversationView();
    view.event({ event: 'messages', data: [{ id: 'a', type: 'ai', content: 'Bon' }, {}] });
    view.event({ event: 'messages', data: [{ id: 'a', type: 'ai', content: [{ type: 'text', text: 'jour' }] }, {}] });
    expect(view.snapshot().messages[0].content).toBe('Bonjour');
    view.event({ event: 'values', data: { messages: [{ id: 'a', type: 'ai', content: 'Bonjour !' }] } });
    view.event({ event: 'messages', data: [{ id: 'a', type: 'ai', content: ' !' }, {}] });
    expect(view.snapshot().messages).toEqual([{ id: 'a', role: 'assistant', content: 'Bonjour !' }]);
  });

  it('does not render reasoning, hidden messages, tools, or subagent events', () => {
    const view = createConversationView();
    view.history({ data: [
      { id: 'hidden', role: 'assistant', content: 'secret', toShow: false },
      { id: 'tool', role: 'tool', content: 'raw result' },
      { id: 'user', role: 'user', content: 'Bonjour' },
    ] });
    view.event({ event: 'messages|tools:123|agent:456', data: [{ id: 'sub', type: 'ai', content: 'internal' }, {}] });
    view.event({ event: 'values', data: { messages: [{ id: 'a', type: 'ai', reasoning: 'private', content: [
      { type: 'reasoning', text: 'private' }, { type: 'text', text: 'Réponse' },
    ] }] } });
    expect(view.snapshot().messages.map(message => message.content)).toEqual(['Bonjour', 'Réponse']);
  });

  it('deduplicates generated files and rejects executable links', () => {
    const view = createConversationView();
    const file = { fileId: 'f', fileUrl: 'https://files.example/report.pdf', fileName: 'Rapport' };
    view.event({ event: 'custom', data: { type: 'deep_agent_generated_files', files: [file, { ...file, fileId: 'bad', fileUrl: 'javascript:alert(1)' }] } });
    view.history({ data: [], unanchoredGeneratedFiles: [file] });
    expect(view.snapshot().files).toEqual([{ id: 'f', url: file.fileUrl, name: 'Rapport', mimeType: '' }]);
    view.reset();
    expect(view.snapshot()).toEqual({ messages: [], files: [], error: null });
  });

  it('reports stream failure without exposing the raw server exception', () => {
    const view = createConversationView();
    view.event({ event: 'error', data: { message: 'secret infrastructure error' } });
    expect(view.snapshot().error).toContain('interrompue');
    expect(view.snapshot().error).not.toContain('secret');
  });
});
