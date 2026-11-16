/*
 * SAV-92 (idée 3, LOCAL and OFF): how the V2 decision call asks Gemini to generate, behind two flags read at each call, both off by default.
 * Pure: no model, network, database or clock.
 *
 * - `SAV_V2_STRUCTURED_OUTPUT=off|on` (absent = off). `on` also sends the decision (or closure) JSON schema to the provider as
 *   `generationConfig.responseJsonSchema` (Gemini REST v1beta, JSON Schema subset; `responseMimeType: application/json` stays, as the API
 *   requires). The schema text in the system instruction and the validator are unchanged: the provider schema is an aid, never the judge.
 * - `SAV_V2_THINKING_DECISION=low|medium|high` (absent = today's behaviour: no `thinkingConfig`, the model's own default level). It only
 *   applies to this V2 call; V1 keeps `savGeminiGenerationConfig` (`thinkingLevel: "low"`) untouched. Gemini 3 models only: the API
 *   returns an error for `thinkingLevel` on earlier models, so such a pairing is refused before any reservation.
 *
 * Neither flag changes a price, a bound or a reservation: thoughts are output tokens, counted inside the SAME `maxOutputTokens` the per-call
 * reserve already covers (`readCaseV2TransportPolicy`). Neither enters V1's configHash, the qualification scope hash or the spend policy
 * fingerprint. Both are recorded in the decision's `revisions.prompt` (`caseDecisionPromptRevision`) so a stored decision says how it was made.
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_V2_STRUCTURED_OUTPUT_ENV = "SAV_V2_STRUCTURED_OUTPUT";
export const SAV_V2_THINKING_DECISION_ENV = "SAV_V2_THINKING_DECISION";
/** Revision of the provider-schema adaptation below; part of the recorded prompt revision when `on`. */
export const SAV_V2_PROVIDER_SCHEMA_REVISION = "so1";
export type CaseDecisionThinkingLevel = "low" | "medium" | "high";
export type CaseDecisionGeneration = Readonly<{ structuredOutput: boolean; thinkingLevel: CaseDecisionThinkingLevel | null }>;
export type CaseDecisionGenerationRead =
  | Readonly<{ ok: true; generation: CaseDecisionGeneration }>
  | Readonly<{ ok: false; problem: "v2_structured_output_invalid" | "v2_thinking_decision_invalid" | "v2_thinking_decision_model_unsupported" }>;

const GEMINI_3 = /^gemini-3(?:[.-])/;
const blank = (value: string | undefined) => value === undefined || value.trim() === "";

/** The two flags, strictly: an unknown value is refused (never guessed), absent means today's behaviour. */
export function readCaseDecisionGeneration(env: Env, model: string): CaseDecisionGenerationRead {
  const so = env[SAV_V2_STRUCTURED_OUTPUT_ENV], thinking = env[SAV_V2_THINKING_DECISION_ENV];
  if (!blank(so) && so!.trim() !== "off" && so!.trim() !== "on") return { ok: false, problem: "v2_structured_output_invalid" };
  let thinkingLevel: CaseDecisionThinkingLevel | null = null;
  if (!blank(thinking)) {
    const value = thinking!.trim();
    if (value !== "low" && value !== "medium" && value !== "high") return { ok: false, problem: "v2_thinking_decision_invalid" };
    if (!GEMINI_3.test(model)) return { ok: false, problem: "v2_thinking_decision_model_unsupported" };
    thinkingLevel = value;
  }
  return { ok: true, generation: { structuredOutput: !blank(so) && so!.trim() === "on", thinkingLevel } };
}

/** Today's revision when both flags are off (byte-identical record); otherwise the same revision with what was sent appended. */
export function caseDecisionPromptRevision(base: string, read: CaseDecisionGenerationRead): string {
  if (!read.ok) return base;
  const { structuredOutput, thinkingLevel } = read.generation;
  return `${base}${structuredOutput ? `+${SAV_V2_PROVIDER_SCHEMA_REVISION}` : ""}${thinkingLevel ? `+think-${thinkingLevel}` : ""}`;
}

/*
 * The provider copy of a Zod-generated JSON schema. Gemini `responseJsonSchema` documents ONLY: $id $defs $ref $anchor type format title
 * description enum items prefixItems minItems maxItems minimum maximum anyOf oneOf(=anyOf) properties additionalProperties required
 * (+ propertyOrdering). Our decision schema also uses:
 * - `minLength` / `maxLength` (84 uses) and `pattern` (2): dropped from the copy (not in the list; the structured-output guide says length
 *   keywords are stripped anyway). The validator still enforces them.
 * - `const` (the 5 `nextAction.kind` discriminators): rewritten as a one-value `enum`, which is supported for strings: same constraint.
 * - `oneOf` (the `nextAction` union): rewritten as `anyOf`, which the API says it means anyway; the `kind` enums keep branches disjoint.
 * - `default` (1) and `$schema`: dropped (annotations, no constraint).
 * Any other keyword is refused (throws): a future schema change must be reviewed here, never sent unread.
 */
const KEPT = new Set(["type", "enum", "items", "prefixItems", "minItems", "maxItems", "minimum", "maximum", "required", "additionalProperties", "title", "description", "format"]);
const DROPPED = new Set(["$schema", "minLength", "maxLength", "pattern", "default"]);

export function caseProviderJsonSchema(schema: unknown): Record<string, unknown> {
  const convert = (node: unknown, path: string): unknown => {
    if (typeof node === "boolean") return node;
    if (!node || typeof node !== "object" || Array.isArray(node)) throw Error(`SAV_V2_PROVIDER_SCHEMA_UNSUPPORTED:${path}`);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (DROPPED.has(key)) continue;
      if (key === "properties") {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`SAV_V2_PROVIDER_SCHEMA_UNSUPPORTED:${path}.properties`);
        out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, convert(child, `${path}.properties.${name}`)]));
      } else if (key === "anyOf" || key === "oneOf") {
        if (!Array.isArray(value) || !value.length || out.anyOf) throw Error(`SAV_V2_PROVIDER_SCHEMA_UNSUPPORTED:${path}.${key}`);
        out.anyOf = value.map((child, index) => convert(child, `${path}.${key}.${index}`));
      } else if (key === "const") {
        if (typeof value !== "string" || "enum" in (node as object)) throw Error(`SAV_V2_PROVIDER_SCHEMA_UNSUPPORTED:${path}.const`);
        out.enum = [value];
      } else if (key === "items" || key === "additionalProperties" && typeof value === "object") {
        out[key] = convert(value, `${path}.${key}`);
      } else if (key === "prefixItems") {
        if (!Array.isArray(value)) throw Error(`SAV_V2_PROVIDER_SCHEMA_UNSUPPORTED:${path}.prefixItems`);
        out.prefixItems = value.map((child, index) => convert(child, `${path}.prefixItems.${index}`));
      } else if (KEPT.has(key)) {
        out[key] = value;
      } else throw Error(`SAV_V2_PROVIDER_SCHEMA_UNSUPPORTED:${path}.${key}`);
    }
    return out;
  };
  return convert(schema, "$") as Record<string, unknown>;
}

/** What `caseGeminiDecisionBody` adds to `generationConfig`; empty when both flags are off (the body stays byte-identical). */
export type CaseDecisionGenerationConfig = Readonly<{ responseJsonSchema?: Record<string, unknown>; thinkingConfig?: Readonly<{ thinkingLevel: CaseDecisionThinkingLevel }> }>;
export function caseDecisionGenerationConfig(generation: CaseDecisionGeneration, providerSchema: () => Record<string, unknown>): CaseDecisionGenerationConfig {
  return { ...(generation.structuredOutput ? { responseJsonSchema: providerSchema() } : {}),
    // Lower-case, as V1 already sends it (`savGeminiGenerationConfig`) and as Google's examples write it.
    ...(generation.thinkingLevel ? { thinkingConfig: { thinkingLevel: generation.thinkingLevel } } : {}) };
}
