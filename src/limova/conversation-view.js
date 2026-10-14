// Only project user-visible root messages. Raw tool outputs and reasoning never
// become chat text, even when the server includes them in a checkpoint.
function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => typeof block === 'string' ? block
    : block?.type === 'text' && typeof block.text === 'string' ? block.text : '').join('');
}

function visibleMessage(message) {
  if (!message || message.toShow === false || typeof message.id !== 'string') return null;
  const role = { human: 'user', ai: 'assistant', user: 'user', assistant: 'assistant' }[message.type ?? message.role];
  if (!role) return null;
  return { id: message.id, role, content: textContent(message.content) };
}

function visibleFile(file) {
  if (!file || typeof file.fileId !== 'string' || typeof file.fileUrl !== 'string') return null;
  try {
    const url = new URL(file.fileUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return { id: file.fileId, url: url.href, name: typeof file.fileName === 'string' ? file.fileName : 'Fichier',
      mimeType: typeof file.mimeType === 'string' ? file.mimeType : '' };
  } catch { return null; }
}

export function createConversationView() {
  const messages = new Map();
  const files = new Map();
  const sealed = new Set();
  let error = null;

  function addFiles(items) {
    if (!Array.isArray(items)) return;
    items.forEach(item => {
      const file = visibleFile(item);
      if (file) files.set(file.id, file);
    });
  }

  function replace(message) {
    const visible = visibleMessage(message);
    if (visible) messages.set(visible.id, visible);
  }

  return {
    reset() { messages.clear(); files.clear(); sealed.clear(); error = null; },
    history(page, { prepend = false } = {}) {
      const recent = prepend ? [...messages.entries()] : null;
      if (prepend) messages.clear();
      const items = Array.isArray(page?.data) ? page.data : [];
      items.forEach(message => {
        replace(message);
        if (message.toShow === false || !visibleMessage(message)) return;
        addFiles(message.generatedFiles);
        addFiles(message.generatedImages);
      });
      if (recent) recent.forEach(([id, message]) => messages.set(id, message));
      addFiles(page?.unanchoredGeneratedFiles);
    },
    event(frame) {
      // LangGraph encodes subgraph namespaces as messages|namespace (and the
      // same suffix for values/custom). Never render those as Charly's reply.
      if (typeof frame?.event !== 'string' || frame.event.includes('|')) return;
      if (frame.event === 'error') {
        error = 'La réponse a été interrompue. Recharge la conversation avant de réessayer.';
      } else if (frame.event === 'values' && Array.isArray(frame.data?.messages)) {
        frame.data.messages.forEach(message => {
          replace(message);
          if (typeof message?.id === 'string') sealed.add(message.id);
        });
      } else if (frame.event === 'messages' && Array.isArray(frame.data)) {
        const [chunk, metadata] = frame.data;
        if (metadata?.langgraph_checkpoint_ns?.includes('|')) return;
        const visible = visibleMessage(chunk);
        if (!visible || visible.role !== 'assistant' || sealed.has(visible.id)) return;
        const previous = messages.get(visible.id);
        messages.set(visible.id, { ...visible, content: (previous?.content ?? '') + visible.content });
      } else if (frame.event === 'custom' && frame.data?.type === 'deep_agent_generated_files') {
        addFiles(frame.data.files);
      }
    },
    snapshot() {
      return { messages: [...messages.values()].filter(message => message.content), files: [...files.values()], error };
    },
  };
}
