# Continuer le parcours dans la conversation Deep Agent

Le panneau affiche un bouton « Besoin de la prochaine étape ? » après la dernière réponse visible de l’assistant, y compris après chargement de l’historique. Il ne l’affiche pas lorsque le dernier message est humain ou lorsqu’une erreur de flux est présente.

Le bouton envoie une demande localisée via `LIMOVA_SEND_MESSAGE` dans la conversation sélectionnée, sans recréer de chat. Le consentement IA reste requis. L’accès navigateur suit la case d’autorisation du tour ; sans cette case, la demande utilise seulement le contexte de conversation côté Limova. Elle n’accorde pas silencieusement l’accès à la page. Pendant un tour vocal ou texte, le bouton est désactivé et le panneau refuse un second envoi. L’entraînement interdit aussi ce raccourci.

Le handler sidebar n’envoie plus `NEXT_STEP`. Le handler legacy du worker reste présent pour les anciens consommateurs pendant la migration ; ce changement ne constitue pas le retrait complet du moteur historique.

Validation : tests unitaires de conversation conservée, consentement navigateur, voix occupée et doublon ; Chromium sur le vrai panneau avec réponses API contrôlées, plus régression des évaluations natives. Les anciennes fixtures de `feature-flows.spec.js` qui attendent Gemini directement ne qualifient pas le parcours natif et restent à migrer. Ces tests ne prouvent pas la qualité réelle de l’accompagnement Studio ni le déploiement.
