import { z } from "zod";

export const memoryTypeSchema = z.enum(["profile", "preference", "project", "decision"]);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

export type MemoryCandidate = {
  type: MemoryType;
  statement: string;
  confidence: number;
  importance: number;
  expiresAt?: string;
};

const blockedPatterns = [
  /\b(?:mot de passe|password|passcode|otp|code de connexion|2fa)\b/i,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|bearer)\b/i,
  /\b(?:carte bancaire|numéro de carte|iban|bic|crypto wallet)\b/i,
  /\b(?:santé|maladie|diagnostic|religion|politique|orientation sexuelle|biométrie)\b/i,
  /\b\d{1,5}\s+(?:rue|avenue|boulevard|chemin|route|allée|allee|impasse)\b/i,
  /\b-?\d{1,2}\.\d{4,}\s*[,;]\s*-?\d{1,3}\.\d{4,}\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:\d[ -]?){13,19}\b/,
];

export function containsSensitiveMemory(value: string) {
  const text = String(value || "").slice(0, 8_000);
  return blockedPatterns.some((pattern) => pattern.test(text));
}

export function sanitizeMemoryCandidate(candidate: MemoryCandidate): MemoryCandidate | null {
  const statement = String(candidate.statement || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  if (statement.length < 5 || containsSensitiveMemory(statement)) return null;
  const parsedType = memoryTypeSchema.safeParse(candidate.type);
  if (!parsedType.success) return null;
  const confidence = Math.max(0, Math.min(1, Number(candidate.confidence) || 0));
  const importance = Math.max(0, Math.min(1, Number(candidate.importance) || 0));
  if (confidence < 0.8) return null;
  return { type: parsedType.data, statement, confidence, importance, ...(candidate.expiresAt ? { expiresAt: candidate.expiresAt } : {}) };
}

export function deterministicCandidates(text: string): MemoryCandidate[] {
  const value = String(text || "").replace(/[\r\n]+/g, " ").trim().slice(0, 4_000);
  if (!value || containsSensitiveMemory(value)) return [];
  const explicitMemory = value.match(/(?:rappelle(?:-|\s)?toi|souviens(?:-|\s)?toi|retiens|remember|recuerda)(?:\s+bien)?\s+(?:que|that)\s+([^.!?]{3,500})/i);
  const explicitCandidates: MemoryCandidate[] = explicitMemory?.[1]
    ? [{
      type: /\b(?:objectif|projet|campagne|on travaille|on avance)\b/i.test(explicitMemory[1])
        ? "project"
        : /\b(?:j['’]aime|je préfère|je prefere|ma préférence|my preference|me gusta)\b/i.test(explicitMemory[1])
          ? "preference"
          : "profile",
      statement: explicitMemory[1].trim(),
      confidence: 0.99,
      importance: 1,
    }]
    : [];
  const patterns: Array<[MemoryType, RegExp, number]> = [
    ["project", /(?:le dernier (?:truc|sujet|travail)|la dernière chose) qu['’]on a (?:fait|vue?|traitée?|travaillée?)(?: ensemble)?(?:,? c['’](?:était|est))?\s+([^.!?]{2,300})/i, 0.98],
    ["project", /(?:on en était|on s['’]est arrêté|nous nous sommes arrêtés|on a travaillé)(?: sur| à)?\s+([^.!?]{3,300})/i, 0.94],
    ["profile", /(?:je m['’]appelle|appelle[- ]moi)\s+([^,.!?]{2,60})/i, 0.95],
    ["preference", /(?:je préfère|je prefere|j['’]aime mieux)\s+([^.!?]{3,220})/i, 0.9],
    ["project", /(?:mon objectif(?: est)?|je veux|je souhaite)\s+([^.!?]{5,260})/i, 0.86],
    ["profile", /(?:je travaille (?:comme|dans)|mon métier(?: est)?)\s+([^.!?]{3,180})/i, 0.88],
  ];
  return [...explicitCandidates, ...patterns.flatMap(([type, pattern, confidence]) => {
    const match = value.match(pattern);
    if (!match?.[1]) return [];
    return [{ type, statement: match[0].trim(), confidence, importance: type === "project" ? 0.9 : 0.75 }];
  })];
}

export function isForgetCommand(text: string) {
  return /\b(?:oublie (?:ça|cela|ceci)|ne retiens pas|ce n['’]est plus mon objectif|forget (?:that|this)|olvida (?:eso|esto))\b/i.test(String(text || ""));
}
