import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { JOURNEY_CASES, journeyId } from "../../test/sav-journey-fixture";
import { submitServerAction } from "../helpers/server-action";
const statePath = ".e2e-journey-provider.json";
function remote() { return JSON.parse(readFileSync(statePath, "utf8")); }
for (const key of JOURNEY_CASES) {
  test(`${key}: review → preview → confirmed result → draft → supervised synthetic send → inbox`, async ({ page, baseURL }, testInfo) => {
    const external: string[] = [], errors: string[] = [], started = Date.now();
    let clicks = 0;
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin !== baseURL) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`/studio/sav/${journeyId(key)}?returnTo=${encodeURIComponent("/studio/sav?view=to_validate&q=journey")}`);
    const review = page.getByRole("form", { name: "Proposition de l’IA", exact: true });
    const draft = page.getByRole("region", { name: "Verdict du brouillon", exact: true });
    const execution = page.getByLabel("Exécution de l’action", { exact: true });
    const prepare = execution.getByRole("button", { name: "Préparer l’aperçu de l’action", exact: true });
    await expect(prepare).toBeDisabled();
    await expect(draft.getByRole("button", { name: "Envoyer la réponse acceptée", exact: true })).toBeDisabled();
    if (key !== "create") {
      await review.getByRole("radiogroup", { name: "Ticket concerné", exact: true }).getByRole("radio").check(); clicks++;
    }
    await review.locator('input[type="checkbox"][required]').check(); clicks++;
    await submitServerAction(page, review.getByRole("button", { name: "Valider le dossier", exact: true })); clicks++;
    await page.waitForURL(/review=saved/);
    expect(remote().events).not.toContainEqual(expect.objectContaining({ contactId: remote().cases[key].contactId }));
    await expect(prepare).toBeEnabled();
    const eventsBeforePreview = remote().events.length;
    await submitServerAction(page, prepare); clicks++;
    const preview = execution.getByRole("region", { name: "Aperçu de l’action HubSpot", exact: true });
    await expect(preview).toBeVisible();
    const countBeforeConfirm = remote().events.length;
    expect(countBeforeConfirm).toBe(eventsBeforePreview);
    await submitServerAction(page, preview.getByRole("button", { name: /^Confirmer :/ })); clicks++;
    if (key === "retry") {
      await expect(execution).toContainText("HubSpot refuse l’accès");
      await expect(prepare).toBeEnabled(); // No full document reload needed after a definite rejection.
      const state = remote(); state.cases.retry.fault = null; writeFileSync(statePath, JSON.stringify(state));
      await submitServerAction(page, prepare); clicks++;
      await expect(preview).toBeVisible();
      await submitServerAction(page, preview.getByRole("button", { name: /^Confirmer :/ })); clicks++;
    }
    if (key === "uncertain") {
      await expect(execution).toContainText("Retour à vérifier dans HubSpot");
      await expect(prepare).toBeDisabled();
      const before = remote().events.length;
      await page.reload();
      await expect(prepare).toBeDisabled();
      expect(remote().events.length).toBe(before);
    } else {
      await expect(execution).toContainText("Action déjà traitée pour cet email");
      await page.reload();
      await expect(execution).toContainText("Action déjà traitée pour cet email");
      if (key === "link") await expect(page.getByRole("link", { name: /Échec export PDF fictif/ }).first()).toHaveAttribute("href", /ticket\/991002$/);
      const state = remote(), ticketId = state.cases[key].ticketId;
      const creates = state.events.filter((e: {kind:string;contactId?:string}) => e.kind === "create" && e.contactId === state.cases[key].contactId);
      const notes = state.events.filter((e: {kind:string;ticketId?:string}) => e.kind === "note" && e.ticketId === ticketId);
      expect(creates).toHaveLength(["create", "successor"].includes(key) ? 1 : 0);
      expect(notes).toHaveLength(["waiting", "reopen", "retry"].includes(key) ? 1 : 0);
      if (["waiting", "reopen", "retry"].includes(key)) expect(state.tickets[ticketId].properties).toMatchObject({ hs_pipeline_stage: "1", hubspot_owner_id: "999201" });
      await expect(draft.getByRole("button", { name: "Envoyer la réponse acceptée", exact: true })).toBeDisabled();
      const corrected = "Bonjour,\n\nPouvez-vous nous transmettre le message d’erreur exact de l’export PDF ? Nous avons bien noté votre nouvel essai.\n\nMerci pour votre aide.";
      await draft.getByRole("textbox", { name: "Corriger le brouillon", exact: true }).fill(corrected);
      await expect(draft.getByRole("button", { name: "Accepter cette version", exact: true })).toBeDisabled();
      await submitServerAction(page, draft.getByRole("button", { name: "Enregistrer ma version", exact: true })); clicks++;
      await page.waitForURL(/review=draft_saved/);
      await page.reload();
      await expect(draft.getByRole("textbox", { name: "Corriger le brouillon", exact: true })).toHaveValue(corrected);
      await submitServerAction(page, draft.getByRole("button", { name: "Accepter cette version", exact: true })); clicks++;
      await page.waitForURL(/review=draft_reviewed/);
      await expect(draft.getByRole("button", { name: "Envoyer la réponse acceptée", exact: true })).toBeEnabled();
      await submitServerAction(page, draft.getByRole("button", { name: "Envoyer la réponse acceptée", exact: true })); clicks++;
      await page.waitForURL(/review=reply_sent/);
      await expect(draft).toContainText("Réponse déjà envoyée");
      const sends = remote().events.filter((e: {kind:string;threadId?:string}) => e.kind === "send" && e.threadId === `journey-${key}`);
      expect(sends).toHaveLength(1);
      const mime = Buffer.from(sends[0].raw, "base64url").toString("utf8").replace(/\r\n/g, "\n");
      expect(mime).toContain(`To: journey-${key}@example.invalid`);
      expect(mime).toContain(corrected);
      expect(mime).toContain("L’équipe Limova");
      expect(mime).not.toContain("envoyée automatiquement");
      expect(mime).not.toContain("validée par notre équipe");
      expect(mime).toContain(`In-Reply-To: <journey-${key}@example.invalid>`);
      await page.reload();
      await expect(draft.getByRole("button", { name: "Envoyer la réponse acceptée", exact: true })).toBeDisabled();
    }
    await page.getByRole("link", { name: "← Retour aux dossiers", exact: true }).click(); clicks++;
    await expect(page).toHaveURL(/view=to_validate.*q=journey/);
    expect(external).toEqual([]); expect(errors).toEqual([]);
    expect(existsSync(".e2e-journey-blocked.log") ? readFileSync(".e2e-journey-blocked.log", "utf8") : "").toBe("");
    await testInfo.attach("measurements", { body: JSON.stringify({ scenario:key, elapsedMs:Date.now()-started, scriptedClicks:clicks, manualThinkTimeMeasured:false, modelQualityEvaluated:false }), contentType:"application/json" });
  });
}
