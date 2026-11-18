import { describe, expect, it } from "vitest";
import { layoutCaseReplyBody } from "./case-reply-layout";
import { caseReplyEditableBody, caseReplyFinalTextProblem, finalizeCaseReplyProposal, prepareCaseReplyText, readCaseReplyDisclosure } from "./case-reply-outbound";
import { J2_REMINDER_TEXT } from "./j2-auto-reminder";
import type { CaseReplyProposal } from "./case-effects";

/* SAV-94: plain-text layout of V2 replies. Fictitious data only. */

/** The words, in order, with only what the layout may remove or rewrite normalised: Markdown markers, "#" headings and "1)" -> "1.". */
const words = (text: string) => text.split(/\s+/).filter(Boolean)
  .filter(token => !/^#{1,6}$/.test(token))
  .map(token => token.replace(/\*\*|__/g, "").replace(/^(\d{1,2})\)$/, "$1."))
  .filter(Boolean);

const VALIDATED = "Bonjour Madame Martin,\n\nMerci pour votre message. Je comprends que vous n'arrivez plus à vous connecter à votre espace Limova depuis ce matin.\n\n"
  + "Pour rétablir l'accès, voici les étapes à suivre :\n\n1. Rendez-vous sur la page de connexion de Limova.\n\n2. Cliquez sur « Mot de passe oublié ».\n\n"
  + "3. Ouvrez le mail reçu et choisissez un nouveau mot de passe.\n\nSi le problème continue après ces étapes, répondez simplement à ce message en précisant ce qui s'affiche.\n\nBelle journée,";

describe("layoutCaseReplyBody (SAV-94)", () => {
  it("keeps the validated example exactly as it is", () => {
    expect(layoutCaseReplyBody(VALIDATED)).toBe(VALIDATED);
  });

  it("lays out a compact list: blank line before the list and between steps, \"1)\" becomes \"1.\"", () => {
    const compact = "Bonjour Madame Martin,\nMerci pour votre message. Je comprends que vous n'arrivez plus à vous connecter à votre espace Limova depuis ce matin.\n\n"
      + "Pour rétablir l'accès, voici les étapes à suivre :\n1) Rendez-vous sur la page de connexion de Limova.\n2) Cliquez sur « Mot de passe oublié ».\n"
      + "3) Ouvrez le mail reçu et choisissez un nouveau mot de passe.\n\n\n\nSi le problème continue après ces étapes, répondez simplement à ce message en précisant ce qui s'affiche.   \n\nBelle journée,";
    const out = layoutCaseReplyBody(compact);
    expect(out).toContain("voici les étapes à suivre :\n\n1. Rendez-vous sur la page de connexion de Limova.\n\n2. Cliquez sur « Mot de passe oublié ».\n\n3. Ouvrez");
    expect(out).not.toMatch(/\n{3,}|[ \t]\n/);
    expect(words(out)).toEqual(words(compact));
    // The greeting line keeps its single line break: the layout never guesses a paragraph that is not a step.
    expect(out.startsWith("Bonjour Madame Martin,\nMerci")).toBe(true);
  });

  it("normalises Windows line breaks and trailing spaces", () => {
    expect(layoutCaseReplyBody("Bonjour,  \r\n\r\n\r\nMerci.\r\n1. Un.\r\n2. Deux. \r\n")).toBe("Bonjour,\n\nMerci.\n\n1. Un.\n\n2. Deux.");
  });

  it("strips Markdown bold markers and headings, keeping the words", () => {
    const md = "## Votre accès\n\nCliquez sur **Mot de passe oublié** puis sur __Valider__.\n\n**Important** : gardez ce code pour vous.";
    const out = layoutCaseReplyBody(md);
    expect(out).toBe("Votre accès\n\nCliquez sur Mot de passe oublié puis sur Valider.\n\nImportant : gardez ce code pour vous.");
    expect(words(out)).toEqual(words(md));
  });

  it("never touches links, addresses or codes with * or _ inside", () => {
    const text = "Bonjour,\n\nOuvrez https://app.example.test/reset?token=**abc**&mode=__x__ puis écrivez à support_team__x__@example.test.\n\n"
      + "Votre référence est AB**12**CD et le motif 5 * 3 reste tel quel. Le fichier __init__.py aussi : www.example.test/__a__/**b**.";
    const out = layoutCaseReplyBody(text);
    expect(out).toBe(text);
  });

  it("leaves a bold link as is rather than guessing (unsure = unchanged)", () => {
    const text = "Rendez-vous sur **https://app.example.test/login** pour vous connecter.";
    expect(layoutCaseReplyBody(text)).toBe(text);
  });

  it("never splits a sentence nor a number that is not a step", () => {
    const text = "Bonjour,\n\nLe forfait 2. version coûte 12.50 euros, version 1.2 incluse. Étape 1. : ouvrez la page.";
    expect(layoutCaseReplyBody(text)).toBe(text);
  });

  it("is idempotent and only changes whitespace and markers", () => {
    const samples = [VALIDATED, "1) a\n2) b\n3) c", "Texte\n# Titre\n**gras** et ****quatre**** et ***trois***\n1. x\nsuite de x\n2) y",
      "  \n\nBonjour,\n\n\n\n\nMerci  \n", "Lien https://a.example.test/*x*/_y_ fin.", "__a__ __b__ **c** **d**"];
    for (const sample of samples) {
      const once = layoutCaseReplyBody(sample);
      expect(layoutCaseReplyBody(once)).toBe(once);
      expect(words(once)).toEqual(words(sample));
    }
  });
});

describe("V2 preparation with the layout (SAV-94)", () => {
  const draft = (text: string, purpose: CaseReplyProposal["purpose"] = "answer") =>
    ({ caseId: "case-1", triggerEventId: "inbound:fictive-1", purpose, text } as unknown as Omit<CaseReplyProposal, "text"> & { text: string });

  it("finalizeCaseReplyProposal produces a laid-out text that still passes caseReplyFinalTextProblem", () => {
    const raw = "Bonjour Madame Martin,\n\nPour rétablir l'accès, voici les étapes à suivre :\n1) Rendez-vous sur la page de connexion.\n2) Cliquez sur **Mot de passe oublié**.";
    for (const validation of ["human", "automated"] as const) {
      const proposal = finalizeCaseReplyProposal(draft(raw), { language: "fr", validation });
      expect(proposal.text).toContain("voici les étapes à suivre :\n\n1. Rendez-vous sur la page de connexion.\n\n2. Cliquez sur Mot de passe oublié.");
      expect(caseReplyFinalTextProblem(proposal.text, validation === "automated" ? "automated" : "manual_reviewed")).toBeNull();
      expect(readCaseReplyDisclosure(proposal.text)?.language).toBe("fr");
      // Idempotent: preparing the stored text again gives the same text, hence the same hash.
      expect(finalizeCaseReplyProposal({ ...proposal }, { language: "fr", validation }).text).toBe(proposal.text);
    }
  });

  it("the Studio editor body round-trips: editing the shown body without change prepares the same text", () => {
    const proposal = finalizeCaseReplyProposal(draft("Bonjour,\n\nVoici les étapes à suivre :\n1. Un.\n2. Deux."), { language: "fr", validation: "human" });
    const editable = caseReplyEditableBody(proposal.text);
    expect(editable).toBe("Bonjour,\n\nVoici les étapes à suivre :\n\n1. Un.\n\n2. Deux.");
    expect(finalizeCaseReplyProposal(draft(editable), { language: "fr", validation: "human" }).text).toBe(proposal.text);
  });

  it("a text stored before the layout is still read as it was (provenance and J2 use layout: false)", () => {
    const old = prepareCaseReplyText("Bonjour,\n\nVoici :\n1. Un.\n2. Deux.", "fr", "manual_reviewed", "answer", { layout: false });
    expect(old).toContain("Voici :\n1. Un.\n2. Deux.");
    expect(caseReplyFinalTextProblem(old)).toBeNull();
    expect(caseReplyEditableBody(old, { layout: false })).toBe("Bonjour,\n\nVoici :\n1. Un.\n2. Deux.");
  });

  it("the fixed J2 reminder is unchanged byte for byte", () => {
    const body = "Bonjour,\n\nNous revenons vers vous au sujet de notre précédent message. Avez-vous pu consulter notre demande ou essayer la procédure proposée ? Vous pouvez nous répondre dans ce fil pour poursuivre votre accompagnement.";
    expect(J2_REMINDER_TEXT).toBe(prepareCaseReplyText(body, "fr", "automated", "reminder", { layout: false }));
  });
});
