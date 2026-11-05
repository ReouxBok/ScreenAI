import "server-only";
import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { splitSavMessageText } from "../message-context";
import { savOutsidePersonalAccessScope, savPersonalAccessIntent } from "../request-retrieval";
import { admissionPolicyPort, type AdmissionPolicyRecord } from "./admission-runtime";
import { SAV_CASE_SENSITIVE_FAMILIES, type CaseAdmissionQualification, type CaseRequestFamily } from "./case-types";
import { relayQualification } from "./intake-boundary";
import { loginCustomerStatement, reportsOngoingLoginFailure, reportsRestoredAccess } from "./restored-access";
import { caseLatestCustomerMail } from "./investigation-runner";
import type { CaseInvestigationStoreDeps } from "./investigation-store-ports";
import { CaseQualificationUnavailableError, type CaseQualificationCauseCode } from "./qualification-diagnostic";

/*
 * V2 customer return (contract A-B, 4/11), LOCAL and OFF: a mail V2 consumed on an open case BEFORE V1 has, by construction, no V1 decision.
 * Its content is qualified again here, on its own words, by the approved return rules (an injected port; none is approved, so production
 * admits nobody on a return), with the case's identity carried only when the same stored sender wrote it. Never the admission of an older
 * mail copied over: a qualification that does not name the current input does not let the investigation answer it. Reads the database only.
 */

/** What an approved return rule is given: the case's open requests and the return mail's own words. It answers with `qualified_rule` requests. */
export type CaseReturnRulePort = (input: Readonly<{
  caseId: string; messageId: string; text: string; changedSubject?: string;
  requests: ReadonlyArray<Readonly<{ requestId: string; family: CaseRequestFamily }>>;
}>) => Promise<CaseAdmissionQualification["requests"]>;

export type CaseReturnQualifyDeps = Readonly<{
  readPolicyRecord(): Promise<AdmissionPolicyRecord | null>;
  now(): Date;
  /** Approved return rules. Absent (production today): hints only, so nobody is admitted on a return and the case goes to the team. */
  returnRules?: CaseReturnRulePort;
}>;

const sensitive = (family: string) => (SAV_CASE_SENSITIVE_FAMILIES as readonly string[]).includes(family);
const lower = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

/**
 * B's `qualify` with the dedicated return path: a customer return is qualified here, anything else goes to `v1Qualify` (A's canonical V1 path)
 * unchanged. Refusals are A6's typed ones (technical: retried later, nothing written; contract: never retried as is).
 */
export function caseInvestigationReturnAwareQualify(v1Qualify: CaseInvestigationStoreDeps["qualify"], deps: CaseReturnQualifyDeps): CaseInvestigationStoreDeps["qualify"] {
  const policyPort = admissionPolicyPort({ read: deps.readPolicyRecord, now: deps.now });
  return async (snapshot, events) => {
    const latest = caseLatestCustomerMail(events);
    if (!latest?.customerReturn) return v1Qualify(snapshot, events);
    const { inputKey, event } = latest, inputVersion = snapshot.admissionInputVersion;
    const refuse = (code: "relay_proof_invalid" | "rule_unavailable" | "rule_invalid" | "policy_unavailable", causeCode: CaseQualificationCauseCode | null = null) =>
      new CaseQualificationUnavailableError({ code, inputKey, inputVersion, causeCode });
    // The return must be the current input, recorded by the return route for this stored mail.
    const messageId = event.detail?.messageId, relay = event.detail?.relay as { messageId?: unknown } | undefined;
    if (event.kind !== "inbound_confirmed" || event.caseVersion !== inputVersion || typeof messageId !== "string" || relay?.messageId !== messageId) throw refuse("relay_proof_invalid");
    const db = requireDb();
    let text: string, sender: string, subject: string;
    try {
      const [mail] = await db.select().from(savMessages).where(eq(savMessages.id, messageId));
      if (!mail || mail.direction !== "inbound" || mail.gmailMessageId !== latest.gmail || !snapshot.threadIds.includes(mail.threadId)) throw refuse("relay_proof_invalid");
      const body = decryptSavPayload<{ text?: unknown }>(mail.bodyCiphertext);
      if (typeof body.text !== "string" || !body.text.trim()) throw refuse("rule_unavailable");
      text = body.text; sender = lower(mail.fromEmail); subject = mail.subject;
    } catch (error) {
      if (error instanceof CaseQualificationUnavailableError) throw error;
      throw refuse("rule_unavailable");
    }
    // Identity and CRM context are carried from the case's own admission only for the same stored sender as the mail V1 relayed; anyone else is unknown.
    const prior = snapshot.admission?.qualification;
    const relayed = [...events].reverse().find(row => row.direction === "customer_inbound" && (row.detail?.relay as { kind?: unknown } | undefined)?.kind === "intake_effects_confirmed");
    const relayedId = relayed?.detail?.messageId;
    const [origin] = typeof relayedId === "string" ? await db.select({ fromEmail: savMessages.fromEmail, subject: savMessages.subject }).from(savMessages).where(eq(savMessages.id, relayedId)) : [];
    const sameSender = Boolean(origin && sender && lower(origin.fromEmail) === sender);
    const identity: CaseAdmissionQualification["identity"] = sameSender && prior?.identity.status === "confirmed" ? prior.identity : { status: "unknown" };
    const crmContext: CaseAdmissionQualification["crmContext"] = sameSender && prior ? prior.crmContext : "unknown";
    // The return continues the case's open requests; its own words decide their families again. A model hint never admits.
    const open = snapshot.body.openRequests.filter(row => row.status === "open").map(row => ({ requestId: row.id, family: row.family as CaseRequestFamily }));
    if (!open.length) return null;
    const hints: CaseAdmissionQualification = { requests: open.map(row => ({ requestId: row.requestId, family: row.family, provenance: { kind: "intake_hint", source: event.sourceRef } })),
      identity, crmContext, teamSignals: [] };
    let qualification = hints;
    if (deps.returnRules) {
      let ruled: CaseAdmissionQualification["requests"];
      // A reply prefix alone does not establish that the subject is old: compare it to the
      // subject on the original stored mail. A new subject may veto a continuation.
      const topic = (raw: string) => lower(raw).replace(/^(?:(?:re|rép|aw|sv)\s*:\s*)+/u, "").replace(/\s+/gu, " ").trim();
      const changedSubject = origin && topic(subject) === topic(origin.subject) ? undefined : subject;
      try { ruled = await deps.returnRules({ caseId: snapshot.caseId, messageId, text, changedSubject, requests: open }); } catch { throw refuse("rule_unavailable"); }
      const ids = new Set(open.map(row => row.requestId)), mailAt = Date.parse(event.occurredAt);
      // Only rules that read THIS mail: dated on or after it, on the case's open requests.
      if (ruled.some(row => row.provenance.kind !== "qualified_rule" || !ids.has(row.requestId) || !(Date.parse(row.provenance.at) >= mailAt))) throw refuse("rule_invalid");
      try {
        qualification = relayQualification(hints, { ...hints, requests: ruled }, open.map(row => ({ requestId: row.requestId, kind: row.family })));
      } catch { throw refuse("rule_invalid"); }
      // A sensitive family the rules found stays, whatever the earlier access request was.
      qualification = { ...qualification, requests: qualification.requests.filter(row => row.provenance.kind === "qualified_rule" || sensitive(row.family) || !ruled.some(r => r.requestId === row.requestId)) };
    }
    let policy: unknown;
    try { policy = await policyPort(); } catch { throw refuse("policy_unavailable"); }
    return { admission: { policy, qualification }, sourceRef: event.sourceRef };
  };
}

const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/[’`]/g, "'");
// Read on the customer's own new words (quoted history and signature removed). Any sensitive word wins: a sensitive or mixed return stops.
const SENSITIVE: ReadonlyArray<readonly [CaseRequestFamily, RegExp]> = [
  ["cancellation", /\b(?:resili\w*|desabonn\w*|annuler (?:mon|l'|notre) (?:abonnement|compte|offre)|supprimer (?:mon|notre) compte|fermer (?:mon|notre) compte)\b/],
  ["finance", /\b(?:rembours\w*|factur\w*|paiement\w*|pay(?:er|e|ee|es|ees|ant|ante)|prelev\w*|debit\w*|carte bancaire|avoirs?|litige|impaye\w*|tarif\w*|prix)\b/],
  ["subscription", /\b(?:abonnement|changer d'offre|changement d'offre|upgrade|downgrade|essai gratuit|forfait)\b/],
  ["rights", /\b(?:rgpd|donnees personnelles|droit d'acces|suppression de (?:mes|nos) donnees)\b/],
  ["identity", /\b(?:changer (?:le|de) (?:proprietaire|titulaire)|transferer (?:le|mon) compte|usurp\w*|pirat\w*|compte (?:vole|hacke))\b/],
];
// Leave ambiguous "avoir" under the financial fence. Only an infinitive with an explicit
// login object or a reported check is removed from the sensitive scan; other words still count.
const LOGIN_INFINITIVE = /(?<!\b(?:un |cet |mon |ton |son |notre |votre |leur |l'))\bavoir(?=\s+(?:(?:le|mon|un|ce) (?:bon )?(?:code|lien)|acces|(?:bien |deja )?(?:verifie|consulte|regarde|essaye))\b)/g;
// A mail provider may be the inbox checked for a login code. Remove just that reference
// before the scope check; a separate request about an integration or an invite still wins.
const INBOX_PROVIDER = /\b(spams?|courriers indesirables|boite (?:mail|de reception)) (?:de |sur )?(?:mon |ma )?(?:gmail|outlook)\b/g;
const SENDER_ADDRESS = /[\w.+%-]+@[\w.-]+\.[a-z]{2,}\b/g;
// A plain continuation of the same access trouble: still no code, still blocked, what the screen shows.
const ACCESS_CONTINUATION = /\b(?:(?:aucun|pas de|pas le) code|identifiant (?:introuvable|inconnu|invalide)|message d'erreur|l'ecran affiche|je n'arrive (?:toujours )?pas a me connecter)\b/;
const BARE_REMINDER = /^(?:(?:bonjour|bonsoir)[\s,.!;-]+)?(?:merci(?: (?:de|pour) (?:votre|le) (?:retour|message|conseil))?[\s,.!;-]+)?(?:je suis |c'est )?(?:toujours (?:pas|rien|bloquee?|le meme probleme)|ca ne (?:marche|fonctionne) (?:toujours )?pas|(?:je n'ai |j'ai )?(?:toujours )?rien recu|meme probleme)[\s,.!;-]*(?:merci[\s,.!;-]*)?$/;
const CHECKED_INBOX = /\b(?:j'ai|nous avons) (?:bien |deja |aussi )?(?:verifie|regarde|consulte) (?:dans )?(?:mes |nos |les )?(?:spams?|courriers indesirables)\b/;

// A title can describe an older topic. Only the inbound customer's own request can admit a new ticket.
export function firstPersonalLoginRequest(text: string, subject: string): boolean {
  const parts = splitSavMessageText(text);
  const all = normalize([subject, parts.currentText, parts.signatureText].join("\n")).replace(LOGIN_INFINITIVE, "");
  const changeAccount = /\b(?:creer|ouvrir) (?:un|mon|notre) compte\b|\b(?:chang\w*|modifi\w*) (?:mon |notre |l'|d')?adresse (?:e-?mail|mail)\b|\b(?:mfa|2fa|droits? administrateur)\b/;
  if (changeAccount.test(all) || SENSITIVE.some(([, pattern]) => pattern.test(all))) return false;
  const own = normalize(loginCustomerStatement(parts)).replace(SENDER_ADDRESS, "").replace(INBOX_PROVIDER, "$1");
  const title = normalize(subject).replace(SENDER_ADDRESS, "").replace(INBOX_PROVIDER, "$1");
  return !savOutsidePersonalAccessScope(title) && savPersonalAccessIntent(own);
}

/**
 * A REAL return rule on the current content (contract A-B): it reads the return mail's own words, never V1's analysis of an older mail.
 * Sensitive words (finance, cancellation, subscription, rights, identity) qualify every open request with that family, so a sensitive or
 * mixed return is withdrawn to the team; a plain continuation of an access-only case stays `access`; anything else is not qualified (the
 * team). The rule id and revision are given by the caller from the approved policy: a rule the policy does not approve admits nobody.
 */
export function caseReturnContentRule(rule: Readonly<{ ruleId: string; revision: string }>, now: () => Date): CaseReturnRulePort {
  return async ({ text, changedSubject, requests }) => {
    const parts = splitSavMessageText(text), value = normalize(loginCustomerStatement(parts)).trim();
    if (!value.trim()) return [];
    const at = now().toISOString(), provenance = { kind: "qualified_rule" as const, ruleId: rule.ruleId, revision: rule.revision, at };
    // Some mail clients leave a new line of customer text after a sign-off. A sensitive
    // request there must still stop the case; quoted correspondence is historical.
    const sensitiveText = normalize([changedSubject, parts.currentText, parts.signatureText].join("\n")).replace(LOGIN_INFINITIVE, "");
    const sensitive = SENSITIVE.find(([, pattern]) => pattern.test(sensitiveText));
    if (sensitive) return requests.map(row => ({ requestId: row.requestId, family: sensitive[0], provenance }));
    const scopeText = value.replace(SENDER_ADDRESS, "").replace(INBOX_PROVIDER, "$1");
    if (savOutsidePersonalAccessScope(scopeText) || (changedSubject && savOutsidePersonalAccessScope(changedSubject))) return [];
    if (requests.length && requests.every(row => row.family === "access")
      && (savPersonalAccessIntent(scopeText) || ACCESS_CONTINUATION.test(value) || BARE_REMINDER.test(value) || CHECKED_INBOX.test(scopeText) || reportsOngoingLoginFailure(value) || reportsRestoredAccess(value)))
      return requests.map(row => ({ requestId: row.requestId, family: "access" as const, provenance }));
    return [];
  };
}
