import { describe, expect, it } from 'vitest';
import { projectEvaluationAction } from '../../../src/limova/evaluation-evidence.js';

const action = { actionId: 'a', input: { operation: 'click', elementId: 1, text: 'private value' }, target: { contextVersion: 8, origin: 'https://private.example' } };
const receipt = { state: 'completed', result: { actionId: 'a', status: 'completed', observation: 'Private page contents' } };
describe('Studio browser evidence projection', () => {
  it('records dispatch without claiming verification or copying page content', () => {
    expect(projectEvaluationAction(action, receipt)).toEqual({ kind: 'tool_result', toolName: 'click_element', status: 'ok', contextVersion: 8 });
  });
  it.each(['read_page', 'screenshot', 'highlight'])('never treats %s as verify_expected_result', operation => {
    expect(projectEvaluationAction({ ...action, input: { operation } }, receipt).toolName).not.toBe('verify_expected_result');
  });
  it('records rejected and uncertain execution as failures', () => {
    expect(projectEvaluationAction(action, { state: 'uncertain' }).status).toBe('failed');
    expect(projectEvaluationAction(action, { ...receipt, result: { actionId: 'a', status: 'rejected' } }).status).toBe('blocked');
  });
  it.each(['verify_expected_result', 'toString', 'unknown'])('refuses unsupported operation %s', operation => {
    expect(projectEvaluationAction({ ...action, input: { operation } }, receipt)).toBeNull();
  });
  it('refuses receipts for another action', () => {
    expect(projectEvaluationAction(action, { ...receipt, result: { ...receipt.result, actionId: 'b' } })).toBeNull();
  });
});

import { projectEvaluationObservation } from '../../../src/limova/evaluation-evidence.js';
const reading = { actionId: 'read', input: { operation: 'read_page' }, target: { origin: 'https://app.example', contextVersion: 8 } };
const now = () => new Date().toISOString();
function observed(patch = {}) {
  return { state: 'completed', observedAt: now(), result: { actionId: 'read', contextVersion: 8, status: 'completed',
    observation: JSON.stringify({ text: 'Connection status: Connected', url: 'https://app.example/settings', contextVersion: 9 }), ...patch } };
}
const mutation = () => ({ contextVersion: 6, observedAt: Date.now() - 1000 });
describe('fresh post-action verification observations', () => {
  it('projects only the redacted page text and its bound location/version', () => {
    expect(projectEvaluationObservation(reading, observed(), mutation())).toEqual({ kind: 'native_verification', observation: {
      text: 'Connection status: Connected', origin: 'https://app.example', path: '/settings', contextVersion: 9, observedAt: expect.any(String),
    } });
  });
  it('requires a preceding mutation and rejects expired receipts', () => {
    expect(projectEvaluationObservation(reading, observed(), null)).toBeNull();
    expect(projectEvaluationObservation(reading, { ...observed(), observedAt: '2000-01-01T00:00:00.000Z' }, mutation())).toBeNull();
    expect(projectEvaluationObservation(reading, observed(), { contextVersion: 8, observedAt: Date.now() - 1000 })).toBeNull();
  });
  it.each([
    { url: 'https://other.example/settings', contextVersion: 9, text: 'Connected' },
    { url: 'https://app.example/settings?token=private', contextVersion: 9, text: 'Connected' },
    { url: 'https://app.example/settings', contextVersion: 8, text: 'Connected' },
    { url: 'https://app.example/settings', contextVersion: 9, text: '' },
  ])('rejects mismatched or unsafe snapshots: %j', page => {
    expect(projectEvaluationObservation(reading, observed({ observation: JSON.stringify(page) }), mutation())).toBeNull();
  });
});
