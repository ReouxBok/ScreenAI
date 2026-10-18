import type { SavReplyCoverage, SavUnderstandingV1 } from "./understanding";

export const SAV_EMAIL_WRITING_REVISION = "sav-email-writing-2026-10-18.v1";
/** Independent writing skill. Content still comes exclusively from the reviewed
 * request plan. This instruction grants no new knowledge, tool or permission. */
export const SAV_EMAIL_WRITING_SKILL = `Écris un email professionnel, chaleureux, direct et facile à lire. Vouvoyer en français. Une seule salutation, puis des paragraphes courts ; étapes ordonnées si nécessaire. Répondre aux demandes courantes sans recopier longuement le mail. Reconnaître les étapes déjà effectuées ; demander leurs détails ou leur résultat si nécessaire, sans imposer de recommencer ni redemander un fait connu. Garder exactement les noms des menus et les instructions vérifiées. Ne jamais inventer de diagnostic, opération réalisée, engagement ou délai pour améliorer le style. Terminer par une formule courte. La signature et la mention IA sont ajoutées séparément selon le mode réel d'envoi ; ne jamais prétendre à une revue humaine absente. La version finale doit passer les mêmes contrôles de couverture, preuve et cohérence. Aucune réécriture libre après validation.`;

/** Greeting and closing are part of assessed coverage, not an unchecked tail. */
export function styleSavEmailCoverage(u: SavUnderstandingV1, coverage: SavReplyCoverage): SavReplyCoverage {
  if (!coverage.length) return coverage;
  const result = coverage.map(part => ({ ...part }));
  const greeting = u.language === "en" ? "Hello," : "Bonjour,";
  const closing = u.language === "en" ? "Kind regards," : "Bien à vous,";
  if (!/^(?:bonjour|bonsoir|hello|hi|dear)\b/iu.test(result[0].text.trim())) result[0].text = `${greeting}\n\n${result[0].text.trim()}`;
  const last = result[result.length - 1];
  if (!/(?:bien à vous|cordialement|kind regards|best regards|regards)[,.!]?\s*$/iu.test(last.text)) last.text = `${last.text.trim()}\n\n${closing}`;
  return result;
}
