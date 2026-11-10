import type { CanonicalKnowledge } from "./contracts";
import { parsePastedKnowledge } from "./paste-document";

// Prepares a NEW knowledge draft from pasted text, for the existing proposal flow
// (saveSavKnowledgeProposal, mode "new"). Pure: no model, embedding, database or publication.

export const pasteNewLimits = { textChars: 100_000, titleChars: 500 } as const;

const emptyBase: CanonicalKnowledge = {
  schemaVersion: 1, objective: "", applicability: "sav_only", locale: "fr-FR", productVersion: "",
  prerequisites: [], expectedResult: "", exceptions: [], escalation: "", steps: [],
};

// Text that addresses the assistant is kept as reviewed data; it never becomes a permission.
const injectionPatterns = [
  /\b(ignore[sz]?|oublie[sz]?)\b.{0,40}\b(instructions?|consignes?|règles?|previous|above)\b/i,
  /\b(system prompt|prompt système|consignes? système)\b/i,
  /\b(you are now|tu es désormais|vous êtes désormais|à partir de maintenant,? tu)\b/i,
  /\b(publie[rz]?|active[rz]?|envoie[rz]?|rembourse[rz]?|supprime[rz]?)\b.{0,30}\b(automatiquement|sans validation|sans revue|immédiatement)\b/i,
];

export type PasteNewInput = { text: string; title?: string; sourceLabel?: string; sourceRef?: string };
export type PasteNewPreparation = {
  title: string; document: CanonicalKnowledge;
  sources: { label: string; ref: string }[];
  missing: string[]; warnings: string[]; fingerprint: string;
};

export function normalizePastedText(text: string) {
  return text.replace(/\r\n?/g, "\n").replace(/[​-‍﻿]/g, "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

// Plain text without "##" rubrics: numbered lines become the procedure, other lines the objective.
function structure(text: string) {
  if (/^##\s+/m.test(text)) return text;
  const lines = text.split("\n");
  const titleLine = lines[0]?.startsWith("# ") ? lines.shift()! : "";
  const steps = lines.filter(line => /^\s*\d+[.)]\s+\S/.test(line)).map(line => line.trim());
  const objective = lines.filter(line => line.trim() && !/^\s*\d+[.)]\s+\S/.test(line)).join("\n").trim();
  return [titleLine, "## Objectif", objective, ...(steps.length ? ["## Procédure proposée", ...steps] : [])].filter(Boolean).join("\n");
}

export function preparePastedKnowledge(input: PasteNewInput): PasteNewPreparation {
  const text = normalizePastedText(input.text ?? "");
  if (!text) throw new Error("Collez le texte de la connaissance.");
  if (text.length > pasteNewLimits.textChars) throw new Error(`Le texte dépasse ${pasteNewLimits.textChars.toLocaleString("fr-FR")} caractères. Découpez-le en plusieurs fiches.`);
  const parsed = parsePastedKnowledge(structure(text), emptyBase);
  const title = (input.title?.trim() || parsed.title).slice(0, pasteNewLimits.titleChars);
  const label = input.sourceLabel?.trim() ?? ""; const ref = input.sourceRef?.trim() ?? "";
  if (ref && !/^(?:https:\/\/[^\s]+|(?:content|sav-learning|sav-observation|knowledge-source):[a-z0-9:._-]+)$/i.test(ref)) throw new Error("La référence de source doit être une adresse https:// ou une référence interne (content:…, knowledge-source:…).");
  if (ref && label.length < 3) throw new Error("Donnez un libellé d’au moins 3 caractères à la source.");
  const document = parsed.document;
  const missing: string[] = [];
  if (!title) missing.push("Titre");
  if (!ref) missing.push("Origine (source vérifiable)");
  if (!document.productVersion) missing.push("Version produit et date de validité");
  if (!document.steps.length) missing.push("Procédure (étapes numérotées)");
  if (!document.expectedResult) missing.push("Résultat attendu");
  if (!document.escalation) missing.push("Escalade (quand passer à un humain)");
  const warnings = text.split("\n").filter(line => injectionPatterns.some(pattern => pattern.test(line))).slice(0, 10)
    .map(line => `Consigne adressée à l’assistant, conservée comme donnée à revoir : « ${line.trim().slice(0, 160)} »`);
  const sources = ref ? [{ label, ref }] : [];
  // Content key (generated step ids excluded): the same paste saved twice keeps one draft revision.
  const fingerprint = JSON.stringify([title, structure(text), label, ref]);
  return { title, document, sources, missing, warnings, fingerprint };
}
