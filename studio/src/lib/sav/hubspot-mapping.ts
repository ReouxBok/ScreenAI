/** Verified via HubSpot property definitions in portal 143641967, 2026-10-02.
 * Keep the portal's exact option values, including existing spelling mistakes.
 */
export const SAV_HUBSPOT_SUPPORT = {
  portalId: "143641967", pipelineId: "0",
  stages: { new: "1", awaitingContact: "2", awaitingTeam: "3", closed: "4" },
  source: "EMAIL",
  categories: {
    access: "Acces", misuse: "Mauvaise utiisation", missing_feature: "Manque de fonctionalité",
    technical: "Problème technique", cancellation: "Résiliation", billing: "Facturation",
    feedback: "Feedback", other: "Autres",
  },
} as const;
export type SavSupportCategory = keyof typeof SAV_HUBSPOT_SUPPORT.categories;

export function assertSavSupportConfiguration(env: Record<string, string | undefined>) {
  const expected: Record<string, string> = {
    HUBSPOT_PORTAL_ID: SAV_HUBSPOT_SUPPORT.portalId,
    HUBSPOT_TICKET_PIPELINE_ID: SAV_HUBSPOT_SUPPORT.pipelineId,
    HUBSPOT_NEW_TICKET_STAGE_ID: SAV_HUBSPOT_SUPPORT.stages.new,
    HUBSPOT_AWAITING_CUSTOMER_STAGE_ID: SAV_HUBSPOT_SUPPORT.stages.awaitingContact,
    HUBSPOT_HUMAN_STAGE_ID: SAV_HUBSPOT_SUPPORT.stages.awaitingTeam,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== undefined && env[key] !== value) throw new Error(`SAV_HUBSPOT_MAPPING_MISMATCH:${key}`);
  }
}

export function assertSavSupportPipeline(pipeline: { id: string; stages: Array<{ id: string; metadata?: { isClosed?: string | boolean } }> }) {
  if (pipeline.id !== SAV_HUBSPOT_SUPPORT.pipelineId) throw new Error("SAV_HUBSPOT_PIPELINE_MISMATCH");
  for (const id of Object.values(SAV_HUBSPOT_SUPPORT.stages)) {
    const stage = pipeline.stages.find((row) => row.id === id);
    if (!stage) throw new Error("SAV_HUBSPOT_STAGE_MISSING");
    const closed = stage.metadata?.isClosed;
    if (closed === undefined || (closed === true || closed === "true") !== (id === SAV_HUBSPOT_SUPPORT.stages.closed)) {
      throw new Error("SAV_HUBSPOT_STAGE_STATE_MISMATCH");
    }
  }
}

export function savSupportTicketProperties(input: { title: string; description: string; categories?: SavSupportCategory[] }) {
  const subject = input.title.trim().split(/\s+/).slice(0, 5).join(" ");
  if (!subject || !input.description.trim()) throw new Error("SAV_HUBSPOT_TICKET_CONTENT_REQUIRED");
  const properties: Record<string, string> = {
    subject, content: input.description, hs_pipeline: SAV_HUBSPOT_SUPPORT.pipelineId,
    hs_pipeline_stage: SAV_HUBSPOT_SUPPORT.stages.new, source_type: SAV_HUBSPOT_SUPPORT.source,
  };
  if (input.categories?.length) {
    const values = [...new Set(input.categories)].map((category) => {
      if (!Object.hasOwn(SAV_HUBSPOT_SUPPORT.categories, category)) throw new Error("SAV_HUBSPOT_CATEGORY_INVALID");
      return SAV_HUBSPOT_SUPPORT.categories[category];
    });
    properties.hs_ticket_category = values.join(";");
  }
  // No owner assignment: Ugo's support procedure explicitly leaves it empty.
  return properties;
}
