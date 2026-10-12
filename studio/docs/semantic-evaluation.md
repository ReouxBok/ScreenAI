# Semantic understanding evaluation protocol v1

This is a proposed evaluation protocol and executable evidence checker. It does not contain a client corpus, approved product expectations, model quality results, or delivery approval. Product approval of the protocol and each expected result is required before a scored campaign.

## Contract boundary

The runtime understanding contract is versioned separately in `src/lib/sav/understanding.ts`. It identifies the primary and secondary requests, product/feature, known facts, attempted steps, missing information, exact source evidence, language and uncertainties. Understanding, ticket category and server permissions are separate values. Financial vocabulary alone is not a financial request; incidental prices and customer business content remain distinguishable from account operations. Historical quotations and unread attachments are not evidence of a new current request.

The evaluator stores identifiers and hashes of that evidence. It does not duplicate source messages, knowledge, CRM snapshots, or draft text. Human reviewers map the model's request identifiers to the frozen reference identifiers in the private annotation artifact. They assess semantic equivalence, evidence relevance, grounding and draft quality; matching a phrase or a model self-assessment is insufficient.

States are measurable: qualified, clarification needed with an explicit missing/conflicting fact, and unavailable because the provider or output failed. An unjustified clarification reduces the qualification score. Provider failures and missing results also remain in the validation denominator. They are never discarded as unscored successes.

## Proposed fixed corpus

Before the first score, freeze 40 development cases and 80 independent control cases. Each family has four development cases and eight control cases, half French and half English:

- Customer business prices interpreted by an agent.
- Technical issue mentioning a price paid.
- Actual financial request.
- Multiple requests including a restricted request.
- Invoice navigation.
- Technical usage-credit issue.
- Cancellation request.
- Historical quotation or signature.
- Follow-up with already known information.
- Ambiguity or missing context.

Keep one situation and all its paraphrases within one partition. Split by situation before authoring variants. Review control expectations independently from prompt tuning. Never remove a failure to improve the score. Relabeling needs a justification, new corpus version, renewed approval, new hash, and comparable baseline/candidate runs.

`savSemanticManifestSchema` fixes case IDs, family, partition, language, situation group, private input hash, expected labels, justification hash and human annotation approval. `protocolApproval` records product approval; timestamps must precede the freeze. The full canonical manifest hash binds each campaign. A live query of current approved reviews is not a frozen corpus: a later review must not silently delete a previous failure.

Reuse approved, anonymized sources from `reviewed-replay.ts` in the private application environment. Export only after an authorized private workflow; this tooling does not read or export the production database. The existing `replay.ts` deterministic suite remains useful for code regressions and does not measure real semantic quality. CI explicitly uses `sav:replay -- --technical-preflight` to check technical intake rules. Its report keeps all semantic cases unevaluated and `semanticQualityVerified: false`; a successful CI job is not the semantic release gate. The default replay exits nonzero if any case is unevaluated. No V1 qualification code or corpus is imported.

## Measurements and exit conditions

The control qualification rate is conformant cases divided by all 80 frozen control cases. Conformance requires human confirmation plus correct primary request, all expected request identities, category, restriction and abstention. The ≥95% threshold permits at most four qualification errors, including unjustified abstentions. Report each family's numerator and denominator alongside the global result.

Report separately: false financial restriction count and negative-case denominator; expected and omitted secondary requests; total and unjustified abstentions; missing results, provider outages and invalid outputs; restriction failures; and draft defects. Safety and draft gates apply to both development and control: zero false financial restrictions, zero omitted secondary requests, all financial/cancellation restrictions respected, no unsupported advice, invented commitment or repeat request for known information. The independent control score is never combined with development to inflate the result.

Store per-request duration, input and output token counts (including reported reasoning tokens), provider request ID when available, and hashes of original responses. Preserve unknown measurements as unknown. Record cost in USD from the actual bill or an explicitly documented pricing estimate; do not invent a zero when measurements or pricing are absent. The checker blocks missing usage fields, uses null for incomplete token/cost totals, and reports latency measurement coverage. Retain fixed prompt/model/contract/knowledge revisions and exact clean code SHA.

The separate fault campaign requires evidence for timeout, provider error, invalid output and invalid evidence. It establishes safe degraded behavior; its synthetic outcomes do not count as semantic quality scores.

Release readiness also requires baseline and candidate campaigns on the same frozen manifest, confirmed isolation, actual model execution, output-bound human reviews, product approval of the exact candidate artifact, and independent review of exact base/head and campaign hashes. These are attestations, not signatures or an authorization system: the human reviewer must verify their original evidence. This CLI cannot authenticate a reviewer, prove an input is anonymized, or prove OS-level network isolation.

## Offline evidence checker

From `studio`, with the campaign artifact in a private directory outside every public checkout:

```sh
node_modules/.bin/tsx scripts/evaluate-sav-semantic.ts /absolute/private/campaign.json
```

The input uses `savSemanticEvaluationInputSchema`: manifest, baseline, candidate, fault checks and review attestations. The command reads one external JSON file; it imports no database, provider or dotenv module and writes no file. Output includes metadata, counts and failure IDs only. Non-readiness or invalid data returns exit 1. Validation errors are redacted so private payloads and file paths do not enter error logs. Never commit the private input or report.

## Optional real-model collector

`scripts/run-sav-semantic-model.ts` calls the same complete `analyzeSavMessage` evaluation entry point as the application. It requires the matching `SAV_EVALUATION_ADAPTER_REVISION`, a clean checkout, a frozen/approved manifest, and private fixture inputs with matching hashes. The input contains `{ version, manifest, model, mode, cases }`; each private case contains `{ id, input, knowledge, crm }`. Hash the entire private case when populating its manifest `inputHash`. Golden labels are never passed to the model.

Run only in a dedicated evaluation process with `NODE_OPTIONS=--conditions=react-server`, explicit `SAV_EVAL_ALLOW_MODEL_CALLS=1` and a dedicated `SAV_EVAL_GEMINI_API_KEY`. No credential is loaded by this script. It rejects database, Gmail, HubSpot and ordinary model credentials/configuration. Credentials, fixture files and results must remain outside the public repository; the existing output directory must have permissions 0700. The output is created exclusively with mode 0600 and will not overwrite an existing campaign.

```sh
node_modules/.bin/tsx scripts/run-sav-semantic-model.ts /absolute/private/inputs.json /absolute/private/raw-results.json
```

The collector supplies fixture-only knowledge and CRM adapters and no persisted message/batch ID. Its fetch guard accepts only the chosen model on the Gemini generation endpoint, using the dedicated key, and rejects redirects. It also wraps global fetch for SDK requests. A separate isolated process/network sandbox is still required; this guard is not an operating-system security boundary. No live model calls are made by tests or by the offline checker.

Each raw result contains private analysis and response evidence, hashes, usage and `humanReview: null`. The collector always reports `releaseReady: false`: humans must review and annotate the raw outputs, retain original evidence, add provenance and cost, then use the offline checker. Existing runtime model errors and thrown failures stay in the output; no case is retried automatically. Partial campaign results are saved after each case. SDK/runtime trace token totals and intercepted request totals describe overlapping usage and must not be added together.

## Review and delivery

The code/tests establish arithmetic, schema boundaries and refusal behavior. They do not validate the proposed 40/80 corpus, human expectations, customer experience, provider quality, or a production incident. Those require actual approved private cases, real-model campaigns and product review. Exact-lot regression/CI checks and delivery authorization remain separate from this evidence checker. A `releaseReady` report cannot merge, deploy, enable automation, publish knowledge, or modify customer data.
