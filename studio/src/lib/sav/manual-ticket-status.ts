/** Safe user-facing diagnostics: never echo provider text or payload content. */
export function savManualTicketError(code: string | null): string {
  if (code === "SAV_TICKET_RETURN_CONTEXT_CHANGED") return "Le ticket ou sa clôture a changé. Actualisez le contexte et confirmez de nouveau l’action proposée.";
  if (code === "SAV_TICKET_RETURN_EMAIL_TOO_LARGE") return "L’email dépasse la taille autorisée pour une note. Ajoutez-le manuellement dans HubSpot.";
  if (code === "SAV_TICKET_RETURN_RECONCILIATION_REQUIRED") return "La note ou la réouverture a peut-être abouti. Vérifiez le ticket dans HubSpot ; aucune nouvelle tentative automatique.";
  if (code === "SAV_TICKET_RETURN_LEGACY_OWNER_UNVERIFIABLE") return "Cette ancienne action ne contient pas de preuve du propriétaire attendu. Faites vérifier et terminer l’opération dans HubSpot ; le Studio ne peut pas la rapprocher automatiquement. Ne recréez pas la note ni le ticket.";
  const messages: Record<string, string> = {
    SAV_FORWARDED_CUSTOMER_UNRESOLVED: "L’adresse du client transféré est ambiguë ou absente. Faites vérifier le message original ; aucun contact ni ticket ne sera créé.",
    SAV_TICKET_OWNER_REQUIRED: "Le propriétaire du ticket ne peut pas être vérifié. Vérifiez son attribution dans HubSpot puis actualisez le contexte avant de confirmer de nouveau.",
    SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED: "Validez la proposition courante avant de créer ou rattacher le ticket.",
    SAV_PROPOSAL_STALE: "La proposition validée a changé. Relisez le dernier email et validez la proposition courante avant de reprendre.",
    SAV_HUBSPOT_CONTACT_REQUIRED: "Aucun contact HubSpot confirmé pour ce dossier. Vérifiez l’email d’inscription dans le dossier puis revalidez la proposition. Aucun contact créé.",
    SAV_EXISTING_TICKET_REQUIRES_LINK: "Un ticket semble déjà couvrir cette demande. Vérifiez les tickets du client puis utilisez le rattachement à un ticket existant.",
    SAV_DISTINCT_ISSUE_CONFIRMATION_REQUIRED: "Un ticket ouvert existe pour ce client. Justifiez pourquoi il s’agit d’un problème distinct avant de redemander la création.",
    SAV_LINK_TARGET_INVALID: "Le ticket choisi n’est pas un ticket ouvert du contact confirmé. Vérifiez le dossier HubSpot et corrigez l’ID du ticket.",
    SAV_LINK_TICKET_ID_REQUIRED: "Indiquez l’ID du ticket HubSpot à rattacher.",
    SAV_MANUAL_RECONCILIATION_REQUIRED: "La création a peut-être abouti. Vérifiez HubSpot puis rapprochez le ticket existant ci-dessous. Ne relancez pas la création.",
    SAV_GMAIL_THREAD_CHANGED: "Un nouvel email est arrivé dans Gmail. Actualisez le contexte du dossier, relisez le dernier email et revalidez la proposition.",
    SAV_GMAIL_PREFLIGHT_INCOMPLETE: "La conversation Gmail n’a pas pu être vérifiée. Vérifiez la synchronisation avant de reprendre la demande.",
    SAV_WRITES_DISABLED: "Les écritures HubSpot sont désactivées. La demande reste en attente tant que cet environnement ne les autorise pas.",
    SAV_TICKET_ALREADY_LINKED: "Un ticket est déjà lié à ce dossier. Actualisez le dossier pour consulter son ID.",
    SAV_TICKET_ACTION_ALREADY_QUEUED: "Une demande de création ou de rattachement est déjà enregistrée. Consultez son suivi avant toute nouvelle demande.",
    SAV_TICKET_ACTION_IN_PROGRESS: "La demande HubSpot est en cours. Actualisez le dossier pour consulter son résultat.",
    SAV_MESSAGE_BEFORE_CUTOVER: "Cet email est antérieur à l’activation du flux SAV. Aucune création autorisée dans ce parcours.",
    SAV_MANUAL_TICKET_INVALID: "La demande n’a pas pu être enregistrée. Actualisez le dossier et vérifiez la validation et les champs saisis.",
  };
  if (code && messages[code]) return messages[code];
  if (/HUBSPOT_HTTP_40[13]/.test(code ?? "")) return "HubSpot refuse l’accès. Faites vérifier les droits de l’intégration avant de reprendre la demande.";
  if (/HUBSPOT_HTTP_429/.test(code ?? "")) return "HubSpot limite temporairement les appels. Consultez le suivi de la prochaine tentative.";
  if (/HUBSPOT_HTTP_4/.test(code ?? "")) return "HubSpot refuse cette demande. Faites vérifier les champs du ticket et la configuration du pipeline avant de reprendre.";
  if (/GMAIL_.*(?:MISSING|HTTP_40[13])/.test(code ?? "")) return "L’accès Gmail n’a pas pu être vérifié. Faites vérifier les droits et la configuration de l’intégration.";
  return "La demande HubSpot n’a pas pu être confirmée. Faites vérifier le journal d’actions avant de reprendre.";
}
