import "server-only";

const gmailScopePrefix = "https://www.googleapis.com/auth/gmail.";
const fullMailScope = "https://mail.google.com/";

/** Inspect this runtime's OAuth grant only. Never send, modify a message, or read its body. */
export async function readSavGmailPermissions() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return { ok: false, errorCode: "SAV_GMAIL_CREDENTIALS_MISSING" };
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    if (!response.ok) return { ok: false, errorCode: "SAV_GMAIL_OAUTH_CHECK_FAILED", providerStatus: response.status };
    const token = await response.json();
    if (typeof token.access_token !== "string" || !token.access_token) return { ok: false, errorCode: "SAV_GMAIL_ACCESS_TOKEN_MISSING" };
    const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      cache: "no-store", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!profileResponse.ok) return { ok: false, errorCode: "SAV_GMAIL_PROFILE_CHECK_FAILED", providerStatus: profileResponse.status };
    const profile = await profileResponse.json();
    if (typeof profile.emailAddress !== "string" || profile.emailAddress.toLowerCase() !== "contact@limova.ai"
      || process.env.GMAIL_SUPPORT_ADDRESS?.toLowerCase() !== "contact@limova.ai") return { ok: false, errorCode: "SAV_GMAIL_MAILBOX_IDENTITY_MISMATCH" };
    const scopeKnown = typeof token.scope === "string" && token.scope.trim().length > 0;
    const scopes = new Set<string>(scopeKnown ? token.scope.trim().split(/\s+/u) : []);
    const hasFullMail = scopes.has(fullMailScope);
    const modifyScopeGranted = scopeKnown ? hasFullMail || scopes.has(`${gmailScopePrefix}modify`) || scopes.has(`${gmailScopePrefix}modify.restricted`) : null;
    const sendScopeGranted = scopeKnown ? hasFullMail || ["modify", "compose", "send"].some((scope) => scopes.has(`${gmailScopePrefix}${scope}`)) : null;
    return {
      ok: scopeKnown && modifyScopeGranted === true && sendScopeGranted === true,
      mailboxEmail: "contact@limova.ai", scopeKnown, modifyScopeGranted, sendScopeGranted,
      // Only known Gmail permission names; never echo arbitrary provider strings.
      gmailScopes: [...scopes].filter((scope) => scope === fullMailScope || /^https:\/\/www\.googleapis\.com\/auth\/gmail\.[a-z.]+$/u.test(scope)).sort(),
      errorCode: !scopeKnown ? "SAV_GMAIL_SCOPES_UNKNOWN" : !modifyScopeGranted || !sendScopeGranted ? "SAV_GMAIL_WRITE_SCOPES_MISSING" : null,
      writesNotTested: true,
    };
  } catch {
    // Do not return provider bodies, URLs, tokens, credentials, or exception text.
    return { ok: false, errorCode: "SAV_GMAIL_PERMISSIONS_CHECK_FAILED" };
  }
}
