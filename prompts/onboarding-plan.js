/**
 * Onboarding Plan — 6-step structured flow for new Limova users
 * Defines steps, descriptions (for Gemini), and completion criteria.
 */

const ONBOARDING_STEPS = [
  {
    id: 'decouverte-accueil',
    name: 'Découverte de l\'accueil',
    type: 'navigation',
    expectedUrls: ['/home', '/dashboard'],
    kbQueries: ['retrouver contenus campagnes agents'],
    description: `Explique à l'utilisateur le layout de la page d'accueil à partir du screenshot.
Montre-lui les sections principales :
- Le menu latéral : Contenu, Campagnes, Agents Autonomes, Super Pouvoirs, Documents, Intégrations
- Le dashboard central et ce qu'il affiche
- Comment la plateforme est organisée

Utilise {{HIGHLIGHT:id}} pour montrer visuellement chaque section clé.
Sois concis : présente 2-3 sections à la fois, pas tout d'un coup.`,
    completionHint: `Émets {{STEP_COMPLETE}} quand tu as expliqué les sections principales et que l'utilisateur confirme avoir compris (ex: "ok", "c'est clair", "d'accord") OU quand il navigue vers une autre page.`,
    status: 'active'
  },
  {
    id: 'integrations',
    name: 'Intégrations Email & Agenda',
    type: 'navigation',
    expectedUrls: ['/integrations'],
    kbQueries: ['connecter outils gmail outlook calendar', 'integration applications'],
    description: `Guide l'utilisateur vers la page Intégrations pour connecter son email et son agenda.

Étapes :
1. Demande quel email il utilise (Gmail ou Outlook)
2. Accompagne la connexion étape par étape (bouton connecter, autorisation OAuth)
3. Demande quel agenda il utilise (Google Calendar ou Outlook Calendar)
4. Accompagne la connexion de l'agenda

Les DEUX (email + agenda) doivent être connectés avant de passer à la suite.
Si l'utilisateur n'a qu'un seul outil, pas grave — connecte ce qu'il a.`,
    completionHint: `Émets {{STEP_COMPLETE}} quand l'email ET l'agenda sont connectés (visible dans le screenshot comme badges/statuts connectés), OU si l'utilisateur dit explicitement vouloir passer à la suite.`,
    status: 'pending'
  },
  {
    id: 'charly-plus-compte',
    name: 'Charly+ & Mon Compte',
    type: 'navigation',
    expectedUrls: ['/settings'],
    kbQueries: ['mon compte informations personnelles', 'creer charly whatsapp telephone'],
    description: `Demande à l'utilisateur s'il a le forfait Charly+ (Business+).

- Si OUI : guide-le vers Mon Compte (Paramètres) pour ajouter son numéro de téléphone. Ce numéro est nécessaire pour utiliser Charly+ via WhatsApp. Explique-lui qu'il pourra ensuite contacter Charly au +33 7 56 95 75 09 sur WhatsApp.
- Si NON : montre-lui brièvement la page Mon Compte (photo, infos perso, langue, fuseau horaire) et passe à la suite.

Ne force pas — si l'utilisateur ne sait pas ou ne veut pas, passe à l'étape suivante.`,
    completionHint: `Émets {{STEP_COMPLETE}} quand le numéro de téléphone est sauvé, OU que l'utilisateur confirme ne pas avoir Charly+, OU qu'il demande à passer à la suite.`,
    status: 'pending'
  },
  {
    id: 'documents-contexte',
    name: 'Documents & Contexte par défaut',
    type: 'navigation',
    expectedUrls: ['/documents'],
    kbQueries: ['ajoutez documents fichiers contexte defaut'],
    description: `Guide l'utilisateur vers la page Documents.

Explique :
1. La structure de dossiers — on peut organiser par projet, client, type
2. Comment uploader des fichiers (drag-drop ou bouton) — formats PDF, Word, Excel, TXT, PPT, jusqu'à 50 Mo
3. Le « contexte par défaut » : définir un dossier comme contexte par défaut = Charly et les agents auront accès à ces infos dans TOUTES les conversations

Suggestions de documents à uploader :
- Pitch deck / présentation de l'entreprise
- Descriptions de produits/services
- Guide de ton / charte éditoriale
- Infos clients ou projets récurrents

Montre comment définir un dossier comme contexte par défaut.`,
    completionHint: `Émets {{STEP_COMPLETE}} quand l'utilisateur a uploadé au moins un document OU défini un dossier de contexte, OU dit qu'il le fera plus tard.`,
    status: 'pending'
  },
  {
    id: 'guidelines-email-agenda',
    name: 'Guidelines Email & Agenda',
    type: 'conversational',
    expectedUrls: [],
    kbQueries: ['capacites gmail outlook calendar', 'ajoutez documents'],
    description: `Étape conversationnelle — pas de page spécifique requise.

Ton objectif : aider l'utilisateur à créer un document de « guidelines » qui définit comment Charly doit interagir avec ses emails et son agenda.

Pose ces questions une par une (pas toutes d'un coup) :

Pour les emails :
- « Comment veux-tu que je gère tes emails ? » (répondre, résumer, trier, flaguer les urgents ?)
- « Y a-t-il des types d'emails que je dois ignorer ou traiter en priorité ? »
- « Quel ton dois-je utiliser dans les réponses ? » (formel, décontracté, selon l'interlocuteur ?)

Pour l'agenda :
- « Comment veux-tu que je gère ton agenda ? » (proposer des créneaux, bloquer du focus time, rappels ?)
- « Y a-t-il des règles ? » (pas de réunion avant 10h, max 3 réunions/jour, etc.)

Une fois les réponses récoltées, compose un document de guidelines structuré en markdown.
Dis à l'utilisateur de le copier et de le sauver dans ses Documents comme contexte par défaut.`,
    completionHint: `Émets {{STEP_COMPLETE}} quand tu as formulé les guidelines et que l'utilisateur confirme les avoir comprises ou sauvées.`,
    status: 'pending'
  },
  {
    id: 'super-pouvoirs',
    name: 'Super Pouvoirs',
    type: 'conversational',
    expectedUrls: ['/super-powers', '/campaigns', '/agents'],
    kbQueries: ['decouvrez super pouvoirs'],
    description: `Présente les Super Pouvoirs disponibles (onglet dédié, pas dans le chat) :

- **John** (Marketing & Contenu) : posts réseaux sociaux, présentations pro, suppression fond image, transcription audio, génération vidéo
- **Lou** (SEO & Content Marketing) : audits SEO avec rapport PDF, articles de blog optimisés avec images IA
- **Elio** (Prospection LinkedIn) : campagnes LinkedIn automatisées, campagnes d'appels sortants
- **Tom** (Agent Téléphonique IA) : standard téléphonique, chatbot support client (site web/WhatsApp)

Demande à l'utilisateur lequel l'intéresse.

**Si l'utilisateur hésite** : pose des questions pour l'aider à choisir :
- « Quel est ton secteur d'activité ? »
- « Quel est ton objectif principal en ce moment ? » (visibilité, prospection, contenu, support client)
- « Tu as une équipe marketing ou tu gères seul ? »
Sur base des réponses, recommande le super pouvoir le plus pertinent.

Ensuite, accompagne-le étape par étape pour déclencher son premier super pouvoir via l'interface.`,
    completionHint: `Émets {{STEP_COMPLETE}} quand l'utilisateur a déclenché un super pouvoir, OU dit qu'il veut explorer par lui-même.`,
    status: 'pending'
  }
];

/**
 * Create a fresh onboarding plan
 * @returns {object} Plan with steps array and activeIndex
 */
export function createOnboardingPlan() {
  return {
    steps: ONBOARDING_STEPS.map(step => ({ ...step })),
    activeIndex: 0,
    startedAt: Date.now()
  };
}

/**
 * Advance to the next step
 * @param {object} plan - Current plan
 * @returns {object|null} Updated plan, or null if all steps are done
 */
export function advanceStep(plan) {
  const current = plan.steps[plan.activeIndex];
  if (current) current.status = 'completed';

  const nextIndex = plan.activeIndex + 1;
  if (nextIndex >= plan.steps.length) return null;

  plan.activeIndex = nextIndex;
  plan.steps[nextIndex].status = 'active';
  return plan;
}

export default { createOnboardingPlan, advanceStep };
