import { defineEntrySkillBlock, entrySkillRuleId, SAV_ENTRY_CONFIRM_OUTPUT_JSON_SCHEMA, type EntrySkillBlock } from "@/lib/sav/skills/entry-block";
import type { CorpusCase } from "@/lib/sav/skills/corpus-contract";
import type { BlockManifest, SkillDefinition } from "@/lib/sav/skills/skill-contract";

/*
 * A FAKE block with a skill, for the infra-entry tests only (never registered in production). 100 % fictional. It is also the model the content
 * lots copy (`/private/tmp/sav-blocks-20261119/INTERFACE.md`).
 */
export const FAKE_BLOCK_ID = "demo_export";
const REVISION = "sav-demo_export-entry-skill-2026-11-19.v1";

export const FAKE_BLOCK_SKILL: SkillDefinition = {
  id: entrySkillRuleId(FAKE_BLOCK_ID), revision: REVISION, role: "confirm",
  guidelines: [
    "DEMO_EXPORT = le client demande comment EXPORTER son agenda Limova (PDF ou impression).",
    "Pas DEMO_EXPORT : synchroniser un agenda tiers (intégration), régler un agent, toute question d'abonnement ou de facture.",
  ],
  examples: [
    { id: "d01", subject: "Export", text: "Comment exporter mon agenda en PDF ?", verdict: "block", comment: "export demandé" },
    { id: "d02", subject: "Facture", text: "Pouvez-vous m'envoyer la facture du mois ?", verdict: "team_sensitive", comment: "facturation" },
    { id: "d03", subject: "Agent", text: "Comment régler la voix de mon agent ?", verdict: "team_other", comment: "autre sujet" },
    { id: "d04", subject: "Souci", text: "Ça ne marche pas depuis hier.", verdict: "team_unsure", comment: "rien ne dit lequel" },
  ],
  outputSchema: SAV_ENTRY_CONFIRM_OUTPUT_JSON_SCHEMA,
};

export const FAKE_BLOCK_MANIFEST: BlockManifest = {
  blockId: FAKE_BLOCK_ID, family: "usage", productVersion: "all",
  skills: [{ id: FAKE_BLOCK_SKILL.id, revision: REVISION }], excludedNeighbours: ["integrations", "access"], sources: [],
};

export const FAKE_BLOCK_CORPUS: readonly CorpusCase[] = [
  { id: "p01", group: "positive", subject: "Impression", text: "Bonjour, je voudrais imprimer le planning de la semaine, où est le bouton ?", requests: [{ requestId: "r1", expected: { kind: "block", blockId: FAKE_BLOCK_ID } }] },
  { id: "p02", group: "positive", subject: "PDF", text: "Est-il possible de sortir le calendrier du mois au format PDF pour mon associé ?", requests: [{ requestId: "r1", expected: { kind: "block", blockId: FAKE_BLOCK_ID } }] },
  { id: "n01", group: "neighbour", subject: "Synchro", text: "Mon agenda externe ne se met plus à jour dans Limova.", requests: [{ requestId: "r1", expected: { kind: "team" } }] },
  { id: "n02", group: "neighbour", subject: "Connexion", text: "Je ne reçois pas le code pour me connecter.", requests: [{ requestId: "r1", expected: { kind: "block", blockId: "access" } }] },
  { id: "s01", group: "sensitive", subject: "Export et résiliation", text: "Je veux exporter mon agenda puis résilier mon abonnement.", requests: [{ requestId: "r1", expected: { kind: "sensitive" } }] },
  { id: "s02", group: "sensitive", subject: "Avoir", text: "Merci de m'envoyer un avoir pour le mois dernier.", requests: [{ requestId: "r1", expected: { kind: "sensitive" } }] },
  { id: "m01", group: "mixed", subject: "Deux choses", text: "Comment imprimer le planning ? Et aussi le code de connexion n'arrive pas.", requests: [
    { requestId: "r1", expected: { kind: "block", blockId: FAKE_BLOCK_ID } }, { requestId: "r2", expected: { kind: "block", blockId: "access" } }] },
  { id: "t01", group: "trap", subject: "Exporter mes données", text: "Je veux récupérer toutes les informations que vous avez sur moi.", requests: [{ requestId: "r1", expected: { kind: "sensitive" } }] },
];

export const FAKE_BLOCK: EntrySkillBlock = defineEntrySkillBlock({
  blockId: FAKE_BLOCK_ID, family: "usage", label: "Démo export",
  manifest: FAKE_BLOCK_MANIFEST,
  router: { covers: "exporter ou imprimer son agenda Limova (PDF, impression)", notThis: "synchroniser un agenda tiers, régler un agent, facturation" },
  skill: FAKE_BLOCK_SKILL,
  promptSha256: "1fac7bc37909877b179e9de6d29e7806238ace38afe1dcb9c55fca606489e7ba",
  corpus: FAKE_BLOCK_CORPUS,
  corpusMinimums: { positive: 1, neighbour: 1, sensitive: 1, mixed: 1, trap: 1 },
  initialMode: "off",
});

/** A second fake block, to exercise the router between two non-Access blocks. */
export const FAKE_BLOCK_B: EntrySkillBlock = defineEntrySkillBlock({
  ...FAKE_BLOCK, blockId: "demo_voice", label: "Démo voix",
  manifest: { ...FAKE_BLOCK_MANIFEST, blockId: "demo_voice", skills: [{ id: entrySkillRuleId("demo_voice"), revision: "sav-demo_voice-entry-skill-2026-11-19.v1" }] },
  router: { covers: "régler la voix de son agent", notThis: "exporter l'agenda" },
  skill: { ...FAKE_BLOCK_SKILL, id: entrySkillRuleId("demo_voice"), revision: "sav-demo_voice-entry-skill-2026-11-19.v1",
    guidelines: ["DEMO_VOICE = le client demande comment régler la voix de son agent."],
    examples: [
      { id: "v01", subject: "Voix", text: "Comment changer la voix de mon agent ?", verdict: "block", comment: "voix" },
      { id: "v02", subject: "Facture", text: "Je conteste la facture.", verdict: "team_sensitive", comment: "facturation" },
      { id: "v03", subject: "Export", text: "Comment exporter mon agenda ?", verdict: "team_other", comment: "export" },
      { id: "v04", subject: "?", text: "Problème.", verdict: "team_unsure", comment: "rien" },
    ] },
  promptSha256: "1c3f0a2f2b1f2aef9ec589fb3a0c2034e0c95947dda64fac475b3b39fdb0d53b",
  corpus: [{ id: "vp01", group: "positive", text: "Je veux une voix plus grave pour mon agent.", requests: [{ requestId: "r1", expected: { kind: "block", blockId: "demo_voice" } }] }],
});
