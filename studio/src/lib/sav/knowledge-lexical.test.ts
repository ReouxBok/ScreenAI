import { describe, expect, it } from "vitest";
import { savLexicalMatch, savLexicalRank, savLexicalTerms, SAV_LEXICAL_MAX_TERMS } from "./knowledge-lexical";

// Fictional cards with the titles of the production fiches the agent missed on 25/11 (bodies and symptoms are invented).
const CARDS = [
  { id: "prospection", title: "Lancer une campagne de prospection LinkedIn : rechercher les prospects puis personnaliser la séquence", body: "Choisissez les prospects puis envoyez la séquence de messages.", symptoms: ["Mes messages de prospection ne partent pas"] },
  { id: "connecter", title: "Connecter LinkedIn pour prospecter ou publier", body: "Ouvrez Intégrations puis LinkedIn.", symptoms: [] },
  { id: "limite", title: "Limite d'invitations LinkedIn : 20 par jour", body: "Au-delà de 20 invitations, l'envoi reprend le lendemain.", symptoms: [] },
  { id: "automatisation", title: "Créer une automatisation de création de post (V3)", body: "Planifiez la publication : choisissez le jour et l'heure pour programmer le post.", symptoms: [] },
  { id: "rediger", title: "Rédiger un post pour les réseaux sociaux (V3)", body: "Demandez à l'Assistant un texte de publication.", symptoms: [] },
  { id: "imap", title: "Connecter une boîte mail en IMAP (Nylas)", body: "Générez la clé de connexion sur la page Nylas.", symptoms: [] },
];
const rank = (query: string, minStrong = 0) => savLexicalRank(query, CARDS, card => card, { limit: 10, minStrong }).map(card => card.id);

describe("savLexicalTerms: accents, case and plurals folded, stop words dropped, bounded", () => {
  it("folds « Programmer des POSTS LinkedIn » to the same terms as « programmer post linkedin »", () => {
    expect(savLexicalTerms("Programmer des POSTS LinkedIn")).toEqual(["programmer", "post", "linkedin"]);
    expect(savLexicalTerms("Créer une séquence")).toEqual(["creer", "sequence"]);
    expect(savLexicalTerms("Envoi de messages")).toEqual(["envoi", "message"]);
    expect(savLexicalTerms("a b c")).toEqual([]);
    expect(savLexicalTerms(Array.from({ length: 80 }, (_, index) => `mot${index}`).join(" "))).toHaveLength(SAV_LEXICAL_MAX_TERMS);
  });
});

describe("savLexicalRank: any term, ranked by matched terms in title and symptoms, then body", () => {
  it("« LinkedIn programmer posts » (the brain's search of 25/11) finds the LinkedIn and post cards, never the IMAP one", () => {
    const found = rank("LinkedIn programmer posts");
    expect(found).toEqual(expect.arrayContaining(["prospection", "connecter", "limite", "automatisation", "rediger"]));
    expect(found).not.toContain("imap");
    // « programmer » is in the automation card's body only: it breaks the tie among the cards holding one title term.
    expect(found.indexOf("automatisation")).toBeLessThan(found.indexOf("rediger"));
  });
  it("« programmer posts LinkedIn » (MCP query of 25/11, word order changed) finds the same cards", () => {
    expect(new Set(rank("programmer posts LinkedIn"))).toEqual(new Set(rank("LinkedIn programmer posts")));
  });
  it("« LinkedIn envoi message erreur » finds the LinkedIn cards, the prospection card (messages in its symptoms) first", () => {
    const found = rank("LinkedIn envoi message erreur");
    expect(found[0]).toBe("prospection");
    expect(found).toEqual(expect.arrayContaining(["connecter", "limite"]));
    expect(found).not.toContain("imap");
  });
  it("« prospection LinkedIn envoi messages » ranks the prospection campaign first", () => {
    expect(rank("prospection LinkedIn envoi messages")[0]).toBe("prospection");
  });
  it("minStrong 1 keeps only the cards whose title or symptoms hold a term; the limit is kept", () => {
    expect(savLexicalMatch("programmer", CARDS[3]!)).toEqual({ strong: 0, total: 1 });
    expect(rank("programmer", 1)).toEqual([]);
    expect(savLexicalRank("LinkedIn", CARDS, card => card, { limit: 2 })).toHaveLength(2);
    expect(rank("")).toEqual([]);
  });
});
