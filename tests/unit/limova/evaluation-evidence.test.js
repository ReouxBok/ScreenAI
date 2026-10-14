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
