import { createHash } from "node:crypto";
import { SAV_INTAKE_CONTRACT_REVISION } from "./contract";
import manifest from "./authority-manifest.json";

export const SAV_INTAKE_AUTHORITY_REVISION = manifest.authorityRevision;
export const SAV_INTAKE_AUTHORITY_SOURCES = Object.freeze(manifest.sources);
export const SAV_INTAKE_COMPATIBILITY = createHash("sha256").update(JSON.stringify({
  revision: SAV_INTAKE_AUTHORITY_REVISION,
  contract: SAV_INTAKE_CONTRACT_REVISION,
  sources: SAV_INTAKE_AUTHORITY_SOURCES,
})).digest("hex");
type AuthorityPin = { codeRevision: string; compatibility?: string };
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const compatible = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) && value === SAV_INTAKE_COMPATIBILITY;

/** Compatibility is an explicit opt-in, never a fallback after a failed check.
 * codeRevision remains the approved reference; deployedSha identifies this build. */
export function intakeArtifactAuthorized(pin: AuthorityPin, deployedSha: unknown): boolean {
  if (!sha(deployedSha) || !sha(pin.codeRevision)) return false;
  return pin.compatibility === undefined ? pin.codeRevision === deployedSha : compatible(pin.compatibility);
}
/** Only compare artifact pins here. Mailbox, resources, dates, admission and
 * mutations still require their independent checks at the call site. */
export function intakeSamePin(a: AuthorityPin, b: AuthorityPin): boolean {
  if (!sha(a.codeRevision) || !sha(b.codeRevision)) return false;
  if (a.compatibility === undefined && b.compatibility === undefined) return a.codeRevision === b.codeRevision;
  return compatible(a.compatibility) && compatible(b.compatibility);
}
