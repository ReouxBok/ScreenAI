'use strict';

// Local remediation of GHSA-vfj7-8cjw-p6xm. Not configurable by callers.
const MAX_DEPTH = 128;
const assertDepth = depth => {
  if (depth > MAX_DEPTH) {
    const error = new SyntaxError(`Brace nesting exceeds the safe depth (${MAX_DEPTH})`);
    error.code = 'ERR_BRACES_DEPTH';
    throw error;
  }
};
module.exports = { MAX_DEPTH, assertDepth };
