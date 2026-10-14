// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock } from '../../helpers/chrome-mock.js';
import { loadSidebarScript } from '../../helpers/load-script.js';

describe('content.js — Studio capture only', () => {
  let content;

  beforeEach(() => {
    document.body.innerHTML = '';
    delete globalThis.__limovaStudioCaptureInstalled;
    installChromeMock();
    content = loadSidebarScript('src/content/content.js');
  });

  afterEach(() => {
    content.setTrainingCapture(false);
    uninstallChromeMock();
    vi.restoreAllMocks();
  });

  it('redacts identifiers in training labels', () => {
    expect(content.trainingSafeText('alice@example.com +33601020304')).toBe('[email] [phone]');
    expect(content.trainingSafeText('eyJabcdefghij.abcdefghij.abcdefghij')).toBe('[token]');
  });

  it('describes a control without recording field values', () => {
    document.body.innerHTML = `<main><article class="integration-card"><h2>HubSpot</h2>
      <button id="connectHubspot" data-testid="connect-hubspot" aria-label="Connecter HubSpot">Connecter</button>
      <label for="message">Message</label><textarea id="message">contenu privé</textarea></article></main>`;
    const button = document.querySelector('button');
    expect(content.trainingZone(button)).toBe('main');
    expect(content.trainingSection(button)).toBe('HubSpot');
    expect(content.trainingOccurrence(button, 'Connecter HubSpot')).toBe(1);
    expect(content.safeElementIdentifier(button.dataset.testid)).toBe('connect-hubspot');
    expect(content.trainingLabel(document.querySelector('textarea'))).toBe('Message');
  });

  it('records an input fingerprint without its value', () => {
    document.body.innerHTML = '<label for="message">Message</label><textarea id="message">contenu privé</textarea>';
    content.setTrainingCapture(true);
    content.captureTrainingInput({ target: document.querySelector('textarea') });
    const message = chrome.runtime.sendMessage.mock.calls.at(-1)[0];
    expect(message).toMatchObject({ type: 'TRAINING_EVENT', event: { kind: 'input', label: 'Message', payload: { filled: true } } });
    expect(JSON.stringify(message)).not.toContain('contenu privé');
  });

  it('ignores sensitive fields', () => {
    document.body.innerHTML = '<label for="key">API key</label><input id="key" value="secret">';
    chrome.runtime.sendMessage.mockClear();
    content.setTrainingCapture(true);
    content.captureTrainingInput({ target: document.querySelector('input') });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('enables and disables capture through TRAINING_STATE', () => {
    document.body.innerHTML = '<label for="message">Message</label><textarea id="message"></textarea>';
    const field = document.querySelector('textarea');
    const sendResponse = vi.fn();
    expect(content.handleBackgroundMessage({ type: 'TRAINING_STATE', active: true }, {}, sendResponse)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    chrome.runtime.sendMessage.mockClear();
    content.captureTrainingInput({ target: field });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce();
    content.handleBackgroundMessage({ type: 'TRAINING_STATE', active: false }, {}, sendResponse);
    chrome.runtime.sendMessage.mockClear();
    content.captureTrainingInput({ target: field });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flushes the matching evaluation observation', async () => {
    content.setEvaluationObservation('run-1');
    const response = await new Promise(resolve => {
      expect(content.handleBackgroundMessage({ type: 'FLUSH_EVALUATION_OBSERVATION', runId: 'run-1' }, {}, resolve)).toBe(true);
    });
    expect(response).toEqual({ ok: true });
  });

  it('rejects a stale evaluation observation', () => {
    content.setEvaluationObservation('run-1');
    const sendResponse = vi.fn();
    expect(content.handleBackgroundMessage({ type: 'FLUSH_EVALUATION_OBSERVATION', runId: 'run-2' }, {}, sendResponse)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false });
  });
});
