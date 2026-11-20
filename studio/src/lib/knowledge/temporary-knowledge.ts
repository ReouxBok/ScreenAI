import type { TemporaryIncident } from "./temporary-incident-schema";

export function temporaryKnowledgeEnabled(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env.SAV_V2_TEMPORARY_KNOWLEDGE === "on";
}

export function temporaryKnowledgeState(incident: TemporaryIncident, now: Date) {
  if (incident.status === "revoked") return "retired";
  const time = now.getTime();
  if (time >= Date.parse(incident.validUntil)) return "expired";
  return time >= Date.parse(incident.knownSince) ? "active" : "scheduled";
}

function words(text: string) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Staff may select an exact theme. Customer text must contain a full symptom or a discriminating keyword. */
export function temporaryKnowledgeMatches(incident: TemporaryIncident, themesOrText: string | readonly string[]) {
  const area = words(incident.scope.productArea);
  if (typeof themesOrText !== "string") {
    return Boolean(area) && themesOrText.some(theme => words(theme) === area);
  }
  const text = ` ${words(themesOrText)} `;
  return incident.keywords?.map(words).some(phrase => phrase && phrase !== area && text.includes(` ${phrase} `)) ?? false;
}
