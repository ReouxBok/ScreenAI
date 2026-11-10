export type CaseContinuationTrigger = "customer_return" | "relay" | "sweep";
/** Idempotent and safe to call again for one case: it stops by itself on a stale admission, a sensitive case, a pause or an owner who is not V2's. A failure throws. */
export type CaseContinuationPoint = (input: { caseId: string; trigger: CaseContinuationTrigger; env: Record<string, string | undefined> }) => Promise<{ status: string }>;

export async function loadCaseContinuationPoint(): Promise<CaseContinuationPoint> {
  const { createCaseInvestigationToReplyPlan } = await import("./investigation-v2-factory");
  const { createCaseTicketOwnerPort } = await import("./case-v2-wake-ports");
  const { v2EntryPolicySources } = await import("./v2-entry");
  const { intakeExecutionConfig, readIntakeExecutionAuthority } = await import("../intake/execution-policy");
  const { savV2QualificationCaseAllowed } = await import("./qualification-scope");
  return async ({ caseId, env }) => {
    if (env.SAV_V2_INVESTIGATION !== "observe") return { status: "investigation_off" };
    const config = intakeExecutionConfig(env);
    if (!config) throw Error("SAV_V2_EXECUTION_POLICY_ABSENT");
    await readIntakeExecutionAuthority(config);
    const source = () => env;
    const readTicketOwner = createCaseTicketOwnerPort({ env: source });
    const configuredRule = env.SAV_V2_RETURN_RULE_JSON ? JSON.parse(env.SAV_V2_RETURN_RULE_JSON) : null;
    const returnRule = configuredRule && typeof configuredRule.ruleId === "string" && typeof configuredRule.revision === "string"
      ? { ruleId: configuredRule.ruleId, revision: configuredRule.revision } : undefined;
    const binding = createCaseInvestigationToReplyPlan({
      ...v2EntryPolicySources(env), env: source, readTicketOwner, store: { env: source, readTicketOwner },
      // SAV-80: the qualification scope read again before every new cost of this case (embedding, model call), not only at the entry.
      caseAllowed: async () => (await savV2QualificationCaseAllowed(env, caseId)).allowed,
      executionPolicy: { id: config.policyId, hash: config.policyHash }, ...(returnRule ? { returnRule } : {}),
    });
    if (!binding.ok) throw Error("SAV_V2_" + (("refusals" in binding ? binding.refusals : binding.missing)[0] ?? "BINDING_INVALID").replace(/[^a-z0-9]/gi,"_").toUpperCase());
    const result = await binding.run(caseId);
    return { status: result.reply?.status ?? result.investigation.status };
  };
}
