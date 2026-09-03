const { z } = require('zod');

const localeSchema = z.enum(['fr-FR', 'en-US', 'es-ES']);
const pageSchema = z.object({
  url: z.string().max(1_000),
  title: z.string().max(500),
  contextVersion: z.number().int().nonnegative(),
  dom: z.string().max(80_000)
}).strict();

const turnSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().trim().min(1).max(8_000),
  source: z.literal('text'),
  locale: localeSchema,
  idempotencyKey: z.string().trim().min(8).max(180),
  evaluationCode: z.string().trim().min(24).max(100).optional(),
  page: pageSchema,
  onboarding: z.object({
    revision: z.string().max(160).optional(),
    activeStep: z.string().max(160).optional(),
    completedSteps: z.array(z.string().max(160)).max(100).optional()
  }).strict().optional()
}).strict();

const sessionSchema = z.object({
  previousSessionId: z.string().uuid().optional(),
  closePrevious: z.boolean().optional()
}).strict();

const captureSchema = z.object({
  mimeType: z.enum(['image/jpeg', 'image/png']),
  data: z.string().max(1_500_000).regex(/^[A-Za-z0-9+/=]+$/)
}).strict();

const toolResultSchema = z.object({
  callId: z.string().min(1).max(200),
  status: z.enum(['ok', 'not_found', 'ambiguous', 'blocked', 'unexpected', 'failed']),
  contextVersion: z.number().int().nonnegative(),
  message: z.string().max(1_000).optional(),
  page: pageSchema.optional(),
  capture: captureSchema.optional()
}).strict();

const CLIENT_TOOL_NAMES = new Set([
  'inspect_current_page',
  'capture_current_view',
  'click_element',
  'fill_field',
  'scroll_page',
  'navigate_internal',
  'verify_expected_result'
]);

function sanitizeToolResult(input) {
  const parsed = toolResultSchema.parse(input);
  return {
    callId: parsed.callId,
    status: parsed.status,
    contextVersion: parsed.contextVersion,
    ...(parsed.message ? { message: parsed.message } : {}),
    ...(parsed.page ? { page: parsed.page } : {}),
    ...(parsed.capture ? { capture: parsed.capture } : {})
  };
}

function publicToolResult(result) {
  return {
    status: result.status,
    contextVersion: result.contextVersion,
    ...(result.message ? { message: result.message } : {}),
    ...(result.page ? { page: result.page } : {})
  };
}

module.exports = {
  CLIENT_TOOL_NAMES,
  localeSchema,
  pageSchema,
  publicToolResult,
  sanitizeToolResult,
  sessionSchema,
  toolResultSchema,
  turnSchema
};
