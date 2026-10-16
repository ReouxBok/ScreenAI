import {expect,test} from "@playwright/test";
import {SAV53_THREADS} from "../../test/sav53-e2e-fixture";
async function submit(page: import("@playwright/test").Page, button: import("@playwright/test").Locator) {
 const origin=new URL(page.url()).origin;
 const marker=await button.evaluate(element=>{
  const form=element.closest("form")!;
  return form.querySelector('[name="humanProcess"]') ? 'humanProcess' : form.querySelector('[name="expectedDraftId"]') ? 'expectedDraftId' : 'sourceHash';
 });
 const [response]=await Promise.all([page.waitForResponse(r=>r.request().method()==="POST" && new URL(r.url()).origin===origin && Boolean(r.request().headers()["next-action"]) && Boolean(r.request().postDataBuffer()?.includes(Buffer.from(marker))),{timeout:120000}),button.click()]);
 await response.finished();
}
test.beforeEach(async({page,baseURL})=>{await page.route("**/*",route=>new URL(route.request().url()).origin===baseURL?route.continue():route.abort());});
test("human draft remains usable after identical process revalidation",async({page})=>{
 await page.goto(`/studio/sav/${SAV53_THREADS.singlePlain}`);
 const process=page.getByRole("region",{name:"Correction humaine du process",exact:true});
 await process.getByLabel("Action à préparer").selectOption("no_ticket");
 await process.getByLabel("Justification du choix").fill("La demande ne nécessite aucun ticket, vérifiée humainement.");
 await process.getByRole("checkbox",{name:/J’ai vérifié/}).check();
 const validate=page.getByRole("button",{name:"Valider le dossier / process",exact:true});
 await submit(page,validate);await expect(page).toHaveURL(/review=saved/);
 const draft=page.getByRole("region",{name:"Verdict du brouillon",exact:true});
 await draft.getByLabel("Corriger le brouillon").fill("Bonjour, voici ma réponse humaine vérifiée pour cette demande.");
 await submit(page,draft.getByRole("button",{name:"Enregistrer ma version",exact:true}));
 await expect(draft.getByRole("button",{name:"Accepter cette version",exact:true})).toBeEnabled();
 await process.getByRole("checkbox",{name:/J’ai vérifié/}).check();
 await submit(page,validate);await expect(process).toBeVisible();
 await expect(draft.getByRole("button",{name:"Accepter cette version",exact:true})).toBeDisabled();
 await submit(page,draft.getByRole("button",{name:"Enregistrer ma version",exact:true}));
 await expect(draft.getByRole("button",{name:"Accepter cette version",exact:true})).toBeEnabled();
 await submit(page,draft.getByRole("button",{name:"Accepter cette version",exact:true}));
 await expect(draft).toContainText("Brouillon accepté");
 await expect(draft.getByRole("button",{name:"Envoyer la réponse acceptée",exact:true})).toBeDisabled();

});
test("human request and process step controls persist through reload",async({page})=>{
 await page.goto(`/studio/sav/${SAV53_THREADS.singleQuoted}`);
 const editor=page.getByRole("region",{name:"Correction humaine du process",exact:true});
 await editor.getByLabel("Action à préparer").selectOption("no_ticket");
 const request=editor.getByRole("group",{name:"Demande 1"});
 await request.getByRole("textbox").nth(0).fill("Demande corrigée pour la connexion de mon outil");
 await request.getByRole("textbox").nth(1).fill("Produit fictif corrigé");
 await editor.getByRole("button",{name:"Ajouter une étape",exact:true}).click();
 await editor.getByRole("group",{name:"Étape 2"}).getByRole("textbox").fill("Vérifier la procédure humaine corrigée");
 await editor.getByLabel("Justification du choix").fill("Pas de ticket requis pour cette demande qualifiée par un humain.");
 await editor.getByRole("checkbox",{name:/J’ai vérifié/}).check();
 await submit(page,page.getByRole("button",{name:"Valider le dossier / process",exact:true}));await expect(page).toHaveURL(/review=saved/);await page.reload();
 await expect(editor.getByRole("group",{name:"Demande 1"}).getByRole("textbox").nth(0)).toHaveValue("Demande corrigée pour la connexion de mon outil");
 await expect(editor.getByRole("group",{name:"Demande 1"}).getByRole("textbox").nth(1)).toHaveValue("Produit fictif corrigé");
 await expect(editor.getByRole("group",{name:"Étape 2"}).getByRole("textbox")).toHaveValue("Vérifier la procédure humaine corrigée");
});
