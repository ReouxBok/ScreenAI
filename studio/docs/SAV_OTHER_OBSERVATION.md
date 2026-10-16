# SAV — Autre, phase d'observation

`view=other` est une vue supplémentaire du **dernier entrant de chaque fil**.
Elle ne modifie aucune décision, aucun état de dossier ni aucune vue existante.
Les compteurs se recoupent volontairement : Autre n'est pas un cinquième état
métier. Recherche, tri et pagination utilisent le même snapshot que les autres
vues. Les exclusions techniques existantes restent inchangées.

## Configuration privée

Le serveur lit `SAV_OTHER_OBSERVATION_RULES_JSON`. Sans valeur, ou si celle-ci
est invalide, aucun candidat n'est affiché ; l'interface explique l'indisponibilité.
Ne pas employer de variable `NEXT_PUBLIC_`, journaliser la valeur ni committer
des objets de campagne, exemples clients ou exports de messages.

Format (les valeurs ci-dessous sont des placeholders non chargeables) :

```json
{
  "version": 1,
  "rules": [{
    "family": "trustpilot_positive",
    "mailboxId": "UUID_DE_LA_BOITE_AUTORISEE",
    "subjectSha256": ["SHA256_HEXADECIMAL_DE_L_OBJET_EXACT"]
  }]
}
```

Les quatre familles autorisées sont `trustpilot_positive`,
`vistaprint_promotions`, `datarevolution_prospecting`, `own_campaign_copy`.
Leurs adresses exactes sont bornées dans le module serveur : la configuration
ne permet ni nouvel expéditeur ni domaine générique. Une seule définition par
famille et boîte ; toute ambiguïté désactive le repérage concerné. L'objet est
comparé par SHA-256 après remplacement CRLF/CR par LF, sans autre normalisation.
Un nouvel objet ne correspond pas automatiquement à un ancien modèle.

Une configuration d'observation issue des objets vus sur une période **ne
certifie pas les corps ni l'authenticité**. Elle doit être conservée en privé,
revue et provisionnée séparément sur la cible souhaitée. Cette livraison ne
charge aucune configuration distante et n'ajoute aucun chemin de tri automatique.

## Priorité au support

Refus de repérage si : source non Gmail, corps/en-têtes absents ou invalides,
corps à la limite de troncature, collision de casse de nom d'en-tête dans le dictionnaire stocké, réponse/références,
transfert détectable ou pièce jointe ; correspondance sortante/autre expéditeur
dans le fil ; pause/demande humaine/revue/action/historique d'apprentissage ;
ticket lié ou trouvé dans le contexte ; intention client identifiée ou urgence
haute/critique. Certains termes sensibles sont des **veto**, jamais une preuve
de bruit. Les variantes non reconnues restent possibles : ces contrôles ne
constituent pas une garantie de détection de toute demande humaine.

L'ingestion actuelle conserve le premier exemplaire de certains en-têtes bruts,
puis construit un dictionnaire unique. Le contrôle des collisions dans ce
dictionnaire ne détecte donc pas les doublons RFC déjà perdus à l'ingestion.
Les corps MIME peuvent aussi avoir été réduits au snippet à la réception : une
longueur inférieure au plafond ne prouve pas leur complétude. Ces limites
interdisent d'utiliser cette observation comme autorisation de classement.

Dans Autre, le lien dossier n'appelle pas l'action de classement Gmail ni le
rafraîchissement CRM de la ligne habituelle. Le détail conserve son journal de
consultation après ouverture ; le lien ne précharge pas le dossier.

Un objet Trustpilot doit aussi mentionner explicitement cinq étoiles. Ni
`no_ticket_needed`, ni `no-reply`, ni un score IA n'autorisent le classement.
Le moteur retourne seulement un candidat à examiner, jamais une permission de
retirer le fil du support. Un nouveau dernier message est réévalué indépendamment.

## Avant un futur classement effectif

Il reste à qualifier les modèles sur les corps complets et les preuves fiables
d'authentification à la réception (elles ne sont pas conservées aujourd'hui),
implémenter une décision réversible et un override humain durable, puis vérifier
les contre-exemples et le parcours. Aucun de ces travaux n'est implicitement
autorisé par un simple chargement de cette configuration d'observation.
Pas de déplacement Gmail, action HubSpot, replay, changement de permissions,
migration, appel modèle ou arrêt d'analyse ajouté par cette fonctionnalité.

Repli : retirer la configuration désactive le repérage, ou revenir au code
précédent ; aucune donnée de classification n'a été écrite ou à restaurer.
