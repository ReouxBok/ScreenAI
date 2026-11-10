import { canonicalKnowledgeSchema } from "./contracts";
import { temporaryIncidentSchema } from "./temporary-incidents";

/** Only prepares data for the existing NEW proposal draft. No approval, projection or runtime binding. */
export function prepareTemporaryIncidentDraft(input: {
  id: string; title: string; family: string; productArea: string; knownSince: string; validUntil: string;
  reply: string; source: string;
}, now: Date = new Date()) {
  const incident = temporaryIncidentSchema.parse({ schemaVersion: 1, id: input.id, revision: 1, title: input.title,
    scope: { families: [input.family], productArea: input.productArea }, status: "active",
    knownSince: input.knownSince, validUntil: input.validUntil, infoToCollect: [], approvedReply: input.reply,
    fix: { level: "none", evidence: "" }, provenance: { source: input.source, recordedAt: now.toISOString() } });
  const document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: input.title, applicability: "sav_only", locale: "fr-FR",
    productVersion: "", prerequisites: [], expectedResult: "", exceptions: [], escalation: "À faire vérifier par l’équipe.", steps: [], temporaryIncident: incident });
  return { mode: "new" as const, title: incident.title, document,
    sources: [],
    reason: "Incident temporaire proposé par l’équipe ; à compléter et relire avant soumission." };
}
