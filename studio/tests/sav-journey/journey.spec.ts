import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { JOURNEY_CASES, journeyId } from "../../test/sav-journey-fixture";
import { warmSavJourneyRoutes } from "../helpers/journey-warmup";
import { submitServerAction } from "../helpers/server-action";
test.beforeAll(warmSavJourneyRoutes);
const statePath = ".e2e-journey-provider.json";
function remote() { return JSON.parse(readFileSync(statePath, "utf8")); }
for (const key of JOURNEY_CASES) {
  // SAV-60 (decided by Ugo): the V0 dossier no longer sends the suggested reply (A09 retired) and no longer refreshes the CRM
  // context. The review, the HubSpot preview and its confirmed result remain; the reply part now proves that nothing is sent.
  test(`${key}: review → preview → confirmed result → draft kept, no send from the retired circuit → inbox`, async ({ page, baseURL }, testInfo) => {
    const external: string[] = [], errors: string[] = [], started = Date.now();
    let clicks = 0;
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin !== baseURL) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`/studio/sav/${journeyId(key)}?returnTo=${encodeURIComponent("/studio/sav?view=to_validate&q=journey")}`);
    if(key==="create") {
      await expect(page.getByText("Ce mail a été traduit de l’anglais.",{exact:false})).toBeVisible();
      await expect(page.locator(".sav-message pre").first()).toContainText("Bonjour, mon export PDF");
      await page.getByRole("button",{name:"Voir l’original",exact:true}).click();
      await expect(page.locator(".sav-message pre").first()).toContainText("Hello, my PDF export");
      await page.getByRole("button",{name:"Voir la traduction",exact:true}).click();
      await expect(page.locator(".sav-message pre").first()).toContainText("ERR_42");
    }
    if(key==="link") {
      await expect(page.getByText("Original affiché · traduction partielle non affichée.",{exact:true})).toBeVisible();
      await expect(page.locator("#sav-draft").getByRole("textbox",{name:"Suggestion de réponse",exact:true})).not.toHaveValue("Ancienne version humaine périmée.");
      // The outbound preview carrying the AI mention left with the send form; the V2 reply contract owns that mention now.
      await expect(page.locator("#sav-draft").locator('input[name="outboundHash"], input[name="recipient"]')).toHaveCount(0);
    }
    if(key==="waiting") await expect(page.getByText("Ce mail a été traduit",{exact:false})).toHaveCount(0);
    if(key==="create")await page.screenshot({path:testInfo.outputPath("sav86-translation-original.png"),fullPage:true});
    const review = page.getByRole("form", { name: "Proposition de l’IA", exact: true });
    const draft = page.locator("#sav-draft");
    const execution = page.getByLabel("Exécution de l’action", { exact: true });
    const prepare = execution.getByRole("button", { name: "Préparer l’aperçu de l’action", exact: true });
    await expect(prepare).toBeDisabled();
    const noSend = async () => {
      await expect(draft.getByRole("button", { name: "Confirmer l’envoi de cette réponse", exact: true })).toHaveCount(0);
      await expect(draft.getByRole("status").filter({ hasText: "Ancien circuit retiré : aucun envoi depuis ce dossier." })).toBeVisible();
      expect(remote().events.filter((e: {kind:string;threadId?:string}) => e.kind === "send" && e.threadId === `journey-${key}`)).toEqual([]);
    };
    await noSend();
    const notice = page.getByRole("status").filter({ hasText: "Ancien circuit retiré." });
    await expect(notice.getByRole("link", { name: "l’archive", exact: true })).toHaveAttribute("href", `/studio/sav/archives/${journeyId(key)}`);
    if (key !== "create") {
      await review.getByRole("radiogroup", { name: "Ticket concerné", exact: true }).getByRole("radio").check(); clicks++;
    }
    await review.locator('input[type="checkbox"][required]').check(); clicks++;
    await submitServerAction(page, review.getByRole("button", { name: "Valider le dossier", exact: true })); clicks++;
    await page.waitForURL(/review=saved/);
    expect(remote().events).not.toContainEqual(expect.objectContaining({ contactId: remote().cases[key].contactId }));
    await expect(prepare).toBeEnabled();
    const eventsBeforePreview = remote().events.length;
    await submitServerAction(page, prepare, /"distinctIssueReason":/); clicks++;
    const preview = execution.getByRole("region", { name: "Aperçu de l’action HubSpot", exact: true });
    await expect(preview).toBeVisible();
    const countBeforeConfirm = remote().events.length;
    expect(countBeforeConfirm).toBe(eventsBeforePreview);
    await submitServerAction(page, preview.getByRole("button", { name: /^Confirmer :/ }), /^\["v1\./); clicks++;
    if (key === "retry") {
      await expect(execution).toContainText("HubSpot refuse l’accès");
      // Cold CI renders the refresh response in14.7s after the definite403.
      // Still require recovery without a document reload and every action/send assertion.
      await expect(prepare).toBeEnabled({ timeout: 30_000 });
      const state = remote(); state.cases.retry.fault = null; writeFileSync(statePath, JSON.stringify(state));
      await submitServerAction(page, prepare, /"distinctIssueReason":/); clicks++;
      await expect(preview).toBeVisible();
      await submitServerAction(page, preview.getByRole("button", { name: /^Confirmer :/ }), /^\["v1\./); clicks++;
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
      if (key === "create" || key === "successor") {
        const created = state.tickets[creates[0].ticketId];
        for (const type of ["calls", "emails", "notes", "meetings", "tasks"]) {
          const expected = state.activities[type].filter((activity: { contactId: string }) => activity.contactId === state.cases[key].contactId).map((activity: { id: string }) => activity.id);
          expect(expected).toHaveLength(1);
          expect(created.associations[type].results.map((activity: { id: string }) => activity.id)).toEqual(expected);
        }
      }
      expect(notes).toHaveLength(["waiting", "reopen", "retry"].includes(key) ? 1 : 0);
      if (["waiting", "reopen", "retry"].includes(key)) expect(state.tickets[ticketId].properties).toMatchObject({ hs_pipeline_stage: "1", hubspot_owner_id: "999201" });
      const corrected = key === "create" ? "Hello, please send us the exact PDF export error message. We have noted your new attempt." : "Bonjour,\n\nPouvez-vous nous transmettre le message d’erreur exact de l’export PDF ? Nous avons bien noté votre nouvel essai.\n\nMerci pour votre aide.";
      // The human version can still be edited and saved (A06 kept); saving sends nothing and needs no acceptance step.
      const textbox = draft.getByRole("textbox", { name: "Suggestion de réponse", exact: true });
      await textbox.fill(corrected);
      await expect(draft.getByRole("button", { name: "Accepter cette version", exact: true })).toHaveCount(0);
      await submitServerAction(page, draft.getByRole("button", { name: "Enregistrer ma version", exact: true })); clicks++;
      await page.waitForURL(/review=draft_saved/);
      await page.reload();
      await expect(textbox).toHaveValue(corrected);
      await expect(draft).not.toContainText("Réponse déjà envoyée");
      await noSend();
      expect(remote().events.filter((e: {kind:string}) => e.kind === "send")).toEqual([]);
      if(key==="create")await page.screenshot({path:testInfo.outputPath("sav86-draft-kept-no-send.png"),fullPage:true});
    }
    await page.getByRole("link", { name: "← Retour aux dossiers", exact: true }).click(); clicks++;
    await expect(page).toHaveURL(/view=to_validate.*q=journey/, { timeout: 60_000 });
    expect(external).toEqual([]); expect(errors).toEqual([]);
    expect(existsSync(".e2e-journey-blocked.log") ? readFileSync(".e2e-journey-blocked.log", "utf8") : "").toBe("");
    await testInfo.attach("measurements", { body: JSON.stringify({ scenario:key, elapsedMs:Date.now()-started, scriptedClicks:clicks, manualThinkTimeMeasured:false, modelQualityEvaluated:false }), contentType:"application/json" });
  });
}
