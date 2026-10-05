import { describe, expect, it } from "vitest";
import { assertSavSupportConfiguration, assertSavSupportPipeline, savSupportTicketProperties, type SavSupportCategory } from "./hubspot-mapping";

const pipeline = { id: "0", stages: ["1", "2", "3", "4"].map((id) => ({ id, metadata: { isClosed: id === "4" ? "true" : "false" } })) };
describe("verified Limova Support HubSpot mapping", () => {
  it("uses real option values, multiple categories, source Email, and no owner", () => {
    expect(savSupportTicketProperties({ title: "Impossible de télécharger mes factures depuis hier", description: "Mail original\navec ses détails", categories: ["access", "billing", "access"] })).toEqual({
      subject: "Impossible de télécharger mes factures", content: "Mail original\navec ses détails", hs_pipeline: "0", hs_pipeline_stage: "1", source_type: "EMAIL", hs_ticket_category: "Acces;Facturation",
    });
  });
  it("does not silently truncate the client's message", () => {
    const description = "x".repeat(30_000);
    expect(savSupportTicketProperties({ title: "Incident", description }).content).toBe(description);
  });
  it("rejects invalid categories and empty descriptions", () => {
    expect(() => savSupportTicketProperties({ title: "Incident", description: "Original", categories: ["integration" as SavSupportCategory] })).toThrow("SAV_HUBSPOT_CATEGORY_INVALID");
    expect(() => savSupportTicketProperties({ title: "Incident", description: " " })).toThrow();
  });
  it("fails explicitly before writes when configured IDs disagree with the verified portal", () => {
    expect(() => assertSavSupportConfiguration({})).not.toThrow();
    expect(() => assertSavSupportConfiguration({ HUBSPOT_TICKET_PIPELINE_ID: "0", HUBSPOT_NEW_TICKET_STAGE_ID: "1" })).not.toThrow();
    expect(() => assertSavSupportConfiguration({ HUBSPOT_NEW_TICKET_STAGE_ID: "4059679943" })).toThrow("SAV_HUBSPOT_MAPPING_MISMATCH");
    expect(() => assertSavSupportConfiguration({ HUBSPOT_PORTAL_ID: "another-portal" })).toThrow();
  });
  it("checks live pipeline membership and open/closed metadata instead of labels", () => {
    expect(() => assertSavSupportPipeline(pipeline)).not.toThrow();
    expect(() => assertSavSupportPipeline({ ...pipeline, id: "wrong" })).toThrow();
    expect(() => assertSavSupportPipeline({ ...pipeline, stages: pipeline.stages.slice(1) })).toThrow("SAV_HUBSPOT_STAGE_MISSING");
    expect(() => assertSavSupportPipeline({ ...pipeline, stages: pipeline.stages.map((stage) => ({ ...stage, metadata: { isClosed: "true" } })) })).toThrow("SAV_HUBSPOT_STAGE_STATE_MISMATCH");
  });
});
