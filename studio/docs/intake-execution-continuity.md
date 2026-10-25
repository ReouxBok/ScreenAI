# Intake execution continuity across a compatible deployment

This mechanism transfers selected, unfinished executions to the current execution
policy. It does not analyse a message, call a provider, enqueue a wake, reset a
budget or dispatch an effect. Existing confirmed effects remain confirmed;
uncertain effects still go through the executor's read-only verification.

## Release procedure

1. Inventory unfinished executions and their policy IDs before changing the
   deployment. Exclude human-held, superseded and externally completed dossiers.
2. Fence the previous deployment's HTTP entry points **and background producers**,
   then drain its workers and leases. A successful HTTP maintenance response alone
   is not a drain. Keep evidence of the actual deployment and worker inventory.
3. Keep the source execution policy approved. A revoked policy is a business stop;
   this endpoint cannot revive it, even if its revocation comment mentions a
   deployment. Release tooling that always revokes the source policy cannot use
   this procedure unchanged. Do not recreate an old policy with a forged status.
4. Deploy and validate the compatible build with the same business rules,
   resources, access bindings, budget limits and historical boundaries. Approve
   and pin a new current execution policy to that build. Both policies must remain
   unexpired and their administrators authorised. Changing these business facts
   requires a separate decision; it is not a compatible continuity transfer.
5. While authenticated as an authorised Studio administrator, preview a **small,
   explicit selection** with `GET /api/internal/sav/intake/continuity`, query
   parameters `sourcePolicyId` and comma-separated `executionIds`. At most 100 IDs
   are allowed; use small batches to stay inside the 30-second route deadline.
   The launch administration page `/studio/sav/intake/launch` also exposes this
   exact preview/confirmation flow. Enter the source policy and explicit execution
   IDs, inspect the returned source/target/hash/IDs, then attest the independently
   verified producer fence and drain. The page does not establish that drain.
6. Review the selection and exact returned `preview.hash`. Send a same-origin
   JSON `POST` to the same endpoint with `sourcePolicyId`, `executionIds`,
   `expectedHash`, and `oldDeploymentFencedAndDrained: true`. The last field is an
   operator attestation, not an automatic check of the platform's worker drain.
7. Save the returned receipt ID and execution IDs. If the HTTP outcome is unknown,
   inspect the execution policy IDs and encrypted audit receipt before retrying.
   The endpoint is not an idempotent dispatch API; a repeated approval is refused.
   The panel sends at most one POST per mounted instance and locks after that
   attempt. A 409 can wrap a database error after an unknown commit outcome; it
   therefore also requires receipt inspection, rather than an automatic retry.
8. Allow the existing current-policy executor to resume. The cron executor can
   select transferred executions; the wake catch-up still selects observations
   using their original configuration hash, so immediate resumption is not
   guaranteed by approval. Confirm the final CRM result and console projection.

No operator request above authorises an extra response or other provider action.
An already planned identification effect, like every other existing effect,
retains its original permissions and may resume only through the normal executor.

## Compatibility and refusal

The original observation, its configuration hash and model-call ledger are never
rewritten. An encrypted audit witness binds the old observation, plan, input,
effect intents and existing confirmed receipts to the target policy and runtime.
The old configuration hash is recomputed from the reviewed runtime descriptor;
an unrecognised hash is refused. This release recognises the current prompt
revision and the explicitly reviewed previous v5 and v6 revisions, not arbitrary builds.

Any new source message, human refusal/pause, changed identity, edited intent or
receipt, changed resource/access/budget binding, revoked policy or disabled
administrator prevents continuation. Ordinary provider checks remain in force.

Only one direct policy transfer is supported per execution. Before a later
deployment, finish transferred executions or design and qualify another explicit
handover. Do not delete `authorityContinuityId` to bypass this limit. A code
rollback must preserve compatible verification of the witness; never switch back
to an old worker that cannot interpret an execution it might claim.

## Concurrent CRM history

The executor can complete committed logging/associations when append-only email
events appear on the exact target ticket. It still checks contact identity,
associations, ticket properties, notes, edits and the latest Gmail inbound.

Before setting an existing ticket to New, each new email must match the complete
source envelope/body or previously investigated email content. A previously
unseen outbound message, including an unproven automatic acknowledgement, remains
blocking at this semantic transition. An `email` kind alone is not proof that a
message is harmless. Created-ticket receipts and finalisation have their own
strict checks; completed effects are never recreated to absorb a history delta.
