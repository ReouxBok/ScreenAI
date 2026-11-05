import { describe, expect, it } from "vitest";
import { reportsRestoredAccess } from "./restored-access";
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
