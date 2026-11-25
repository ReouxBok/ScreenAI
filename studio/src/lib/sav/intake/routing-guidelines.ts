// V1 routing classes (Ugo, 23/11): the written guideline added to V1's understanding call ONLY when `SAV_INTAKE_ROUTING_MODE` is shadow or live. It asks
// the model for ONE dossier-level routing class with its confidence. The request kinds V1 already returns are unchanged; this class only feeds the routing
// decision (`routing-rules.ts`). Examples are invented and generic: never paste a real customer mail here (public repository).

import { savIntakeSafeArchiveGuideline } from "./to-validate-rules";

/** Bumped on every wording change: it enters the launch hash with the switch on (`runtime-contract.ts`). */
export const SAV_INTAKE_ROUTING_REVISION = "sav-intake-routing-2026-11-23.v2";

/** SAV-139: `safeArchive` (`SAV_INTAKE_SAFE_ARCHIVE=on`) appends the phishing class and the customer-signal judgement; off, the text is unchanged. */
export function savIntakeRoutingGuideline(safeArchive = false) {
  return [
    "ROUTING CLASS GUIDELINE (dossier level). Also return `routing` = {class, confidence, justification}: the ONE class that best describes what the sender of the CURRENT authored message wants from Limova. It does not replace the request kinds; keep them exactly as you would without this field.",
    "Key distinction: they want to BUY from us or USE Limova = lead_commercial; they want to SELL us something = demarchage; they want to BUILD something together with Limova = partenariat.",
    "Classes:",
    "- support: an existing user's product, technical or account question or problem (how-to, bug, access, configuration).",
    "- finance: invoice, payment, refund, billing error, VAT, receipt. Every payment, invoice, failed charge, card or direct debit (prélèvement) notification is finance, even when a machine sent it (Stripe, a bank, a payment provider): never notification_auto.",
    "- cancellation: wants to cancel, unsubscribe from a paid plan, close the account or stop a renewal.",
    "- acknowledgement: only thanks / ok / received, nothing to do.",
    "- lead_commercial: someone interested in buying or using Limova who is not yet in an exchange with us: wants to subscribe, asks for information, a price, a quote, a demo, a trial, or whether Limova fits their need. Ex: « Bonjour, je dirige un cabinet de 5 personnes, combien coûte votre offre et peut-on avoir une démo ? »; « Votre assistant peut-il gérer les appels de mon agence ? Je souhaite m'abonner ».",
    "- candidature: a job, internship or work-study (alternance) application, a spontaneous application with a CV, or a freelancer offering to join the team. Freelancer rule: a freelancer who wants to JOIN the team (CV, availability, wants a job or a mission inside Limova) = candidature; a freelancer or an agency offering a paid service TO Limova = demarchage. Ex: « Je vous adresse ma candidature pour un stage de 6 mois en marketing »; « Développeur freelance, je souhaite rejoindre votre équipe ».",
    "- investisseur: an investment or fundraising message ABOUT Limova (an investor, a fund or a business angel interested in investing, or a request about Limova's funding round). Ex: « Notre fonds investit en seed dans l'IA, seriez-vous ouverts à un échange sur votre levée ? ». A lender or broker selling loans or financing to us is demarchage, not investisseur.",
    "- partenariat: a genuine proposal to work WITH Limova for mutual benefit: co-marketing, an event or a conference invitation as a partner, sponsoring of or by Limova, an integration or technology partnership, a reseller or affiliate agreement, a school or association partnership. Ex: « Nous organisons un salon des TPE et aimerions vous avoir comme partenaire »; « Notre logiciel de caisse souhaite s'intégrer avec Limova ».",
    "- demarchage: someone trying to SELL Limova a product or service, and every newsletter, promotion or marketing mail: agencies (SEO, ads, web, video), lead-generation, fake reviews, influencer or YouTube sponsorship offers paid by us, loans and financing offers, recruiting agencies, software vendors, webinars and promotional mailings. Ex: « Nous pouvons doubler votre trafic grâce à notre agence SEO »; « Boostez vos avis Google : 50 avis 5 étoiles »; « Ma chaîne YouTube peut présenter votre produit, tarif sponsor ci-joint »; « Newsletter de novembre : -30 % sur nos formations ». A vendor that calls its offer a « partenariat » is still demarchage when Limova would be the paying customer.",
    "- notification_auto: a message produced by a machine with nobody to answer: delivery failure or bounce (mailer-daemon, « Undeliverable », « Delivery Status Notification »), antispam challenge or sender verification, login or security alert, account or platform notification with no money involved (a marketplace, a social network, a tool's activity digest), out-of-office or other automatic reply, calendar or form receipt with no question. Ex: « Message non remis : l'adresse est introuvable »; « Je suis absent jusqu'au 2 décembre »; « Nouvelle connexion détectée sur votre compte ».",
    "- mixed: several of these classes with real weight in the same message (for example a support problem and a purchase question).",
    "- unknown: you cannot tell.",
    "Rules: a reply in an existing exchange with our team, or anything that mentions an existing subscription, invoice or account problem, is never lead_commercial, demarchage or notification_auto: use support, finance, cancellation or mixed. Any finance or cancellation element wins (class finance or cancellation). confidence = high only when the message leaves no reasonable doubt; medium or low otherwise. justification: one short factual sentence, no personal data.",
    ...(safeArchive ? [savIntakeSafeArchiveGuideline()] : []),
  ].join("\n");
}
