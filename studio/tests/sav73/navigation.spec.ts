import { expect, test } from "@playwright/test";
import { SAV53_THREADS } from "../../test/sav53-e2e-fixture";
test.beforeEach(async ({ page, baseURL }) => {
  await page.route("**/*", route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
});
test("search, sort, pagination and browser history navigate without a document reload",async({page})=>{
  await page.goto("/studio/sav");
  await expect(page.getByRole("navigation",{name:"Pagination",exact:true})).toContainText("Page 1 sur 2");
  await page.evaluate(()=>{(window as unknown as {sav73Document:string}).sav73Document="same-document";});
  await page.getByLabel("Rechercher un dossier").fill("Pagination synthétique");
  await page.getByRole("button",{name:"Rechercher",exact:true}).click();
  await expect(page).toHaveURL(/q=Pagination/);
  await expect(page.getByRole("navigation",{name:"Pagination",exact:true})).toContainText("30 dossiers");
  await page.getByRole("link",{name:"Suivante →",exact:true}).click();
  await expect(page.getByRole("navigation",{name:"Pagination",exact:true})).toContainText("Page 2 sur 2");
  expect(await page.evaluate(()=>(window as unknown as {sav73Document:string}).sav73Document)).toBe("same-document");
  await page.goBack({waitUntil:"commit",timeout:15000});
  await expect(page.getByRole("navigation",{name:"Pagination",exact:true})).toContainText("Page 1 sur 2");
  await page.getByRole("combobox").selectOption("oldest");
  await page.getByRole("button",{name:"Rechercher",exact:true}).click();
  await expect(page).toHaveURL(/sort=oldest/);
  await page.getByLabel("Rechercher un dossier").fill("aucune-correspondance-synthétique");
  await page.getByRole("button",{name:"Rechercher",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Aucun dossier ne correspond à cette recherche"})).toBeVisible();
  await page.goBack({waitUntil:"commit",timeout:15000});
  await expect(page.getByLabel("Rechercher un dossier")).toHaveValue("Pagination synthétique");
  expect(await page.evaluate(()=>(window as unknown as {sav73Document:string}).sav73Document)).toBe("same-document");
});
// SAV-60 (decided by Ugo): the V0 list opens a dossier as a plain link. Opening records nothing (no Gmail filing command, no
// "Ouverture enregistrée", no POST) and the dossier announces the retired circuit with its read-only archive.
test("explicit opening is a plain link: the dossier renders, records nothing and points to its archive",async({page})=>{
  const posts:string[]=[], filingPolls:string[]=[];
  page.on("request",request=>{ if(request.method()!=="GET") posts.push(`${request.method()} ${new URL(request.url()).pathname}`); if(/[?&]filingId=/.test(request.url())) filingPolls.push(request.url()); });
  await page.goto("/studio/sav?q=Échec+export+PDF+fictif");
  const row=page.locator(`#dossier-${SAV53_THREADS.singleQuoted}`);
  await expect(row.getByRole("button")).toHaveCount(0);
  const openedAt = Date.now();
  // The row itself is the link (no button, no server action behind it).
  await expect(row).toHaveAttribute("aria-label",/^Ouvrir le dossier : /);
  await expect(row).toHaveAttribute("href",new RegExp(`^/studio/sav/${SAV53_THREADS.singleQuoted}\\?returnTo=`));
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/studio/sav/${SAV53_THREADS.singleQuoted}(?:[?#]|$)`));
  await expect(page).not.toHaveURL(/filing=|filingId=|context=|refreshId=/);
  const notice=page.getByRole("status").filter({hasText:"Ancien circuit retiré."});
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("link",{name:"l’archive",exact:true})).toHaveAttribute("href",`/studio/sav/archives/${SAV53_THREADS.singleQuoted}`);
  await expect(page.getByRole("status").filter({hasText:"Ouverture enregistrée"})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Valider le dossier",exact:true})).toBeAttached();
  await test.info().attach("opening-timing", { body: JSON.stringify({ clickToDossierMs: Date.now()-openedAt, mode:"local-development-auth-bypass", openingRecorded:false }), contentType:"application/json" });
  await page.evaluate(()=>window.scrollTo(0,600));
  const before=await page.evaluate(()=>window.scrollY);
  await page.waitForLoadState("networkidle");
  await expect.poll(async()=>Math.abs(await page.evaluate(()=>window.scrollY)-before)).toBeLessThan(4);
  expect(posts).toEqual([]); expect(filingPolls).toEqual([]);
  await page.screenshot({ path:test.info().outputPath("dossier-opened.png") });
});
test("dossier transition immediately exposes a loading state while server data is delayed",async({page})=>{
  await page.goto(`/studio/sav/${SAV53_THREADS.singleQuoted}?returnTo=${encodeURIComponent("/studio/sav?view=to_process&q=loading")}`);
  await expect(page.getByRole("heading",{level:1})).toBeVisible();
  let release!:()=>void;
  const responseGate=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/studio/sav?*",async route=>{
    const response=await route.fetch();
    await responseGate;
    await route.fulfill({response});
  });
  const link=page.getByRole("link",{name:/Retour/}).first();
  // Route transitions use the cached route loading shell; no artificial delay
  // is added to application code.
  const clickedAt = Date.now();
  await link.click();
  await expect(page.getByRole("status").filter({hasText:"Chargement des dossiers"})).toBeVisible();
  await test.info().attach("loading-timing", { body:JSON.stringify({ clickToIndicatorMs:Date.now()-clickedAt, mode:"local-development-delayed-destination" }), contentType:"application/json" });
  release();
  await expect(page.getByRole("heading",{name:"Piloter les demandes",exact:true})).toBeVisible();
});
