import { describe, expect, it } from "vitest";
import { savLexicalMatch, savLexicalMinTerms, savLexicalRank, savLexicalTerms, SAV_LEXICAL_MAX_TERMS } from "./knowledge-lexical";

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
    // Short and very common words are never terms (review of e617a17f): « compte », « limova », politeness, articles.
    expect(savLexicalTerms("Bonjour, je n'arrive pas à connecter mon compte Limova, merci")).toEqual(["arrive", "connecter"]);
    expect(savLexicalTerms("Envoi des SMS par API")).toEqual(["envoi", "sms", "api"]);
    expect(savLexicalTerms(Array.from({ length: 80 }, (_, index) => `mot${index}`).join(" "))).toHaveLength(SAV_LEXICAL_MAX_TERMS);
  });
});

describe("savLexicalRank: any term, ranked by matched terms in title and symptoms, then body", () => {
  it("« LinkedIn programmer posts » (three terms): only a card holding two of them; one shared word is not enough (review of e617a17f)", () => {
    expect(rank("LinkedIn programmer posts")).toEqual(["automatisation"]);
    // Two terms: one suffices, every LinkedIn or post card, never the IMAP one.
    const found = rank("LinkedIn posts");
    expect(found).toEqual(expect.arrayContaining(["prospection", "connecter", "limite", "automatisation", "rediger"]));
    expect(found).not.toContain("imap");
  });
  it("« programmer posts LinkedIn » (MCP query of 25/11, word order changed) finds the same cards", () => {
    expect(rank("programmer posts LinkedIn")).toEqual(rank("LinkedIn programmer posts"));
  });
  it("« LinkedIn envoi message erreur »: the prospection card (LinkedIn, messages in its symptoms) first, the invitation limit (LinkedIn, envoi) next", () => {
    expect(rank("LinkedIn envoi message erreur")).toEqual(["prospection", "limite"]);
  });
  it("« prospection LinkedIn envoi messages » ranks the prospection campaign first", () => {
    expect(rank("prospection LinkedIn envoi messages")[0]).toBe("prospection");
  });
  it("the minimum number of terms: one up to two query terms, two from three on", () => {
    expect(savLexicalMinTerms(["linkedin"])).toBe(1);
    expect(savLexicalMinTerms(["linkedin", "post"])).toBe(1);
    expect(savLexicalMinTerms(["linkedin", "post", "programmer"])).toBe(2);
    expect(rank("Je n'arrive pas à connecter mon compte depuis hier")).toEqual([]);
  });
  it("minStrong 1 keeps only the cards whose title or symptoms hold a term; the limit is kept", () => {
    expect(savLexicalMatch("programmer", CARDS[3]!)).toEqual({ strong: 0, total: 1 });
    expect(rank("programmer", 1)).toEqual([]);
    expect(savLexicalRank("LinkedIn", CARDS, card => card, { limit: 2 })).toHaveLength(2);
    expect(rank("")).toEqual([]);
  });
});
