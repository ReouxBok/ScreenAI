import "server-only";

type Check = { ok: boolean; errorCode?: string; [key: string]: unknown };
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
async function readJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
  return response.json();
}
async function check(operation: () => Promise<Check>): Promise<Check> {
  try { return await operation(); }
  catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    // Never include provider bodies, URLs, keys or customer records.
    return { ok: false, errorCode: /^[A-Z0-9_]+$/.test(message) ? message : "PROVIDER_CHECK_FAILED" };
  }
}

/** Diagnostics only. No email body, CRM record, write method or DB mutation. */
export async function readSavPreflight() {
  const locked = process.env.SAV_RELEASE_STAGE === "v0"
    && process.env.SAV_AUTOMATION_MODE === "shadow" && process.env.SAV_WRITES_DISABLED === "true"
    && process.env.SAV_PILOT_MODE === "false" && process.env.SAV_HUBSPOT_BACKFILL_ENABLED === "false"
    && process.env.SAV_RETENTION_ENABLED === "false" && process.env.DEV_AUTH_BYPASS !== "true";
  // This endpoint only operates in the explicitly locked observation rollout.
  if (!locked) return { ok: false, locked: false, errorCode: "SAV_PREFLIGHT_LOCK_REQUIRED" };
  const [gmail, hubspot, model] = await Promise.all([
    check(async () => {
      const token = await readJson("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: required("GMAIL_CLIENT_ID"), client_secret: required("GMAIL_CLIENT_SECRET"), refresh_token: required("GMAIL_REFRESH_TOKEN"), grant_type: "refresh_token" }),
      });
      if (!token.access_token) throw new Error("GMAIL_ACCESS_TOKEN_MISSING");
      const headers = { Authorization: `Bearer ${token.access_token}` };
      const [profile, labels] = await Promise.all([
        readJson("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers }),
        readJson("https://gmail.googleapis.com/gmail/v1/users/me/labels", { headers }),
      ]);
      const mailbox = String(profile.emailAddress ?? "").toLowerCase();
      if (mailbox !== required("GMAIL_SUPPORT_ADDRESS").toLowerCase()) throw new Error("GMAIL_MAILBOX_IDENTITY_MISMATCH");
      const recipients = (process.env.GMAIL_INTAKE_RECIPIENTS || process.env.GMAIL_SUPPORT_ADDRESS || "").split(",").map((value) => value.trim().toLowerCase());
      if (!recipients.includes("contact@limova.ai")) throw new Error("GMAIL_CONTACT_INTAKE_MISSING");
      const matches = (labels.labels ?? []).filter((label: { name?: string; type?: string }) => label.type === "user" && label.name?.toLowerCase() === "mail studio sav");
      if (matches.length !== 1) throw new Error("GMAIL_STUDIO_LABEL_MISSING_OR_AMBIGUOUS");
      return { ok: true, mailboxEmail: mailbox, intakeRecipient: "contact@limova.ai", studioLabelExists: true, writeScopesNotTested: true };
    }),
    check(async () => {
      const headers = { Authorization: `Bearer ${required("HUBSPOT_ACCESS_TOKEN")}` };
      const base = "https://api.hubapi.com";
      const pipeline = required("HUBSPOT_TICKET_PIPELINE_ID");
      const [mapping] = await Promise.all([
        readJson(`${base}/crm/v3/pipelines/tickets/${encodeURIComponent(pipeline)}`, { headers }),
        readJson(`${base}/crm/v3/objects/contacts?limit=1`, { headers }),
        readJson(`${base}/crm/v3/objects/tickets?limit=1`, { headers }),
      ]);
      const stages = new Set((mapping.stages ?? []).map((stage: { id?: string }) => stage.id));
      for (const name of ["HUBSPOT_NEW_TICKET_STAGE_ID", "HUBSPOT_AWAITING_CUSTOMER_STAGE_ID", "HUBSPOT_HUMAN_STAGE_ID"]) {
        if (!stages.has(required(name))) throw new Error("HUBSPOT_STAGE_MAPPING_INVALID");
      }
      return { ok: true, contactsReadable: true, ticketsReadable: true, pipelineStagesValid: true, writesNotTested: true };
    }),
    check(async () => {
      const name = required("SAV_AI_MODEL").replace(/^models\//, "");
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("SAV_MODEL_NAME_INVALID");
      const metadata = await readJson(`https://generativelanguage.googleapis.com/v1beta/models/${name}`, {
        headers: { "x-goog-api-key": required("SAV_GEMINI_API_KEY") },
      });
      if (!metadata.supportedGenerationMethods?.includes("generateContent")) throw new Error("SAV_MODEL_GENERATION_UNAVAILABLE");
      return { ok: true, name, generationAvailable: true, inferenceNotTested: true };
    }),
  ]);
  return { ok: gmail.ok && hubspot.ok && model.ok, locked, codeRevision: process.env.SAV_CODE_REVISION || process.env.VERCEL_GIT_COMMIT_SHA || "unknown", gmail, hubspot, model };
}
