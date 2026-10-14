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


it('restores video, carousel and caption-only answers with their message ownership', () => {
  const view = createConversationView();
  const file = (fileId, fileName, mimeType = 'image/png') => ({ fileId, fileName, mimeType, fileUrl: `https://files.example/${fileId}` });
  view.event({ event: 'custom', data: { type: 'deep_agent_generated_files', files: [file('slide2', 'Second'), file('slide1', 'First')] } });
  view.history({ data: [
    { id: 'video-answer', role: 'assistant', content: '', generatedVideos: [file('video', 'Demo.mp4', 'video/mp4')] },
    { id: 'social-answer', role: 'assistant', content: '', generatedCaption: { text: '<script>not executable</script>', platform: 'linkedin' },
      generatedCarousel: { slides: [file('slide1', 'First'), file('slide2', 'Second')] } },
  ] });
  const result = view.snapshot();
  expect(result.messages.map(message => message.id)).toEqual(['video-answer', 'social-answer']);
  expect(result.messages[1].caption).toBe('<script>not executable</script>');
  expect(result.files.filter(file => file.messageId === 'social-answer').map(file => file.id)).toEqual(['slide1', 'slide2']);
  expect(result.files.find(file => file.id === 'video')).toMatchObject({ messageId: 'video-answer', mimeType: 'video/mp4' });
  view.reset();
  expect(view.snapshot()).toEqual({ messages: [], files: [], error: null });
});

it('refreshes file URLs without losing their message anchor on a subsequent stream event', () => {
  const view = createConversationView();
  const file = { fileId: 'f', fileName: 'Report', mimeType: 'application/pdf', fileUrl: 'https://files.example/old' };
  view.history({ data: [{ id: 'a', role: 'assistant', content: 'Report', generatedFiles: [file] }] });
  view.event({ event: 'custom', data: { type: 'deep_agent_generated_files', files: [{ ...file, fileUrl: 'https://files.example/new' }] } });
  expect(view.snapshot().files).toEqual([{ id: 'f', name: 'Report', mimeType: 'application/pdf', url: 'https://files.example/new', messageId: 'a' }]);
});

it('excludes hidden generated content, tool payloads and unsafe carousel URLs', () => {
  const view = createConversationView();
  const file = { fileId: 'bad', fileName: 'Secret', mimeType: 'video/mp4', fileUrl: 'https://files.example/private' };
  view.history({ data: [
    { id: 'hidden', role: 'assistant', toShow: false, generatedVideos: [file], generatedCaption: { text: 'secret' } },
    { id: 'tool', role: 'tool', generatedCarousel: { slides: [file] } },
    { id: 'visible', role: 'assistant', content: '', generatedCarousel: { slides: [{ ...file, fileUrl: 'javascript:alert(1)' }] } },
  ] });
  expect(view.snapshot()).toEqual({ messages: [], files: [], error: null });
});
