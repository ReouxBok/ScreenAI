import { z } from "zod";
import { articleMetadataSchema, assertSafeMarkdown } from "./content";
import { assertSavUnsignedTemplate } from "./sav/lead-template";

const lines = (form: FormData, name: string) => String(form.get(name) ?? "").split("\n").map(value => value.trim()).filter(Boolean);
const resolutionSchema = articleMetadataSchema.shape.resolution.unwrap();
const sourceSchema = z.object({ reference: z.string().trim().min(3).max(1000), suppliedOn: z.iso.date() });

/** Previous metadata comes from the database, never from hidden form fields. */
export function articleMetadataFromForm(form: FormData, actorEmail: string, previous: Record<string, unknown> = {}, now = new Date()) {
  const metadata = { ...previous,
    intents: lines(form, "intents"), limovaPaths: lines(form, "limovaPaths"), prerequisites: lines(form, "prerequisites"),
    expectedResult: String(form.get("expectedResult") ?? ""), troubleshooting: String(form.get("troubleshooting") ?? ""),
  };
  if (form.get("savResolution") !== "on") return articleMetadataSchema.parse(metadata);
  if (form.get("agentKey") !== "sav") throw new Error("SAV_KNOWLEDGE_SCOPE_REQUIRED");
  const source = sourceSchema.parse({ reference: form.get("savSourceReference"), suppliedOn: form.get("savSourceDate") });
  if (source.suppliedOn > now.toISOString().slice(0, 10)) throw new Error("SAV_KNOWLEDGE_SOURCE_DATE_IN_FUTURE");
  const oldResolution = previous.resolution as Record<string, unknown> | undefined;
  const resolution = resolutionSchema.parse({
    audience: String(form.get("savAudience") ?? "support"),
    ...(form.get("savResponseTemplate") ? { responseTemplate: String(form.get("savResponseTemplate")) } : {}),
    symptoms: lines(form, "savSymptoms"), steps: lines(form, "savSteps"), exceptions: lines(form, "savExceptions"),
    escalation: form.get("savEscalation"), productVersion: String(form.get("savProductVersion") ?? ""),
    ...(form.get("savValidUntil") ? { validUntil: String(form.get("savValidUntil")) } : {}),
    supersedes: oldResolution?.supersedes ?? [], conflictsWith: oldResolution?.conflictsWith ?? [],
  });
  if (!resolution.symptoms.length || !resolution.steps.length) throw new Error("SAV_KNOWLEDGE_PROCEDURE_REQUIRED");
  if (resolution.audience === "lead") {
    if (!resolution.responseTemplate) throw new Error("SAV_LEAD_TEMPLATE_REQUIRED");
    assertSafeMarkdown(resolution.responseTemplate);
    assertSavUnsignedTemplate(resolution.responseTemplate);
  }
  const inheritedSource = previous.sourceMetadata && typeof previous.sourceMetadata === "object" && !Array.isArray(previous.sourceMetadata)
    ? previous.sourceMetadata as Record<string, unknown> : {};
  return articleMetadataSchema.parse({ ...metadata, resolution,
    sourceMetadata: { ...inheritedSource, editorialSource: { kind: "staff_supplied", ...source,
      recordedBy: z.email().parse(actorEmail), recordedAt: now.toISOString() } },
  });
}
