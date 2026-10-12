import {test,expect} from "@playwright/test";
test("dossier and readonly draft have independent verdicts with no external send",async({page},testInfo)=>{
 const external:string[]=[];page.on("request",req=>{if(!req.url().startsWith("http://127.0.0.1:3013"))external.push(req.url());});
 await page.goto("/studio/sav");await page.getByRole("button",{name:/Démo — retrouver mes factures/}).click();
 await expect(page.getByRole("heading",{name:"Verdict du brouillon"})).toBeVisible();expect(await page.locator('textarea[name="replyDraft"]').count()).toBe(0);
 const draft=page.locator('section[aria-labelledby="draft-review-title"] pre').first();const text=await draft.textContent();
 await page.getByRole("button",{name:"Valider le dossier / process",exact:true}).click();await expect(page.getByText("Revue enregistrée.",{exact:false})).toBeVisible();
 await page.getByRole("button",{name:"Refuser le brouillon",exact:true}).click();await expect(page.getByText("Brouillon refusé · traitement humain à observer.",{exact:true})).toBeVisible();
 await expect(page.getByText("En attente de ticket confirmé · cycle 1",{exact:true}).first()).toBeVisible();
 await expect(page.getByRole("button",{name:"Créer un ticket HubSpot",exact:true})).toBeEnabled();await expect(page.getByRole("button",{name:"Envoyer la réponse acceptée",exact:true})).toBeDisabled();expect(await draft.textContent()).toBe(text);
 await page.getByRole("button",{name:"Accepter le brouillon",exact:true}).click();await expect(page.getByText("Brouillon accepté · envoi distinct à confirmer.",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Envoyer la réponse acceptée",exact:true})).toBeDisabled();expect(external).toEqual([]);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
 await page.screenshot({path:testInfo.outputPath("sav-38.png"),fullPage:true});
});
test("sourced human bilan requires Ugo qualification and produces a pending candidate",async({page},testInfo)=>{
 await page.goto("/studio/sav");await page.getByRole("button",{name:/Démo — email non reconnu/}).click();
 await expect(page.getByRole("heading",{name:"Journal du suivi"})).toBeVisible();await expect(page.getByText(/^(Clôturé · bilan à qualifier|Candidat prêt · revue séparée requise) · cycle 1$/)).toBeVisible();
 await expect(page.getByText("Une tâche terminée n’atteste pas une opération exécutée.",{exact:false})).toBeVisible();
 await page.locator('select[name="outcome"]').selectOption("resolved");await page.locator('select[name="evidence"]').selectOption({index:1});
 await page.getByRole("textbox",{name:"Justification d’Ugo",exact:true}).fill("Recette fictive : preuve humaine spécifique vérifiée et parcours générique à relire.");await page.locator('textarea[name="resolution"]').fill("Démo fictive : retrouvez votre email de bienvenue puis ouvrez la page de connexion. Ce parcours doit être vérifié avant toute publication.");await page.locator('input[name="unconfirmedAcknowledged"]').check();
 await page.getByRole("button",{name:"Qualifier le bilan",exact:true}).click();await expect(page.getByText("Bilan qualifié. Aucune connaissance publiée.",{exact:true})).toBeVisible();await expect(page.getByText("Candidat prêt · revue séparée requise · cycle 1",{exact:true})).toBeVisible();
 await page.screenshot({path:testInfo.outputPath("sav-39.png"),fullPage:true});
});
