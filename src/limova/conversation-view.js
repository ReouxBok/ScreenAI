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

function visibleTodos(items) {
  return Array.isArray(items) ? items.filter(item => item && typeof item.content === 'string'
    && item.content.trim() && ['pending', 'in_progress', 'completed'].includes(item.status))
    .map(({ content, status }) => ({ content, status })) : [];
}

export function createConversationView() {
  const messages = new Map();
  const files = new Map();
  const sealed = new Set();
  const captions = new Map();
  const plans = new Map();
  let error = null;

  function addFiles(items, messageId, reorder = false) {
    if (!Array.isArray(items)) return;
    items.forEach(item => {
      const file = visibleFile(item);
      if (!file) return;
      const owner = messageId ?? files.get(file.id)?.messageId;
      if (reorder) files.delete(file.id);
      files.set(file.id, { ...file, ...(owner ? { messageId: owner } : {}) });
    });
  }

  function replace(message) {
    const visible = visibleMessage(message);
    if (visible) messages.set(visible.id, visible);
  }

  return {
    reset() { messages.clear(); files.clear(); sealed.clear(); captions.clear(); plans.clear(); error = null; },
    history(page, { prepend = false } = {}) {
      if (!prepend) plans.clear();
      const recent = prepend ? [...messages.entries()] : null;
      if (prepend) messages.clear();
      const items = Array.isArray(page?.data) ? page.data : [];
      items.forEach(message => {
        replace(message);
        if (message.toShow === false || !visibleMessage(message)) return;
        addFiles(message.generatedFiles, message.id);
        addFiles(message.generatedImages, message.id);
        addFiles(message.generatedVideos, message.id);
        addFiles(message.generatedCarousel?.slides, message.id, true);
        if (Object.hasOwn(message, 'generatedCaption')) {
          if (typeof message.generatedCaption?.text === 'string' && message.generatedCaption.text.trim())
            captions.set(message.id, message.generatedCaption.text);
          else captions.delete(message.id);
        }
      });
      if (recent) recent.forEach(([id, message]) => messages.set(id, message));
      if (Array.isArray(page?.reasoning)) page.reasoning.forEach(turn => {
        if (typeof turn?.anchorMessageId !== 'string' || !messages.has(turn.anchorMessageId)) return;
        if (!prepend || !plans.has(turn.anchorMessageId)) plans.set(turn.anchorMessageId, visibleTodos(turn.todos));
      });
      addFiles(page?.unanchoredGeneratedFiles);
    },
    event(frame) {
      // LangGraph encodes subgraph namespaces as messages|namespace (and the
      // same suffix for values/custom). Never render those as Charly's reply.
      if (typeof frame?.event !== 'string' || frame.event.includes('|')) return;
      if (frame.event === 'error') {
        error = 'La réponse a été interrompue. Recharge la conversation avant de réessayer.';
      } else if (frame.event === 'values' && Array.isArray(frame.data?.messages)) {
        let anchor = null;
        let todos = null;
        let turnAnchors = [];
        const finishPlan = () => {
          if (todos === null || !anchor) return;
          turnAnchors.forEach(id => plans.delete(id));
          plans.set(anchor, todos);
        };
        frame.data.messages.forEach(message => {
          const visible = visibleMessage(message);
          if (visible?.role === 'user') {
            finishPlan(); anchor = visible.id; todos = null; turnAnchors = [visible.id];
          } else if (visible?.role === 'assistant') {
            turnAnchors.push(visible.id);
            if (visible.content.trim()) anchor = visible.id;
            if (Array.isArray(message.tool_calls)) message.tool_calls.forEach(call => {
              if (call?.name === 'write_todos') todos = visibleTodos(call.args?.todos);
            });
          }
          replace(message);
          if (typeof message?.id === 'string') sealed.add(message.id);
        });
        finishPlan();
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
      const attached = new Set([...files.values()].map(file => file.messageId));
      return { messages: [...messages.values()]
        .filter(message => message.content || captions.has(message.id) || attached.has(message.id))
        .map(message => captions.has(message.id) ? { ...message, caption: captions.get(message.id) } : message),
        files: [...files.values()], error,
        ...([...plans.values()].some(items => items.length) ? { plans: [...plans.entries()]
          .filter(([, items]) => items.length).map(([messageId, todos]) => ({ messageId, todos })) } : {}) };
    },
  };
}
