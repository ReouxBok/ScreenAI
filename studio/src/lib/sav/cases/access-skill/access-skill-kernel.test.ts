import { describe, expect, it } from "vitest";
import { accessSkillContextHits, accessSkillKernelHits, normalizeAccessSkillText, SAV_ACCESS_SKILL_KERNEL } from "./access-skill-kernel";

// SAV-97: the exclude-only kernel. Every text is fictional.
const CAPCAR = "J'ai fait le mandat de prélèvement pour un forfait Business Plus mais quand je veux me connecter on me demande de choisir un abonnement. Pourquoi ?";

describe("noyau d'exclusion : phrases, jamais un mot seul", () => {
  it.each([
    ["Je souhaite résilier mon abonnement.", "resilier"],
    ["RÉSILIATION immédiate svp", "resilier"],
    ["je veux resillier", "resilier"],
    ["Merci de me désabonner", "desabonner"],
    ["désabonnement de la newsletter et du service", "desabonner"],
    ["je demande à être remboursé", "rembourser"],
    ["Remboursement de la facture d'octobre", "rembourser"],
    ["un rembourssement svp", "rembourser"],
    ["Pouvez-vous supprimer mon compte ?", "supprimer_compte"],
    ["supprimer le compte de la société", "supprimer_compte"],
    ["Merci de procéder à la suppression de mon compte", "supprimer_compte"],
    ["fermer notre compte au 30", "fermer_compte"],
    ["la fermeture de mon compte", "fermer_compte"],
    ["Je veux annuler mon abonnement", "arreter_abonnement"],
    ["arrêter l'abonnement dès maintenant", "arreter_abonnement"],
    ["supprimer notre abonnement", "arreter_abonnement"],
    ["mettre fin à mon abonnement", "arreter_abonnement"],
    ["annulation de l'abonnement", "arreter_abonnement"],
    ["Demande RGPD", "rgpd"],
    ["la suppression de mes données", "rgpd"],
    ["je vais faire opposition auprès de ma banque", "opposition_bancaire"],
    ["opposition au prélèvement", "opposition_bancaire"],
    ["un litige bancaire est ouvert", "opposition_bancaire"],
    ["Please cancel my subscription", "en_cancel"],
    ["I want to unsubscribe", "en_cancel"],
    ["delete my account please", "en_cancel"],
    ["I need a refund", "en_refund"],
  ])("« %s » → %s", (text, id) => {
    expect(accessSkillKernelHits(text)).toContain(id);
  });

  it.each([
    "Comment supprimer un fichier importé ?",
    "La fenêtre ne se ferme pas quand je clique sur fermer la fenêtre",
    "Je veux supprimer un agent",
    "supprimer",
    "fermer",
    "annuler le rendez-vous de demain",
    "annuler ma dernière modification",
    "j'ai fermé l'onglet et je n'arrive plus à me connecter",
    "Comment fermer une conversation ?",
    "supprimer un contact de mon compte",
    CAPCAR,
    "J'ai payé par carte et à la connexion on me propose des formules.",
    "Merci pour la facture, mais le code de connexion n'arrive pas.",
    "mon abonnement est actif mais je ne peux pas me connecter",
    "Le compte rendu de la réunion est en pièce jointe",
    "",
  ])("« %s » ne déclenche pas", text => {
    expect(accessSkillKernelHits(text)).toEqual([]);
  });

  it("normalise accents, casse, apostrophes et lettres doublées, sans juger la formulation", () => {
    expect(normalizeAccessSkillText("  RÉSILIER   l’Abonnement ")).toBe("resilier l'abonement");
    expect(accessSkillKernelHits("ANNULER L’ABONNEMENT")).toEqual(["arreter_abonnement"]);
    expect(accessSkillKernelHits("Supprimer Mon Compte")).toEqual(["supprimer_compte"]);
  });

  it("lit chaque texte fourni (objet, corps, mail d'origine) et ne rend que des identifiants fermés", () => {
    expect(accessSkillKernelHits("Connexion", "je n'arrive pas à me connecter", "PS : je veux résilier")).toEqual(["resilier"]);
    expect(accessSkillKernelHits(null, undefined, "rien")).toEqual([]);
    for (const phrase of SAV_ACCESS_SKILL_KERNEL) expect(phrase.id).toMatch(/^[a-z_]+$/);
  });
});

describe("mots de contexte : ils demandent la contre-lecture, ils ne décident jamais", () => {
  it("capcar touche le contexte (prélèvement, forfait, abonnement) mais pas le noyau", () => {
    expect(accessSkillKernelHits(CAPCAR)).toEqual([]);
    expect(accessSkillContextHits(CAPCAR)).toEqual(expect.arrayContaining(["sensitive_finance", "sensitive_subscription"]));
  });
  it.each(["facture", "J'ai payé hier", "mon forfait", "renouvellement", "I paid for the plan", "subscription"])("« %s » demande la contre-lecture", text => {
    expect(accessSkillContextHits(text).length).toBeGreaterThan(0);
  });
  it("un mail de connexion sans argent ni abonnement ne la demande pas", () => {
    expect(accessSkillContextHits("Bonjour, je ne reçois pas le code de connexion depuis ce matin. Merci")).toEqual([]);
  });
});
