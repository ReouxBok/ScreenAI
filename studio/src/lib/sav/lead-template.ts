import { articleMetadataSchema, assertSafeMarkdown } from "../content";
import type { KnowledgeSearchResult } from "../search";
import { savActiveSubject, savNonSupportIntent, splitSavMessageText } from "./message-context";
import { deterministicDecision, isSavCancellationRequest, type SavClassificationInput } from "./policy";
import { cleanSavModelDraft } from "./reply-format";

/** Applicability is determined from the current request, not a historical quote or a CRM contact label. */
export function isSavLeadProductInquiry(input: SavClassificationInput) {
  const current = splitSavMessageText(input.body).currentText;
  if (!current || current.length > 12_000) return false;
  const nonSupport = savNonSupportIntent(input);
  if (nonSupport && nonSupport !== "presales") return false;
  const decision = deterministicDecision(input);
  if (!["presales_review", "new_customer_support_request", "ambiguous_inbound_message", "finance_human_only"].includes(decision.reasonCode)) return false;
  if (isSavCancellationRequest(input)) return false;
  const text = `${savActiveSubject(input)}\n${current}`.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  // Existing account usage, financial operations and mixed requests require their own human qualification.
  if (/\b(?:mon|ma|mes|notre|nos|my|our)\s+(?:compte|account|abonnement|subscription|facture|invoice|agent|licence|license|plan)\b|\b(?:deja client|already a customer|je suis client|i am a customer|registration email|email du compte)\b/.test(text)) return false;
  if (/\b(?:support|sav|bug\w*|erreur\w*|error\w*|probleme\w*|problem\w*|bloqu\w*|broken|connexion|login|factur\w*|invoic\w*|rembours\w*|refund\w*|prelev\w*|debit\w*|paiement\w*|payment\w*|paid|paye\w*|solde|balance|recharg\w*|chargeback|iban|rib|tva|vat|bancaire|bank|pirat\w*|fraud\w*|rgpd|gdpr|avocat|lawyer|securite|security|password|mot de passe|api key|secret|urgent|urgence|critical)\b|(?:ne|n['’]).{0,40}(?:pas|plus)|not working|doesn['’]?t work/.test(text)) return false;
  const body = current.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const product = /\b(?:limova|produits?|products?|offres?|offering|solution|services?)\b/.test(body);
  const discovery = /(?:informations?|renseignements?|en savoir plus|decouvrir|interesse|interested|learn more|more info|details|demonstration|demo|devis|quotation|quote|tarifs?|pricing|prices?)/.test(body);
  return discovery && (product || nonSupport === "presales");
}

export function assertSavUnsignedTemplate(template: string) {
  const plainLines = template.split(/\r?\n/).map(line => line.replace(/^[\s*_>#-]+|[\s*_]+$/g, "").trim());
  const normalized = template.normalize("NFKD").replace(/\p{M}/gu, "");
  if (cleanSavModelDraft(template) !== template.trim()
    || plainLines.some(line => /^(?:Charly\b|L['’][ée]quipe Limova\b|Limova team\b)/i.test(line))
    || /(?:preparee? avec une IA|prepared with AI|assistant IA SAV)/i.test(normalized)) throw new Error("SAV_TEMPLATE_MUST_BE_UNSIGNED");
}

/** No model rewrites a reviewed template. Conflicts, stale evidence or missing provenance yield no draft. */
export function selectSavLeadTemplate(results: KnowledgeSearchResult[], now = new Date()) {
  const candidates = results.filter(source => source.resolution?.audience === "lead" && source.score >= 0.5);
  if (candidates.length !== 1) return null;
  const source = candidates[0];
  const parsed = articleMetadataSchema.shape.resolution.unwrap().safeParse(source.resolution);
  if (!parsed.success || !source.id || !source.contentVersionId || !parsed.data.responseTemplate || !parsed.data.steps.length || !parsed.data.symptoms.length) return null;
  const resolution = parsed.data;
  if (resolution.conflictsWith.length || (resolution.validUntil && resolution.validUntil < now.toISOString().slice(0, 10))) return null;
  const verified = source.verifiedAt ? new Date(source.verifiedAt) : null;
  if (!verified || !Number.isFinite(verified.getTime()) || verified > now || now.getTime() - verified.getTime() > 90 * 86_400_000) return null;
  try { assertSafeMarkdown(resolution.responseTemplate!); assertSavUnsignedTemplate(resolution.responseTemplate!); }
  catch { return null; }
  return { source, template: resolution.responseTemplate! };
}
