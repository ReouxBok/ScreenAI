import { z } from "zod";

export const savAgentOutputSchema = z.object({
  category: z.enum(["technical", "account", "billing", "integration", "how_to", "acknowledgement", "other"]),
  urgency: z.enum(["low", "normal", "high", "critical"]),
  ticketRequired: z.boolean(),
  reasonCode: z.string().trim().min(3).max(100),
  explanation: z.string().trim().min(10).max(2_000),
  confidence: z.number().min(0).max(1),
  requiresHuman: z.boolean(),
  replyDraft: z.string().max(8_000),
  internalNote: z.string().max(8_000),
  evidenceIds: z.array(z.string().trim().min(1).max(200)).max(20),
}).strict();

export type SavAgentOutput = z.infer<typeof savAgentOutputSchema>;

export const SAV_AGENT_TOOL_NAMES = [
  "read_support_message",
  "search_resolution_cards",
  "find_related_hubspot_tickets",
] as const;

export const EXTENSION_ONLY_TOOL_NAMES = [
  "inspect_current_page",
  "capture_current_view",
  "click_element",
  "fill_field",
  "scroll_page",
  "navigate_internal",
  "verify_expected_result",
  "search_knowledge_base",
] as const;
