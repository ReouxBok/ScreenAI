export const EVALUATION_CODE_HEADER = 'x-limova-evaluation-code';
const CODE_PATTERN = /^[A-Za-z0-9_-]{24,100}$/;

export function evaluationGrant(code) {
  if (code === undefined) return undefined;
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    throw new TypeError('Code d’évaluation Studio invalide.');
  }
  return code;
}
