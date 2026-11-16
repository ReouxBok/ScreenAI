/** `settle_wake` (SAV-92, 16/11): the durable wake started when a passage was refused for `inbound_settling` (`case-v2-latency-wakes.ts`). */
export type CaseContinuationTrigger = "customer_return" | "relay" | "sweep" | "settle_wake";
/** Idempotent and safe to call again for one case: it stops by itself on a stale admission, a sensitive case, a pause or an owner who is not V2's. A failure throws. */
/** `retryAt`: only on a claim refused for `inbound_settling`, the instant the store accepts the claim again (an ISO date, nothing else). */
export type CaseContinuationReport = { status: string; reason?: string; detail?: string; retryAt?: string };
/** `deadlineMs`: when the CALLER must be done. Given, a reply queued by this passage is sent at once if that budget allows it; absent (a shared worker),
 * nothing is sent here and the reply waits, queued, for the effects catch-up. */
export type CaseContinuationPoint = (input: { caseId: string; trigger: CaseContinuationTrigger; env: Record<string, string | undefined>; deadlineMs?: number }) => Promise<CaseContinuationReport>;

const CODE = /^[a-z0-9_]{1,80}$/, DETAIL = /^[a-z0-9_,.:-]{1,160}$/, ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** Closed codes only (never client, provider or CRM text): why a passage stopped, for the operator and the logs. */
export function caseContinuationReport(status: string, source: { reason?: unknown; detail?: unknown; problem?: unknown; code?: unknown; retryAt?: unknown }): CaseContinuationReport {
  // A refused proposal names its closed code as `code` (e.g. `team_part_handoff_unavailable`, review batch 3 B1): kept, so the entry can mark the wait.
  const reason = typeof source.reason === "string" ? source.reason : typeof source.problem === "string" ? source.problem : typeof source.code === "string" ? source.code : undefined;
  const detail = typeof source.detail === "string" ? source.detail : undefined;
  const retryAt = status === "claim_refused" && typeof source.retryAt === "string" && ISO.test(source.retryAt) && Number.isFinite(Date.parse(source.retryAt)) ? source.retryAt : undefined;
  return { status, ...(reason && CODE.test(reason) ? { reason } : {}), ...(detail && DETAIL.test(detail) ? { detail } : {}), ...(retryAt ? { retryAt } : {}) };
}

/** Immediate send (11/11): the sender used right after a reply is queued. Absent: the real one (`sendQueuedCaseReplyNow`); null: none (the catch-up sends). */
/** Separate send (SAV-92, 16/11): when the reply could not leave inside the caller (no deadline, the sweep, or too little time left), ONE durable
 * workflow sends it in its own step with its own budget (`requestCaseReplySend`, at most once per execution). Absent: the real one; null: none. */
export type CaseContinuationOptions = {
  sendNow?: import("./immediate-send-budget").ImmediateCaseReplySend | null;
  dispatchSend?: ((input: { env: Record<string, string | undefined>; executionId: string }) => Promise<{ started: boolean; reason: string }>) | null;
};

export async function loadCaseContinuationPoint(options: CaseContinuationOptions = {}): Promise<CaseContinuationPoint> {
  const { createCaseInvestigationToReplyPlan } = await import("./investigation-v2-factory");
  const { createCaseTicketOwnerPort } = await import("./case-v2-wake-ports");
  const { v2EntryPolicySources } = await import("./v2-entry");
  const { intakeExecutionConfig, readIntakeExecutionAuthority } = await import("../intake/execution-policy");
  const { savV2QualificationCaseAllowed } = await import("./qualification-scope");
  const sendNow = options.sendNow === undefined ? await import("./v2-effects-binding").then(module => module.sendQueuedCaseReplyNow, () => null) : options.sendNow;
  const dispatchSend = options.dispatchSend === undefined
    ? await import("./case-v2-latency-wakes").then(module => module.requestCaseReplySend, () => null) : options.dispatchSend;
  return async ({ caseId, trigger, env, deadlineMs }) => {
    if (env.SAV_V2_INVESTIGATION !== "observe") {
      console.info("sav_v2_continuation_skipped", { caseId, reason: "investigation_off" });
      return { status: "investigation_off" };
    }
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
    const report = result.reply ? caseContinuationReport(result.reply.status, result.reply as Record<string, unknown>)
      : caseContinuationReport(result.investigation.status, result.investigation as Record<string, unknown>);
    console.info("sav_v2_continuation_report", { caseId, ...report });
    // The reply is queued (now or by an earlier pass): it is sent at once, under the catch-up's own guards, claim and lease, and only within the caller's
    // budget. No deadline (a shared worker), the sweep (inside the shared worker) or a budget too short: the send is handed to ONE separate workflow step
    // with its own budget (same sender, same guards), at most once per execution; the effects worker stays the safety net. Never throws, never changes the report.
    if (result.reply?.status === "queued") {
      const executionId = result.reply.executionId;
      let handOff = true;
      if (sendNow && deadlineMs !== undefined && trigger !== "sweep") {
        const sent = await sendNow({ env, executionId, callerDeadlineMs: deadlineMs }).catch(() => ({ failed: "SAV_V2_IMMEDIATE_SEND_THREW" }));
        console.info("sav_v2_immediate_send", { caseId, executionId,
          ...("pass" in sent ? { supervised: sent.pass.skipped ?? sent.pass.supervisedSkipped ?? (sent.pass.supervised.map(row => row.state).join(",") || "none") } : sent) });
        // Only a caller short of time hands the send off: any other answer (sent, a guard, a failure, a lease held elsewhere) is left to the catch-up.
        handOff = "skipped" in sent && sent.skipped === "caller_budget";
      }
      if (handOff && dispatchSend) {
        const dispatched = await dispatchSend({ env, executionId }).catch(() => ({ started: false, reason: "dispatch_threw" }));
        console.info("sav_v2_reply_send_dispatch", { caseId, executionId, trigger, started: dispatched.started, reason: dispatched.reason });
      }
    }
    return report;
  };
}
