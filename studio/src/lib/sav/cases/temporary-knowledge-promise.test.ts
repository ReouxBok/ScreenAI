import { describe, expect, it } from "vitest";
import { temporaryKnowledgePromise } from "./temporary-knowledge-promise";

describe("temporaryKnowledgePromise (SAV-105)", () => {
  it.each([
    "À bientôt.",
    "Nous ne pouvons pas garantir de délai.",
    "Nous ignorons quand la fonctionnalité sera disponible.",
    "Nous ne savons pas encore quand la fonctionnalité sera disponible.",
    "On ne sait toujours pas si le correctif sera livré cette semaine.",
    "J’ignore à quelle date la fonctionnalité sera ajoutée.",
    "We don't know yet when it will be fixed.",
    "Nous n’allons pas ajouter cette fonctionnalité.",
    "La fonctionnalité ne sera pas disponible demain.",
  ])("caution or uncertainty about the date is not a promise: %s", wording => {
    expect(temporaryKnowledgePromise(wording)).toBe(false);
  });

  it.each([
    "Nous allons ajouter cette fonctionnalité vendredi.",
    "On va corriger ça d’ici lundi.",
    "Je vais vous rembourser demain.",
    "We are going to fix it on Friday.",
    "Nous livrerons cette fonctionnalité vendredi.",
    "La fonctionnalité sera disponible demain.",
    "Nous ignorons la cause, mais nous allons corriger le problème lundi.",
    "Nous ne savons pas quand exactement ; la fonctionnalité sera disponible vendredi.",
  ])("a commitment of the support, simple or near future, is a promise: %s", wording => {
    expect(temporaryKnowledgePromise(wording)).toBe(true);
  });
});
