export type SavTranscriptMessage = {
  id?: string;
  text: string;
  direction: string;
  timestamp?: string;
  aiAuthored?: boolean;
};

export function redactSavLearningText(value: string) {
  return value
    .replace(/https?:\/\/[^\s<>]+/gi,"[lien privé masqué]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,"[identifiant masqué]")
    .replace(/\b(?:nom|client|customer|adresse|address)\s*:\s*[^\n,;]+/gi,"[donnée client masquée]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email masqué]")
    .replace(/(?<!\d)(?:\+?33|0)[1-9](?:[ .-]?\d{2}){4}(?!\d)/g, "[téléphone masqué]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[numéro sensible masqué]")
    .replace(/\b(?:sk|pk|api|token)[-_][A-Za-z0-9_-]{12,}\b/gi, "[secret masqué]")
    .trim();
}

export function isHubspotOutboundDirection(value: string) {
  return ["EMAIL", "OUTGOING_EMAIL", "FORWARDED_EMAIL"].includes(value.trim().toUpperCase());
}

export function extractSavLearningResolution(ticketContent: string, transcript: SavTranscriptMessage[]) {
  const outbound = transcript.filter((message) => isHubspotOutboundDirection(message.direction));
  const human = outbound.filter((message) => !message.aiAuthored);
  const source = human.at(-1) ?? outbound.at(-1);
  const rawResolution = source?.text.trim() || ticketContent.trim();
  const sourceIndex = source ? transcript.indexOf(source) : -1;
  const confirmations = sourceIndex >= 0 ? transcript.slice(sourceIndex + 1).filter((message) => !isHubspotOutboundDirection(message.direction)) : [];
  const customerConfirmed = confirmations.some((message) => !/\b(?:pas|non|not|never|encore|toujours|jamais)\b/i.test(message.text) && /(?:^|[^a-zà-ÿ])(?:résolu|réglé|fonctionne|ça marche|resolved|works now)(?:$|[^a-zà-ÿ])/i.test(message.text));
  return {
    resolution: redactSavLearningText(rawResolution).slice(0, 10_000),
    provenance: source ? (source.aiAuthored ? "ai_resolution" as const : "human_resolution" as const) : "ticket_content" as const,
    customerConfirmed,
    sourceMessageId: source?.id ?? null,
  };
}
