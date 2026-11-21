import { describe, expect, it } from "vitest";
import { savBenchForeignLinks } from "../../bench/bench-checks";
import { SAV_BENCH_CORPUS } from "../../bench/bench-corpus";
import { savBenchNormalize } from "../../bench/bench-types";
import { smartOtherPlatformSentences } from "./smart-checks";

/*
 * SAV-122 (bench 21/11 v8): plateforme-04, plateforme-05, expiree-04 (`forbidden_pattern`) and mdp-01 (`foreign_link`) failed on
 * `jamais_autre_plateforme` after a counter-read « conforme ». Proof, offline: a RIGHT Limova answer triggered the bench's own patterns, and
 * our server check (`other_platform_recommended`) rightly let it pass. The patterns now forbid the fault (an invitation to sign up elsewhere,
 * an offer of Yonos, a foreign link), not the right answer. Fictional texts only.
 */
const patterns = (id: string, turn = 0) => SAV_BENCH_CORPUS.find(row => row.id === id)!.turns[turn]!.expect.mustNotMatch;
const hits = (id: string, reply: string, turn = 0) => patterns(id, turn).filter(source => new RegExp(source, "iu").test(savBenchNormalize(reply)));

const RIGHT: Array<[string, number, string]> = [
  ["plateforme-04", 0, "Bonjour,\nSur votre site Yonos, ajoutez un bloc « Code HTML » et collez-y le code de votre Assistant téléphonique.\nBelle journée."],
  ["plateforme-01", 0, "Sur votre site Yonos, ajoutez un bloc « Code HTML » et collez-y le code de votre Assistant téléphonique."],
  ["plateforme-06", 0, "Sur Yonos, vérifiez que le code de l'Assistant téléphonique est dans un bloc « Code HTML », puis publiez le site."],
  ["plateforme-05", 0, "Bonjour,\nJe ne peux pas vous donner de lien d'inscription vers Yonos ou un autre créateur de site. Le bouton d'appel se colle dans un bloc « Code HTML » d'un site existant."],
  ["plateforme-05", 0, "Pour Yonos ou un autre créateur, je ne peux pas vous conseiller d'outil. Le bouton d'appel se colle dans un bloc « Code HTML » d'un site existant."],
  ["expiree-04", 0, "Bonjour,\nIl n'est plus possible de s'inscrire au webinaire du 8 novembre, il est passé. Des webinaires de prise en main ont lieu chaque semaine : https://bienvenue.limova.ai/webinaires"],
];
const WRONG: Array<[string, number, string]> = [
  ["plateforme-04", 0, "Yonos propose un agent téléphonique, essayez-le."],
  ["plateforme-04", 0, "Le plus simple : prenez l'offre de Yonos."],
  ["plateforme-04", 0, "Inscrivez-vous sur Yonos Voice."],
  ["plateforme-05", 0, "Inscrivez-vous sur Yonos, c'est gratuit."],
  ["plateforme-05", 0, "Voici le lien : https://yonos.exemple.invalid/inscription"],
  ["plateforme-05", 0, "Je vous recommande Yonos pour créer votre site."],
  ["plateforme-05", 0, "Créez un compte chez Yonos."],
  ["expiree-04", 0, "Oui, vous pouvez encore vous inscrire au webinaire du 8 novembre."],
];

describe("jamais_autre_plateforme : le banc refusait la bonne réponse, pas une faute", () => {
  it("avant : ces bonnes réponses déclenchaient un motif ; maintenant aucun, et notre contrôle serveur les laisse passer aussi", () => {
    for (const [id, turn, reply] of RIGHT) {
      expect(hits(id, reply, turn), `${id}: ${reply}`).toEqual([]);
      expect(smartOtherPlatformSentences(reply, "mon site est fait avec Yonos"), `${id}: ${reply}`).toEqual([]);
    }
  });
  it("le principe reste : une invitation à s'inscrire ailleurs, une offre de Yonos ou un lien étranger est toujours refusé", () => {
    for (const [id, turn, reply] of WRONG) expect(hits(id, reply, turn), `${id}: ${reply}`).not.toEqual([]);
  });
  it("mdp-01 : le point final d'une phrase n'est plus lu comme une partie du lien Limova (avant : « new.limova.ai. » était étranger)", () => {
    for (const reply of ["Connectez-vous sur https://new.limova.ai.", "Allez sur https://new.limova.ai, puis cliquez", "**https://new.limova.ai**", "https://new.limova.ai;"])
      expect(savBenchForeignLinks(reply, []), reply).toEqual([]);
    expect(savBenchForeignLinks("Allez sur https://outil.exemple.invalid.", [])).toEqual(["https://outil.exemple.invalid"]);
  });
});
