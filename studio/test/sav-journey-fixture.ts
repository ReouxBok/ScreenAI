export const JOURNEY_KEY = "synthetic-sav49-65-local-only-key-2026";
export const JOURNEY_CASES = ["create", "link", "waiting", "reopen", "successor", "retry", "uncertain"] as const;
export type JourneyCase = typeof JOURNEY_CASES[number];
export function journeyId(key: JourneyCase) { return `00000065-0000-4000-8000-${String(JOURNEY_CASES.indexOf(key) + 1).padStart(12, "0")}`; }
