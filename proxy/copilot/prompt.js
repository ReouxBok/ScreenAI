const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROMPT_FILES = ['IDENTITY.md', 'SOUL.md', 'AGENT.md', 'TOOLS.md', 'MEMORY_POLICY.md'];

function loadPromptBundle(promptDirectory = path.join(__dirname, '..', 'prompts')) {
  const sections = PROMPT_FILES.map(file => ({
    file,
    content: fs.readFileSync(path.join(promptDirectory, file), 'utf8').trim()
  }));
  const content = sections.map(section => `# ${section.file}\n\n${section.content}`).join('\n\n');
  const revision = `prompt_${crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
  return { content, revision, files: PROMPT_FILES.slice() };
}

module.exports = { PROMPT_FILES, loadPromptBundle };
