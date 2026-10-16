import { submitServerAction } from "../helpers/server-action";
import {test,expect} from "@playwright/test";
test("une demande financière reste sans brouillon ni envoi après validation du dossier",async({page},testInfo)=>{
 const external:string[]=[];page.on("request",req=>{if(!req.url().startsWith("http://127.0.0.1:3013"))external.push(req.url());});
 await page.goto("/studio/sav");await submitServerAction(page, page.getByRole("button",{name:/Démo — retrouver mes factures/}));await page.waitForURL(/\/studio\/sav\/[0-9a-f-]+\?/);
 await expect(page.getByRole("heading",{name:"Verdict du brouillon"})).toBeVisible();expect(await page.locator('textarea[name="replyDraft"]').count()).toBe(0);
 const draft=page.getByRole("region",{name:"Verdict du brouillon",exact:true});
 const dossier=page.getByRole("region",{name:"Proposition de l’IA",exact:true});
 const prepare=page.getByRole("button",{name:"Préparer l’aperçu de l’action",exact:true});
 const crmUnavailable=page.getByRole("alert").filter({hasText:"Le contexte HubSpot est indisponible ou incomplet. Actualisez-le avant de choisir une action."});
 // The historical billing fixture has no semantic understanding: its draft
 // is forbidden. Independent dossier approval and draft refusal are covered by the PDF
 // semantic fixture; never invent a financial draft to exercise those buttons.
 await expect(draft).toContainText("Non applicable : aucun brouillon à accepter ou envoyer.");
 await expect(draft.locator("pre").first()).toHaveText("Aucun brouillon autorisé pour cette demande. Traitement humain via le ticket.");
 for(const name of ["Accepter le brouillon","Refuser le brouillon","Envoyer la réponse acceptée"]) await expect(page.getByRole("button",{name,exact:true})).toHaveCount(0);
 await expect(prepare).toBeDisabled();
 const process=dossier.getByRole("region",{name:"Correction humaine du process",exact:true});
 const processConfirmation=process.getByRole("checkbox",{name:/J’ai vérifié la demande et le choix d’action/});
 await expect(processConfirmation).toHaveAttribute("required");await expect(processConfirmation).not.toBeChecked();await processConfirmation.check();
 await submitServerAction(page, page.getByRole("button",{name:"Valider le dossier / process",exact:true}));await page.waitForURL(/review=saved/);await expect(page.getByText("Revue enregistrée.",{exact:false})).toBeVisible();
 await expect(dossier).toContainText("Process validé par ugo@limova.ai");await expect(crmUnavailable).toBeVisible();await expect(prepare).toBeDisabled();
 for(const name of ["Accepter le brouillon","Refuser le brouillon","Envoyer la réponse acceptée"]) await expect(page.getByRole("button",{name,exact:true})).toHaveCount(0);
 await expect(page.getByRole("region",{name:"Aperçu de l’action HubSpot",exact:true})).toHaveCount(0);
 await page.reload();
 await expect(dossier).toContainText("Process validé par ugo@limova.ai");await expect(crmUnavailable).toBeVisible();await expect(prepare).toBeDisabled();
 await expect(draft).toContainText("Non applicable : aucun brouillon à accepter ou envoyer.");
 await expect(draft.locator("pre").first()).toHaveText("Aucun brouillon autorisé pour cette demande. Traitement humain via le ticket.");
 await expect(page.locator('textarea[name="replyDraft"]')).toHaveCount(0);
 for(const name of ["Accepter le brouillon","Refuser le brouillon","Envoyer la réponse acceptée"]) await expect(page.getByRole("button",{name,exact:true})).toHaveCount(0);
 await expect(page.getByText("Aucun ticket lié à ce dossier.",{exact:true})).toBeVisible();
 await expect(page.getByRole("region",{name:"Aperçu de l’action HubSpot",exact:true})).toHaveCount(0);
 expect(external).toEqual([]);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
 await page.screenshot({path:testInfo.outputPath("sav-v0-financial-no-draft.png"),fullPage:true});
});
test("sourced human bilan requires Ugo qualification and produces a pending candidate",async({page},testInfo)=>{
 await page.goto("/studio/sav");await submitServerAction(page, page.getByRole("button",{name:/Démo — email non reconnu/}));await page.waitForURL(/\/studio\/sav\/[0-9a-f-]+\?/);
 await expect(page.getByRole("heading",{name:"Journal du suivi"})).toBeVisible();await expect(page.getByText(/^(Clôturé · bilan à qualifier|Candidat prêt · revue séparée requise) · cycle 1$/)).toBeVisible();
 await expect(page.getByText("Une tâche terminée n’atteste pas une opération exécutée.",{exact:false})).toBeVisible();
 await page.locator('select[name="outcome"]').selectOption("resolved");await page.locator('select[name="evidence"]').selectOption({index:1});
 await page.getByRole("textbox",{name:"Justification d’Ugo",exact:true}).fill("Recette fictive : preuve humaine spécifique vérifiée et parcours générique à relire.");await page.locator('textarea[name="resolution"]').fill("Démo fictive : retrouvez votre email de bienvenue puis ouvrez la page de connexion. Ce parcours doit être vérifié avant toute publication.");await page.locator('input[name="unconfirmedAcknowledged"]').check();
 await submitServerAction(page, page.getByRole("button",{name:"Qualifier le bilan",exact:true}));await expect(page.getByText("Bilan qualifié. Aucune connaissance publiée.",{exact:true})).toBeVisible();await expect(page.getByText("Candidat prêt · revue séparée requise · cycle 1",{exact:true})).toBeVisible();
 await page.screenshot({path:testInfo.outputPath("sav-39.png"),fullPage:true});
});
