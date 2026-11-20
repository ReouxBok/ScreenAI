import { smartGoodDecision, smartReading } from "./smart-test-doubles";

/*
 * Agent SAV intelligent (20/11, diagnosis of the shadow's « failed »): PLAUSIBLE model outputs (the shapes a JSON-mode Gemini returns in
 * practice), each one a well-behaved answer that the v3 contract refused as `output_invalid`. FICTIONAL content only (public repository).
 * `smart-output-tolerance.test.ts` checks that each now parses, and that what must stay refused stays refused.
 */

const step = (decision: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ thinking: "La fiche couvre la connexion IMAP.", action: "final", calls: [], decision, ...extra });
const handoffNote = { raison: "no_source", besoin: "Connecter sa boîte IMAP", compris: "Le client veut relier sa boîte mail.", verifie: [], essaye: [], hypotheses: [], prochaineVerification: "Vérifier le port IMAP", ditAuClient: null };
const long = (size: number) => "Le client explique qu'il a configuré sa boîte mais que rien ne remonte. ".repeat(Math.ceil(size / 70)).slice(0, size);

/** Decide steps: a final or tools step that a normal model may write. */
export const SMART_DECIDE_VARIANTS: Readonly<Record<string, unknown>> = {
  thinking_long_1500: step(smartGoodDecision(), { thinking: long(1_500) }),
  thinking_null: step(smartGoodDecision(), { thinking: null }),
  calls_null_on_final: step(smartGoodDecision(), { calls: null }),
  facts_null: step(smartGoodDecision({ facts: null })),
  memory_null: step(smartGoodDecision({ memory: null })),
  coverage_missing: step({ ...smartGoodDecision(), coverage: undefined }),
  handoff_reason_free_word: step(smartGoodDecision({ outcome: "handoff", reply: null, teamNote: handoffNote, handoffReason: "missing_information", coverage: [{ needId: "n1", status: "handed" }], facts: [] })),
  team_note_long_fields: step(smartGoodDecision({ outcome: "handoff", reply: null, handoffReason: "no_source", coverage: [{ needId: "n1", status: "handed" }], facts: [],
    teamNote: { ...handoffNote, besoin: long(700), compris: long(1_100), prochaineVerification: long(500), ditAuClient: long(450) } })),
  team_note_without_besoin: step(smartGoodDecision({ outcome: "handoff", reply: null, handoffReason: "no_source", coverage: [{ needId: "n1", status: "handed" }], facts: [],
    teamNote: { raison: "no_source", compris: "Le client veut relier sa boîte IMAP.", prochaineVerification: "Vérifier le port" } })),
  memory_question_long: step(smartGoodDecision({ outcome: "ask", memory: { question: long(450) } })),
  fact_excerpt_long: step(smartGoodDecision({ facts: [{ ...smartGoodDecision().facts[0], excerpt: `utilisez l'adresse e-mail de votre invitation ${long(700)}` }] })),
  wrapped_in_array: [step(smartGoodDecision())],
  json_string_with_fences: `\`\`\`json\n${JSON.stringify(step(smartGoodDecision()))}\n\`\`\``,
  flattened_final_decision: { thinking: "La fiche suffit.", ...smartGoodDecision() },
  tools_four_calls: { thinking: "il me manque une fiche", action: "tools", calls: ["imap", "smtp", "port", "ssl"].map((word, index) => ({ id: `t${index + 1}`, tool: "chercher_fiches", needId: "n1", args: { recherche: word } })) },
  tools_free_call_ids: { thinking: "il me manque une fiche", action: "tools", calls: [{ id: "call_1", tool: "chercher_fiches", needId: "n1", args: { recherche: "imap" } }] },
  tools_with_placeholder_decision: { thinking: "il me manque une fiche", action: "tools", calls: [{ id: "t1", tool: "chercher_fiches", needId: "n1", args: { recherche: "imap" } }], decision: {} },
  final_with_leftover_calls: step(smartGoodDecision(), { calls: [{ id: "t1", tool: "chercher_fiches", needId: "n1", args: {} }, { id: "t1", tool: "chercher_fiches", needId: "n1", args: {} }] }),
  enum_case_and_spaces: step(smartGoodDecision({ outcome: "Reply ", coverage: [{ needId: "n1", status: "Answered" }] }), { action: "Final" }),
};

/** Readings: a non-sensitive mail (Nylas IMAP/SMTP style) that the v3 contract refused or sent to the team for a shape, not a meaning. */
export const SMART_READING_VARIANTS: Readonly<Record<string, unknown>> = {
  sensible_preuve_null: smartReading({ sensible: { famille: "aucune", preuve: null } }),
  sensible_preuve_long: smartReading({ sensible: { famille: "aucune", preuve: long(500) } }),
  sensible_famille_case: smartReading({ sensible: { famille: "Aucune", preuve: "" } }),
  sensitive_families_null: smartReading({ sensitiveFamilies: null }),
  sensitive_families_none_word: smartReading({ sensitiveFamilies: ["aucune"] }),
  already_done_null: smartReading({ needs: [{ id: "n1", ask: "connecter sa boîte IMAP", alreadyDone: null, theme: null, search: "imap smtp" }] }),
  already_done_six: smartReading({ needs: [{ id: "n1", ask: "connecter sa boîte IMAP", alreadyDone: ["a", "b", "c", "d", "e", "f"], theme: "intégrations", search: "imap" }] }),
  theme_long: smartReading({ needs: [{ id: "n1", ask: "connecter sa boîte IMAP", alreadyDone: [], theme: long(120), search: "imap" }] }),
  sensitive_case: smartReading({ sensitive: "No" }),
  wrapped_in_array: [smartReading()],
};
