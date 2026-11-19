import { describe, expect, it } from "vitest";
import { smartDecisionSchema, smartReadingSchema, type SmartDecision } from "./smart-contract";
import { renderSmartTeamNote, smartFallbackNote, smartSensitiveNote } from "./smart-handoff-note";
import {
  smartEmptyMemory, smartMaxExchanges, smartMemoryForModel, smartMemoryFromThread, smartMergeMemory, smartNoProgressTwice, smartProgressGate, smartRepeatCodes, type SmartCaseMemory,
} from "./smart-memory";
import { smartGoodDecision, smartReading } from "./smart-test-doubles";

/*
 * HARNAIS 2 and 4 (20/11): the case memory, the progress rule and the structured handoff note. Pure, fictional data only.
 */
const reading = smartReadingSchema.parse(smartReading());
const decision = (extra: Record<string, unknown> = {}) => smartDecisionSchema.parse(smartGoodDecision(extra)) as SmartDecision;
const merge = (memory: SmartCaseMemory, update: Record<string, unknown>, latest: string, recordOwn = true, extra: Record<string, unknown> = {}) =>
  smartMergeMemory({ memory, decision: decision({ memory: update, ...extra }), reading, latestCustomerText: latest, recordOwn });

describe("mémoire : le serveur compte, pas le modèle", () => {
  it("1er échange : toujours un progrès ; la question et l'essai proposés sont retenus quand la réponse est réellement envoyée", () => {
    const first = merge(smartEmptyMemory(), { trials: [{ id: "e1", needId: "n1", what: "Reconnecter la boîte Gmail", cardId: "fiche-connexion" }], question: "Quel message s'affiche ?" }, "Bonjour, mes mails n'arrivent plus.");
    expect(first.progressed).toBe(true);
    expect(first.memory.exchanges).toBe(1);
    expect(first.memory.trials).toMatchObject([{ id: "e1", result: "pending", turn: 1 }]);
    expect(first.memory.questions).toMatchObject([{ text: "Quel message s'affiche ?", answered: false }]);
    expect(first.memory.facts.map(row => row.from)).toEqual(["fiche"]);
  });
  it("mode fantôme (rien d'envoyé) : ni question ni essai retenus", () => {
    const shadow = merge(smartEmptyMemory(), { trials: [{ id: "e1", needId: "n1", what: "Reconnecter" }], question: "Quel message ?" }, "Bonjour", false);
    expect(shadow.memory.trials).toEqual([]);
    expect(shadow.memory.questions).toEqual([]);
  });
  it("un fait compte seulement s'il est mot pour mot dans le dernier mail et pas déjà connu", () => {
    const start = merge(smartEmptyMemory(), {}, "Bonjour").memory;
    const invented = merge(start, { newFacts: [{ needId: "n1", text: "Le client utilise Outlook", excerpt: "j'utilise Outlook" }] }, "Toujours pareil.");
    expect(invented).toMatchObject({ progressed: false, counted: [] });
    const real = merge(start, { newFacts: [{ needId: "n1", text: "Le statut affiche Déconnecté", excerpt: "c'est marqué Déconnecté" }] }, "Bonjour, c'est marqué Déconnecté.");
    expect(real).toMatchObject({ progressed: true, counted: ["fact"] });
    const again = merge(real.memory, { newFacts: [{ needId: "n1", text: "Le statut affiche Déconnecté", excerpt: "Déconnecté" }] }, "Oui, Déconnecté.");
    expect(again.progressed).toBe(false);
  });
  it("le résultat d'un essai en attente compte ; un essai inconnu ou déjà tranché ne compte pas", () => {
    const withTrial = merge(smartEmptyMemory(), { trials: [{ id: "e1", needId: "n1", what: "Reconnecter la boîte" }] }, "Bonjour").memory;
    const failed = merge(withTrial, { trialResults: [{ trialId: "e1", result: "failed" }] }, "J'ai reconnecté, rien.");
    expect(failed).toMatchObject({ progressed: true, counted: ["trial_failed"] });
    expect(failed.memory.trials[0]).toMatchObject({ result: "failed" });
    expect(merge(failed.memory, { trialResults: [{ trialId: "e1", result: "failed" }, { trialId: "e9", result: "worked" }] }, "Rien.").progressed).toBe(false);
  });
  it("une hypothèse qui se ferme compte ; une hypothèse ouverte de plus ne compte pas", () => {
    const open = merge(smartEmptyMemory(), { hypotheses: [{ id: "h1", needId: "n1", text: "Jeton expiré", status: "open" }] }, "Bonjour").memory;
    expect(merge(open, { hypotheses: [{ id: "h2", needId: "n1", text: "Autre piste", status: "open" }] }, "Rien.").progressed).toBe(false);
    expect(merge(open, { hypotheses: [{ id: "h1", needId: "n1", text: "Jeton expiré", status: "ruled_out", why: "reconnecté sans effet" }] }, "Rien.").progressed).toBe(true);
  });
  it("bornes : 12 faits, 6 essais, 4 questions ; la vue du modèle tient en 3 000 octets", () => {
    let memory = smartEmptyMemory();
    for (let i = 0; i < 20; i += 1) {
      memory = merge(memory, { newFacts: [{ needId: "n1", text: `fait numéro ${i} ${"détail ".repeat(i)}`, excerpt: `mot${i}` }], trials: [{ id: `e${i}`, needId: "n1", what: `essai ${i}` }], question: `question ${i} ?` },
        `mail avec mot${i} et ${"x".repeat(200)}`).memory;
    }
    expect(memory.facts.length).toBeLessThanOrEqual(12);
    expect(memory.trials.length).toBeLessThanOrEqual(6);
    expect(memory.questions.length).toBeLessThanOrEqual(4);
    expect(Buffer.byteLength(JSON.stringify(smartMemoryForModel(memory)), "utf8")).toBeLessThanOrEqual(3_000);
  });
});

describe("règle de progrès", () => {
  it("2 tours de suite sans progrès : passage de main ; un seul tour vide n'en déclenche pas", () => {
    const withEmpty = { ...smartEmptyMemory(2), progress: [true, false] };
    expect(smartNoProgressTwice(withEmpty, false)).toBe(true);
    expect(smartNoProgressTwice(withEmpty, true)).toBe(false);
    expect(smartNoProgressTwice({ ...smartEmptyMemory(1), progress: [true] }, false)).toBe(false);
    expect(smartProgressGate(withEmpty)).toMatchObject({ mustHandOff: false, noProgressLastTurn: true, exchange: 3 });
  });
  it("5e échange (ou 4e si réglé ainsi) : seule issue, le passage de main", () => {
    expect(smartProgressGate(smartEmptyMemory(3))).toMatchObject({ mustHandOff: false, exchange: 4 });
    expect(smartProgressGate(smartEmptyMemory(4))).toMatchObject({ mustHandOff: true, reason: "max_exchanges", exchange: 5 });
    expect(smartProgressGate(smartEmptyMemory(3), smartMaxExchanges({ SAV_V2_SMART_MAX_EXCHANGES: "4" }))).toMatchObject({ mustHandOff: true });
    expect(smartMaxExchanges({ SAV_V2_SMART_MAX_EXCHANGES: "12" })).toBe(5);
    expect(smartMemoryFromThread([{ from: "customer" }, { from: "support" }, { from: "customer" }]).exchanges).toBe(2);
  });
  it("question déjà posée et répondue : refusée ; essai déjà raté reproposé : refusé ; une autre piste passe", () => {
    const asked = merge(smartEmptyMemory(), { question: "Quel message d'erreur s'affiche à l'écran ?", trials: [{ id: "e1", needId: "n1", what: "Reconnecter la boîte Gmail dans Limova" }] }, "Bonjour").memory;
    const answered = merge(asked, { newFacts: [{ needId: "n1", text: "Erreur Authentication failed", excerpt: "Authentication failed" }], trialResults: [{ trialId: "e1", result: "failed" }] },
      "Le message est Authentication failed, et la reconnexion n'a rien changé.").memory;
    expect(answered.questions[0]).toMatchObject({ answered: true });
    expect(smartRepeatCodes(answered, decision({ outcome: "ask", memory: { question: "Quel message d'erreur s'affiche à l'écran ?" } }))).toEqual(["question_repeated"]);
    expect(smartRepeatCodes(answered, decision({ memory: { trials: [{ id: "e2", needId: "n1", what: "Reconnecter la boîte Gmail dans Limova" }] } }))).toEqual(["trial_repeated"]);
    expect(smartRepeatCodes(answered, decision({ memory: { trials: [{ id: "e2", needId: "n1", what: "Créer un mot de passe d'application chez l'hébergeur" }] } }))).toEqual([]);
    expect(smartRepeatCodes(answered, decision({ outcome: "handoff", teamNote: "x", memory: { question: "Quel message d'erreur s'affiche à l'écran ?" } }))).toEqual([]);
  });
});

describe("note de passage de main structurée", () => {
  const note = {
    raison: "real_bug" as const, besoin: "L'envoi de mails depuis l'Assistant échoue ; la réception marche.", compris: "Boîte connectée depuis 3 mois, contact client.fictif@exemple.invalid.",
    verifie: [{ fait: "La reconnexion suffit quand le jeton a expiré", source: "fiche c12 v3" }], essaye: [{ quoi: "Reconnexion (voir https://exemple.invalid/guide)", resultat: "échec" }],
    hypotheses: [{ texte: "Jeton expiré", statut: "ruled_out" }, { texte: "Blocage côté envoi", statut: "ouverte" }],
    prochaineVerification: "Regarder les journaux d'envoi du compte.", ditAuClient: "Je transmets à l'équipe.",
  };
  it("rendu : toutes les sections, sans adresse ni lien", () => {
    const text = renderSmartTeamNote(note);
    for (const label of ["Besoin :", "Compris :", "Vérifié :", "(source : fiche c12 v3)", "Essayé :", "→ échec", "Hypothèses :", "(écartée)", "(ouverte)", "À vérifier en premier :", "Dit au client :"])
      expect(text).toContain(label);
    expect(text).not.toContain("client.fictif@exemple.invalid");
    expect(text).not.toContain("https://");
  });
  it("note de secours : composée par le serveur depuis la mémoire, jamais vide", () => {
    let memory = merge(smartEmptyMemory(), { trials: [{ id: "e1", needId: "n1", what: "Reconnecter la boîte" }], hypotheses: [{ id: "h1", needId: "n1", text: "Jeton expiré", status: "open" }] }, "Bonjour").memory;
    memory = merge(memory, { newFacts: [{ needId: "n1", text: "Erreur Authentication failed", excerpt: "Authentication failed" }], trialResults: [{ trialId: "e1", result: "failed" }] }, "Authentication failed").memory;
    const fallback = smartFallbackNote({ reason: "pas_de_progres", reading, memory });
    expect(fallback).toMatchObject({ raison: "pas_de_progres", besoin: "se connecter à son espace", essaye: [{ quoi: "Reconnecter la boîte", resultat: "échec" }], hypotheses: [{ texte: "Jeton expiré", statut: "ouverte" }] });
    expect(fallback.compris).toContain("Authentication failed");
    expect(fallback.verifie[0]).toMatchObject({ source: "fiche fiche-connexion v3" });
    expect(fallback.prochaineVerification.length).toBeGreaterThan(10);
    expect(smartSensitiveNote(["finance"])).toContain("tout le mail est transmis à l'équipe");
  });
});
