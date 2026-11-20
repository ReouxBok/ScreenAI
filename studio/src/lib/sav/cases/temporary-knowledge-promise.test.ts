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
    "Nous ignorons quand elle apparaîtra sur votre compte, mais nous ne pouvons pas garantir de délai.",
    "Nous ignorons quand, et si, la fonctionnalité sera disponible.",
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
    "La fonctionnalité sera disponible vendredi, même si nous ignorons quand elle apparaîtra sur votre compte.",
    "La fonctionnalité sera disponible vendredi même si nous ignorons quand elle apparaîtra sur votre compte.",
    "Nous ignorons quand elle apparaîtra sur votre compte, mais la fonctionnalité sera disponible vendredi.",
    "Nous ignorons quand elle apparaîtra sur votre compte, cependant la fonctionnalité sera disponible vendredi.",
    "Nous ignorons quand elle apparaîtra sur votre compte, toutefois la fonctionnalité sera disponible vendredi.",
    "Nous ignorons quand elle apparaîtra sur votre compte, en revanche la fonctionnalité sera disponible vendredi.",
    "Nous ignorons quand elle apparaîtra sur votre compte, néanmoins la fonctionnalité sera disponible vendredi.",
    "We will fix it on Friday, even if we don't know when it will show on your account.",
  ])("a commitment of the support, simple or near future, is a promise: %s", wording => {
    expect(temporaryKnowledgePromise(wording)).toBe(true);
  });
});
