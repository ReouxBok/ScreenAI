import "server-only";
import type { ThreadlessFirstMailDeps } from "./threadless-first-mail";

type Env = Record<string, string | undefined>;

/*
 * SAV-96 B: the production ports of the first mail, built like the V2 continuation (`v2-entry-binding.ts`): the V2 investigation factory (its key,
 * model, spend and transport policies, the approved admission policy and access scope), C's CRM owner port, SAV-97's stored-or-computed reading and
 * the approved execution policy. Null when any of them cannot be built: the entry keeps today's fixed draft for a person.
 */
export async function loadThreadlessFirstMailDeps(env: Env): Promise<ThreadlessFirstMailDeps | null> {
  try {
    const { createCaseInvestigationV2Deps } = await import("../investigation-v2-factory");
    const { createCaseTicketOwnerPort } = await import("../case-v2-wake-ports");
    const { v2EntryPolicySources } = await import("../v2-entry");
    const { intakeExecutionConfig, readIntakeExecutionAuthority } = await import("../../intake/execution-policy");
    const { readThreadlessAccessSkill } = await import("../threadless-source");
    const config = intakeExecutionConfig(env);
    if (!config) return null;
    await readIntakeExecutionAuthority(config);
    const source = () => env;
    const readTicketOwner = createCaseTicketOwnerPort({ env: source });
    // A ticket case is only opened under an open qualification scope; a scope closed since is a full pause of the factory (`casePauseState`).
    const built = createCaseInvestigationV2Deps({ ...v2EntryPolicySources(env, { accessSkillCompute: "never" }), env: source, readTicketOwner });
    if (!built.ok) {
      console.info("sav_v2_first_mail_unavailable", { reasons: built.refusals.join(",").slice(0, 300) });
      return null;
    }
    return {
      env: source, investigation: built.deps, provenance: built.provenance, readTicketOwner,
      executionPolicy: { id: config.policyId, hash: config.policyHash },
      // The reading the entry stored when it admitted the ticket (computed here only if it is missing: once, under V2's model budget).
      accessSkill: ticket => readThreadlessAccessSkill(ticket, env, true),
    };
  } catch {
    return null;
  }
}
