import { describe, expect, it } from "vitest";
import { splitSavMessageText } from "../message-context";
import { loginCustomerStatement, reportsOngoingLoginFailure, reportsRestoredAccess } from "./restored-access";
import { caseReturnContentRule, firstPersonalLoginRequest } from "./investigation-return-qualify";
import type { CaseRequestFamily } from "./case-types";

const rule = caseReturnContentRule({ ruleId: "local-access", revision: "1" }, () => new Date("2026-11-05T10:00:00Z"));
const families = async (text: string, family: CaseRequestFamily = "access", changedSubject?: string) =>
  (await rule({ caseId: "case", messageId: "return", text, changedSubject, requests: [{ requestId: "r1", family }] })).map(row => row.family);

describe("qualification du nouveau mail sur un dossier accès", () => {
  it.each([
    "Je n’arrive toujours pas à avoir le code de connexion.",
    "Toujours pas le code, même après avoir vérifié mes spams.",
    "Comment avoir le code de connexion ?",
    "Je ne reçois pas le code sur mon adresse personne@example.invalid.",
    "J’ai vérifié mes spams sur Gmail, toujours rien.",
    "Toujours rien.",
    "Merci, mais ça ne fonctionne toujours pas.",
    "Merci de votre retour, je n’ai toujours rien reçu.",
    "Merci, ça remarche.",
    "Merci, ça remarche depuis l’autre navigateur !",
    "Ça fonctionne à nouveau. Merci beaucoup !",
    "Bonjour, nous avons récupéré notre historique et l’usage de Limova. Merci !",
    "Je peux de nouveau utiliser Limova.",
    "Je peux de nouveau utiliser Limova.\nBien à vous,\nEnvoyé à partir de Outlook pour Android<https://aka.ms/example>\n> Ancien problème.",
  ])("autorise une nouvelle investigation accès : %s", async text => {
    expect(await families(text)).toEqual(["access"]);
  });

  it.each([
    ["Je demande un avoir.", "finance"],
    ["Dois-je payer pour avoir le code de connexion ?", "finance"],
    ["Toujours pas le code, je demande deux avoirs.", "finance"],
    ["Toujours pas de code. Je voudrais un avoir sur la facture.", "finance"],
    ["Je voudrais avoir le code de connexion et un avoir.", "finance"],
    ["Merci, ça remarche.\nCordialement,\nRemboursement de ma facture.", "finance"],
    ["Toujours bloqué pour connecter Gmail et je souhaite résilier.", "cancellation"],
  ])("donne priorité à la demande sensible : %s", async (text, family) => {
    expect(await families(text)).toEqual([family]);
  });

  it.each([
    "Toujours bloqué pour connecter Gmail à mon agent.",
    "J’ai vérifié dans mes spams Gmail, mais maintenant je veux connecter Outlook à mon agent.",
    "Toujours bloqué pour inviter un collaborateur.",
    "Je suis toujours bloqué pour exporter mes contacts.",
    "Merci pour la transmission à votre équipe.",
    "Je peux de nouveau utiliser Limova.\n--\nEnvoyé depuis Outlook pour iOS\nMais les exports restent bloqués.",
    "Merci, mais ça ne fonctionne toujours pas et je veux exporter mes fichiers.",
    "Merci !",
    "Merci, ça remarche ?",
    "Peut-être que ça remarche.",
    "Vous m’avez dit « ça remarche ».",
    "Merci, ça remarche mais j’ai un autre souci.",
    "Merci, ça remarche depuis l’autre navigateur mais je ne peux plus exporter mon fichier.",
    "Merci.\n> Ça remarche.",
  ])("ne reprend pas la famille accès du dossier : %s", async text => {
    expect(await families(text)).toEqual([]);
  });

  it("lit le message avant les en-têtes Outlook et conserve toute contradiction avant ces en-têtes", async () => {
    const body = "Bonjour\nMerci nous avons retrouvé l’usage de Limova";
    const footer = "\nBien à vous\nEnvoyé depuis Outlook pour Android<https://aka.ms/example>";
    const divider = "\n________________";
    const history = "\nDe : Support synthétique\nEnvoyé : hier\nObjet : Re: Connexion\nAncien message.";
    expect(await families(body + footer + divider + history)).toEqual(["access"]);
    expect(await families(body + footer + divider + "\nMais toujours bloqué." + history)).toEqual([]);
    expect(await families(body + "\nMais toujours bloqué." + footer + divider + history)).toEqual([]);
  });

  it("le sujet modifié peut signaler un besoin financier ou hors pilote, même avec un corps très court", async () => {
    expect(await families("Toujours rien.", "access", "Re: Remboursement demandé")).toEqual(["finance"]);
    expect(await families("Toujours rien.", "access", "Connexion de mon calendrier à mon agent")).toEqual([]);
    expect(await families("Merci.", "access", "Code de connexion")).toEqual([]);
  });

  it("une confirmation courte ne change pas la famille d'une autre demande", async () => {
    expect(await families("Merci, ça remarche.", "technical")).toEqual([]);
  });
});


describe("erreur lors de la connexion personnelle et retour d’usage", () => {
  it.each([
    ["Pendant ma connexion une erreur 403 apparaît. J’ai déjà mon compte.", true],
    ["Lors de ma connexion un code d’erreur apparaît. Je souhaite créer un compte.", false],
    ["Pendant ma connexion à Gmail une erreur apparaît. J’ai déjà un compte.", false],
    ["Pendant ma connexion Internet une erreur apparaît. J’ai déjà un compte.", false],
    ["J’ai un compte, le dossier d’export affiche une erreur.", false],
    ["Pendant ma connexion une erreur apparaît. J’ai un compte. Je conteste ma facture.", false],
  ])("admission sur les mots du client : %s", (text, expected) => {
    expect(firstPersonalLoginRequest(text, "")).toBe(expected);
  });

  it.each([
    "J’ai retrouvé mon historique.",
    "Je n’ai pas retrouvé l’usage de Limova.",
    "Nous avons retrouvé l’usage de Limova, mais je reste bloqué.",
    "Je peux de nouveau utiliser Limova ?",
    "J’espère que je peux de nouveau utiliser Limova.",
    "On me dit « je peux de nouveau utiliser Limova ».",
    "Merci de m’aider à retrouver l’usage de Limova.",
  ])("aucune preuve positive de rétablissement : %s", async text => {
    expect(reportsRestoredAccess(text)).toBe(false);
    expect(await families(text)).toEqual([]);
  });
});

// Review F3 (7/11): a return is `access` only when EVERY part of the customer's own words is accounted for by the login trouble. One login phrase anywhere no
// longer carries the rest of the mail: a second request, financial or not, with or without a listed word, leaves the case to the team.
describe("F3 — une demande mixte n'est jamais réduite à l'accès sur un fragment", () => {
  it.each([
    ["F15", "Toujours pas de code. Je veux qu’on me rende mon argent."],
    ["F06", "Toujours pas de code, pourtant on paie chaque mois."],
    ["F08", "Toujours pas de code. Combien coûte l’offre au-dessus ?"],
    ["M06", "Je n’arrive pas à me connecter. Ah et aussi, je veux le RIB de Limova."],
    ["M02", "Toujours pas de code. Et mon agent ne répond plus aux appels depuis hier."],
    ["M03", "Je n’arrive pas à me connecter. Pouvez-vous aussi changer le prompt de mon agent ?"],
    ["M04", "Je n’arrive pas à me connecter, rappelez-moi au 06 12 34 56 78 svp."],
    // Paraphrases with none of the reviewer's words.
    ["argent récupéré", "Toujours rien, et j’aimerais récupérer les sommes versées."],
    ["coordonnées bancaires", "Toujours pas de code. Envoyez-moi vos coordonnées bancaires."],
    ["coût mensuel", "Je n’arrive toujours pas à me connecter ; au passage, ça me revient à combien par mois ?"],
    ["départ", "Toujours pas de code, d’ailleurs je compte partir chez un concurrent."],
    ["autre panne", "Toujours rien. Mes mails automatiques ne partent plus non plus."],
    ["question produit", "Toujours pas de code. Comment créer une nouvelle routine ?"],
    ["engagement", "Toujours pas de code, alors que je suis engagé pour un an."],
    ["contradiction", "Ça marche maintenant. Ah non, ça replante."],
    ["contradiction inverse", "Toujours pas de code. Ah si, c’est bon, j’ai pu me connecter."],
  ])("%s : pas une suite d'accès", async (_id, text) => {
    expect(await families(text)).not.toEqual(["access"]);
  });

  it.each([
    "Toujours pas de code, j’ai pourtant essayé sur Chrome et sur Firefox.",
    "Je n’arrive toujours pas à me connecter. Pouvez-vous m’aider ?",
    "Toujours rien, c’est urgent, je ne peux pas travailler.",
    "J’utilise bien le lien new.limova.ai et mon adresse habituelle, toujours aucun code.",
    "Je n’ai toujours pas reçu le code, merci d’avance.",
    "Bonjour, toujours rien malgré mes spams vérifiés.",
    "Je n’arrive pas à me connecter et je ne reçois pas le code.",
    "Toujours bloqué depuis ce matin, sur mon ordinateur comme sur mon téléphone.",
    "Bonjour,\nJ’ai réessayé plusieurs fois, toujours pas de code.\nMerci pour votre aide.",
    "Ci-joint une capture d’écran. Je ne reçois toujours pas le code.",
    "Je voudrais juste me connecter à mon compte, le code n’arrive pas.",
    "J’ai suivi toutes les étapes, mais je ne reçois toujours pas le code.",
    "J’ai bien appliqué votre procédure, toujours rien.",
    "Je n’arrive toujours pas à avoir le code.",
  ])("témoin accès non financier, reste à l'agent : %s", async text => {
    expect(await families(text)).toEqual(["access"]);
  });
});

// Review F4 (7/11): a recognised closing block (courtesy, name, role, phone, address, mail client footer) does not hide the statement above it. Any line in
// or after that block that is not a signature line keeps the whole text, so a request written after a sign-off is still read and still stops the case.
describe("F4 — une signature conserve le sens, sans avaler une vraie demande", () => {
  const SIGNED: Array<[string, string, "restored" | "ongoing" | "access"]> = [
    ["R02", "Ça marche, merci !\n\nJean Dupont", "restored"],
    ["R03", "Ça marche, merci !\n\nCordialement,\nJean Dupont", "restored"],
    ["R04", "Ça marche, merci !\n\nCordialement,\nJean Dupont\nGérant – Boulangerie Dupont\n06 12 34 56 78", "restored"],
    ["R05", "Merci, ça remarche.\n--\nJean Dupont", "restored"],
    ["R06", "Bonjour,\n\nC’est bon, j’ai pu me connecter. Merci !\n\nJean", "restored"],
    ["R07", "Merci, mais ça ne fonctionne toujours pas.\n\nCordialement,\nJean Dupont", "ongoing"],
    ["R08", "Toujours rien.\n\nJean Dupont", "access"],
    ["paraphrase site", "Super, j’ai pu me reconnecter, merci !\n\nBien cordialement\nMarie Martin\nCabinet Martin\nwww.cabinet-martin.example", "restored"],
    ["mobile", "C’est bon ça fonctionne\n\nEnvoyé de mon iPhone", "restored"],
    ["initiale", "Toujours pas de code\n--\nP. Durand\n01 23 45 67 89", "access"],
    ["adresse postale", "Ça fonctionne à nouveau.\n\nCordialement,\nMarie-Claire de La Tour\n12 rue des Lilas\n75011 Paris", "restored"],
  ];
  it.each(SIGNED)("%s : signé, même sens que sans signature", async (_id, text, meaning) => {
    expect(await families(text)).toEqual(["access"]);
    const statement = loginCustomerStatement(splitSavMessageText(text));
    expect(reportsRestoredAccess(statement)).toBe(meaning === "restored");
    expect(reportsOngoingLoginFailure(statement)).toBe(meaning === "ongoing");
  });

  it.each([
    ["nouvelle phrase sous le nom", "Ça marche, merci !\n\nJean Dupont\nPar contre l’export de mes fichiers est bloqué.", []],
    ["PS financier", "Ça marche, merci !\nCordialement,\nJean\nPS : pouvez-vous m’envoyer la facture ?", ["finance"]],
    ["résiliation après le rôle", "Ça marche.\n\nJean Dupont\nGérant\nJe veux résilier.", ["cancellation"]],
    ["rôle facturation (témoin du reviewer)", "Toujours rien.\n\nCordialement,\nJean Dupont\nService facturation", ["finance"]],
    ["mot seul sans séparation", "Ça marche\nNon", []],
    ["mot de négation après un point", "Ça marche.\nNon", []],
    ["question sous la signature", "Ça marche, merci !\n\nJean Dupont\nEt pour le téléphone ?", []],
  ])("%s : la demande reste lue", async (_id, text, expected) => {
    expect(await families(text)).toEqual(expected);
    expect(reportsRestoredAccess(loginCustomerStatement(splitSavMessageText(text)))).toBe(false);
  });
});

// Review F5 (7/11): another person's account (colleague, customer, employee…) is not the customer's own access, on a first mail or on a return.
describe("F5 — le compte d'un tiers n'est pas un accès personnel", () => {
  it.each([
    "Je n’arrive pas à me connecter au compte de mon collègue.",
    "Ma salariée n’arrive pas à se connecter.",
    "Mon client ne reçoit pas le code de connexion.",
    "Je voudrais me connecter au compte de mon associé.",
    "Pouvez-vous aider mon employé à accéder à son espace ?",
    "Je n’arrive pas à me connecter pour ma cliente.",
    "Bonjour, je n’arrive plus à me connecter, je ne reçois pas le code. Mon collègue a le même souci.",
    "Une autre personne de l’entreprise ne reçoit pas le code de connexion.",
  ])("premier mail non admis : %s", text => {
    expect(firstPersonalLoginRequest(text, "Connexion")).toBe(false);
  });

  it.each([
    ["E01", "Bonjour, je n’arrive pas à me connecter à mon compte Limova, je ne reçois pas le code."],
    ["E07", "Erreur lors de ma connexion à Limova. J’ai déjà un compte."],
    ["signé", "Bonjour, je ne reçois pas le code de connexion.\n\nCordialement,\nJeanne Martin\nAssistante de direction"],
    ["cliente", "Je suis cliente depuis deux mois et je n’arrive plus à me connecter à mon compte."],
    ["espace client", "Je n’arrive pas à accéder à mon espace client, le code n’arrive pas."],
  ])("premier mail personnel admis : %s", (_id, text) => {
    expect(firstPersonalLoginRequest(text, "Connexion")).toBe(true);
  });

  it.each([
    ["mixte RIB", "Je n’arrive pas à me connecter. Ah et aussi, je veux le RIB de Limova."],
    ["mixte rappel", "Je n’arrive pas à me connecter, rappelez-moi au 06 12 34 56 78 svp."],
  ])("premier mail mixte non admis : %s", (_id, text) => {
    expect(firstPersonalLoginRequest(text, "Connexion")).toBe(false);
  });

  it("un retour sur le compte d'un tiers ne reprend pas la famille accès", async () => {
    expect(await families("Mon collègue n’arrive toujours pas à se connecter.")).toEqual([]);
    expect(await families("Toujours pas de code pour ma salariée.")).toEqual([]);
  });
});
