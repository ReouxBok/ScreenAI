import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/studio");
  await expect(page).toHaveURL(/\/studio$/);
}

async function createArticle(page: import("@playwright/test").Page, suffix = "") {
  await page.goto("/studio/contenus/nouveau?type=article");
  await page.getByRole("textbox",{name:"Titre",exact:true}).fill("Connecter Gmail E2E");
  await page.getByLabel("Slug stable").fill(`connecter-gmail-e2e${suffix ? `-${suffix}` : ""}`);
  await page.getByLabel("Résumé").fill("Guide de connexion Gmail testé de bout en bout.");
  await page.getByLabel("Intentions / signaux").fill("connecter gmail\nconfigurer email");
  await page.getByLabel("Pages Limova").fill("/integrations");
  await page.getByLabel("Agent concerné").selectOption("charly");
  await page.locator(".tiptap").fill("## Connexion Gmail\n\nOuvrez le catalogue des intégrations puis cliquez sur Gmail E2E.");
  await page.getByLabel("Commentaire de modification").fill("Création E2E du guide Gmail");
  await page.getByRole("button",{name:"Enregistrer le brouillon"}).click();
  await expect(page).toHaveURL(/\/studio\/contenus\/[0-9a-f-]+$/);
}

async function enableAiForTitle(page: import("@playwright/test").Page, title: string) {
  await page.goto("/studio/contenus");
  const row = page.locator(".content-library-row").filter({hasText:title}).first();
  const toggle = row.getByRole("switch",{name:"Agent IA"});
  await expect(toggle).toHaveAttribute("aria-checked","false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked","true");
}

async function passRealEvaluation(page: import("@playwright/test").Page, request: import("@playwright/test").APIRequestContext) {
  const prepare = page.getByRole("button", { name: "Préparer le test complet" });
  const critical = page.locator(".evaluation-case").filter({ hasText: "Obligatoire" }).first();
  if (await critical.count() === 0) {
    await expect(prepare).toBeVisible();
    await prepare.click();
  }
  await expect(page.locator(".evaluation-case")).toHaveCount(1);
  await critical.getByRole("button", { name: /Tester le flow complet|Retester le flow complet/ }).click();
  const token = (await page.locator(".evaluation-code code").textContent())?.trim();
  expect(token).toBeTruthy();
  const headers = { Authorization: `Bearer ${token}` };
  const connected = await request.post("/api/evaluations/runs/connect", { headers, data: { extensionVersion: "e2e" } });
  expect(connected.ok()).toBe(true);
  for (const event of [
    { kind: "tool_result", toolName: "click_element", status: "ok", path: "/power-ups", contextVersion: 2 },
    { kind: "tool_result", toolName: "verify_expected_result", status: "ok", path: "/power-ups", contextVersion: 3 },
    { kind: "response", status: "ok", path: "/power-ups", contextVersion: 3 },
  ]) expect((await request.post("/api/evaluations/runs/events", { headers, data: event })).ok()).toBe(true);
  const completed = await request.post("/api/evaluations/runs/complete", { headers, data: { verdict: "correct" } });
  expect(completed.ok()).toBe(true);
  expect((await completed.json()).run).toMatchObject({ status: "passed", score: 100 });
  await page.reload();
  await expect(page.getByText("Prêt pour la review")).toBeVisible();
}

async function createPublishedOnboarding(page: import("@playwright/test").Page, request: import("@playwright/test").APIRequestContext, suffix: string, title: string) {
  await page.goto("/studio/contenus/nouveau?type=onboarding");
  await page.getByRole("textbox",{name:"Titre",exact:true}).fill(title);
  await page.getByLabel("Slug stable").fill(`onboarding-template-${suffix}`);
  await page.getByLabel("Résumé").fill(`Parcours publié pour ${title}.`);
  await page.getByLabel("Intentions / signaux").fill(title.toLocaleLowerCase("fr"));
  await page.getByLabel("Pages Limova").fill("/power-ups");
  await page.locator('input[name="objective"]').fill(title);
  await page.getByLabel("Critères de réussite").fill(`${title} terminé`);
  await page.locator(".tiptap").fill(`## ${title}\n\nAccompagner le membre étape par étape.`);
  await page.getByLabel("Commentaire de modification").fill("Création pour la trame E2E");
  await page.getByRole("button",{name:"Enregistrer le brouillon"}).click();
  await passRealEvaluation(page, request);
  await page.getByRole("button",{name:"Demander la validation"}).click();
  await page.getByRole("button",{name:"Valider et publier"}).click();
  await expect(page.getByText("Publié",{exact:true}).first()).toBeVisible();
  await enableAiForTitle(page,title);
}

test("une base publiée vide retourne immédiatement kb_empty", async ({ request }) => {
  const response = await request.post("/api/internal/knowledge/search", {
    headers: { Authorization: "Bearer e2e-service-token-that-is-at-least-32-characters" },
    data: { query: "Question sans contenu publié", path: "/", locale: "fr-FR", limit: 5 },
  });
  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toMatchObject({ revision: "kb_empty", results: [] });
});

test("workflow complet, recherche Charly, rollback et archivage",async({page,request})=>{
  await login(page);
  await createArticle(page);
  await expect(page.getByText("Brouillon",{exact:true}).first()).toBeVisible();
  await page.getByRole("button",{name:"Demander la validation"}).click();
  await expect(page.getByRole("button",{name:"Valider et publier"})).toBeVisible();
  await page.getByRole("button",{name:"Valider et publier"}).click();
  await expect(page.getByText("Publié",{exact:true}).first()).toBeVisible();
  await enableAiForTitle(page,"Connecter Gmail E2E");

  const search=await request.post("/api/internal/knowledge/search",{headers:{Authorization:"Bearer e2e-service-token-that-is-at-least-32-characters"},data:{query:"Comment connecter Gmail ?",path:"/integrations",locale:"fr-FR",contentTypes:["article"],limit:5}});
  expect(search.ok()).toBe(true);
  const payload=await search.json();
  expect(payload.revision).toMatch(/^kb_/);
  expect(payload.results[0]).toMatchObject({title:"Connecter Gmail E2E",source:"connecter-gmail-e2e"});

  await page.goto(`/studio/contenus/${payload.results[0].id}`);
  await page.getByLabel("Résumé").fill("Guide Gmail mis à jour en E2E.");
  await page.locator(".tiptap").fill("## Connexion Gmail\n\nCette version deux remplace la procédure initiale.");
  await page.getByLabel("Commentaire de modification").fill("Deuxième version E2E");
  await page.getByRole("button",{name:"Enregistrer la mise à jour"}).click();
  await page.getByRole("button",{name:"Demander la validation"}).click();
  await page.getByRole("button",{name:"Valider et publier"}).click();
  await expect(page.getByText("Comparer avec la version précédente")).toBeVisible();
  const v1=page.getByRole("row").filter({hasText:"v1"});
  await v1.getByText("Restaurer",{exact:true}).click();
  await v1.getByRole("button",{name:"Confirmer"}).click();
  await expect(page.getByText("Cette version deux remplace la procédure initiale.")).toHaveCount(0);
  await page.getByText("Autres actions",{exact:true}).click();
  await page.getByRole("button",{name:"Archiver"}).click();
  await expect(page.getByText("Archivé",{exact:true}).first()).toBeVisible();
});

test("un reviewer peut refuser un parcours et le renvoyer en brouillon",async({page,request})=>{
  await login(page);
  await page.goto("/studio/contenus/nouveau?type=onboarding");
  await page.getByRole("textbox",{name:"Titre",exact:true}).fill("Démarrer sa prospection LinkedIn");
  await page.getByLabel("Slug stable").fill("onboarding-linkedin-e2e");
  await page.getByLabel("Résumé").fill("Parcours de qualification LinkedIn.");
  await page.getByLabel("Intentions / signaux").fill("prospecter sur linkedin");
  await page.getByLabel("Pages Limova").fill("/super-powers");
  await page.locator('input[name="objective"]').fill("Créer une campagne LinkedIn");
  await page.getByLabel("Questions de qualification").fill("Quel est votre métier ?");
  await page.locator(".tiptap").fill("## Qualification\n\nDemander le métier puis proposer le super-pouvoir LinkedIn.");
  await page.getByLabel("Commentaire de modification").fill("Création du parcours E2E");
  await page.getByRole("button",{name:"Enregistrer le brouillon"}).click();
  await page.getByRole("button",{name:"Demander la validation"}).click();
  await expect(page.getByText("Le flow complet doit réussir avant l’envoi à l’administrateur.")).toBeVisible();
  await passRealEvaluation(page, request);
  await page.getByRole("button",{name:"Demander la validation"}).click();
  await page.getByLabel("Commentaire uniquement si vous demandez une correction").fill("Préciser la branche de repli");
  await page.getByRole("button",{name:"Demander une correction"}).click();
  await expect(page.getByText("Brouillon",{exact:true}).first()).toBeVisible();
});

test("un contenu existant peut être mis à jour puis supprimé par un administrateur",async({page})=>{
  await login(page);
  await createArticle(page,`manage-${Date.now()}`);
  const itemId = page.url().match(/contenus\/([0-9a-f-]+)/)?.[1];
  expect(itemId).toBeTruthy();

  const editLink = page.getByRole("link",{name:"Modifier le contenu"});
  await expect(editLink).toBeVisible();
  await expect(editLink).toHaveAttribute("href","#content-editor-form");
  await page.getByLabel("Résumé").fill("Guide Gmail administré depuis sa fiche.");
  await page.getByLabel("Commentaire de modification").fill("Mise à jour depuis la barre de gestion");
  await page.getByRole("button",{name:"Enregistrer la mise à jour"}).click();
  await expect(page.getByText("version 2",{exact:false}).first()).toBeVisible();
  await expect(page.getByLabel("Résumé")).toHaveValue("Guide Gmail administré depuis sa fiche.");

  await page.getByText("Supprimer",{exact:true}).click();
  await page.getByRole("button",{name:"Confirmer la suppression"}).click();
  await expect(page).toHaveURL(/\/studio\/contenus\?deleted=1$/);
  await expect(page.getByText("Le contenu, ses versions et ses tests ont bien été supprimés.")).toBeVisible();
  await expect(page.locator(`a[href="/studio/contenus/${itemId}"]`)).toHaveCount(0);
});

test("le banc E2E utilise l’identité owner et expose les espaces administrateur",async({page})=>{
  await login(page);
  await expect(page.getByRole("link",{name:"SAV IA",exact:true})).toBeVisible();
  await expect(page.getByRole("link",{name:"Entraînements",exact:true})).toBeVisible();
  await page.goto("/studio/validations");
  await expect(page).toHaveURL(/\/studio\/validations$/);
});

test("une démonstration extension devient un parcours Charly éditable",async({page,request})=>{
  await login(page);
  await page.goto("/studio/entrainements");
  await page.getByLabel("Nom du parcours").fill("Créer une campagne sociale E2E");
  await page.getByLabel("Ce que Charly doit apprendre").fill("Guider le membre jusqu’à son premier brouillon de campagne.");
  await page.getByLabel("Agent").selectOption("charly");
  await page.getByLabel("Page de départ").fill("/super-powers");
  await page.getByRole("button",{name:"Créer la démonstration"}).click();

  const token = (await page.locator(".training-code code").textContent())?.trim();
  expect(token).toBeTruthy();
  const connected = await request.post("/api/training/sessions/connect",{data:{token}});
  expect(connected.ok()).toBe(true);
  const headers = {Authorization:`Bearer ${token}`};
  const trainingEvents = [
    {
      kind: "navigation", path: "/super-powers", label: "Super-pouvoirs",
    },
    {
      kind: "click", path: "/super-powers", label: "Créer une campagne de posts pour réseaux sociaux",
      payload: { gestureId: "gesture-e2e", controlName: "Créer une campagne de posts pour réseaux sociaux", controlType: "bouton", tag: "button", role: "button", elementId: "create-social-campaign", testId: "social-campaign", section: "Réseaux sociaux", zone: "main", occurrence: 1 },
    },
    {
      kind: "page_context", path: "/campaigns/new", label: "Résultat après clic · Créer une campagne de posts pour réseaux sociaux",
      payload: { phase: "after_click", gestureId: "gesture-e2e", context: '[main]\n  h1: "Nouvelle campagne"', networkSummary: "POST /api/campaigns status:200 120ms" },
    },
    {
      kind: "input", path: "/campaigns/new", label: "Objectif de campagne", payload: { fieldType: "text" },
    },
    {
      kind: "page_context", path: "/integrations", label: "Fenêtre d’autorisation externe ouverte", payload: { phase: "opened", contentAccessible: false },
    },
    {
      kind: "voice_note", path: "/campaigns/new", label: "Demander au membre quel résultat il veut obtenir.",
    },
  ];
  const eventResponses = [];
  for (const event of trainingEvents) {
    eventResponses.push(await request.post("/api/training/sessions/events", { headers, data: event }));
  }
  expect(eventResponses.every(response => response.ok())).toBe(true);
  expect((await request.post("/api/training/sessions/complete",{headers})).ok()).toBe(true);

  // The detail page stays open while the extension posts events. They must
  // appear without a manual reload so the trainer can validate the flow live.
  await expect(page.getByText("6 événements utiles")).toBeVisible();
  await expect(page.getByRole("heading",{name:"Vidéo complète requise"})).toBeVisible();
  await expect(page.getByText("Contexte de page").first()).toBeVisible();
  const clickEvent = page.getByRole("listitem")
    .filter({hasText:"Cible exacte : bouton"})
    .filter({hasText:"Créer une campagne de posts pour réseaux sociaux"});
  await expect(clickEvent).toHaveCount(1);
  await expect(clickEvent).toContainText("Cible exacte : bouton");
  await expect(clickEvent).toContainText("test-id social-campaign");
  await expect(clickEvent).toContainText("#create-social-campaign");
  await expect(page.getByText("Objectif de campagne")).toBeVisible();
  const liveSnapshot = await page.request.get(`/api/studio/trainings/${page.url().match(/entrainements\/([0-9a-f-]+)/)?.[1]}`);
  expect(liveSnapshot.ok()).toBe(true);
  const livePayload = await liveSnapshot.json();
  expect(JSON.stringify(livePayload)).not.toContain("[main]");
  expect(JSON.stringify(livePayload)).not.toContain("POST /api/campaigns");
  await page.getByRole("button",{name:"Transformer en parcours"}).click();
  await expect(page).toHaveURL(/\/studio\/contenus\/[0-9a-f-]+$/);
  await expect(page.getByRole("textbox",{name:"Titre",exact:true})).toHaveValue("Créer une campagne sociale E2E");
  await expect(page.getByLabel("Agent concerné")).toHaveValue("charly");
  await expect(page.locator('input[name="bodyMarkdown"]')).toHaveValue(/Fenêtre d’autorisation externe ouverte/);
  await expect(page.locator('input[name="bodyMarkdown"]')).toHaveValue(/Cliquez sur « Créer une campagne de posts pour réseaux sociaux » \(bouton\)/);
  await expect(page.locator('input[name="bodyMarkdown"]')).toHaveValue(/Repères techniques appris/);
  await expect(page.locator('input[name="bodyMarkdown"]')).toHaveValue(/test-id=social-campaign/);
  await expect(page.locator('input[name="bodyMarkdown"]')).toHaveValue(/POST \/api\/campaigns status:200/);
  await expect(page.locator('input[name="actionSteps"]')).toHaveValue(/"testId":"social-campaign"/);
  await passRealEvaluation(page, request);
  await page.getByRole("button",{name:"Demander la validation"}).click();
  await page.getByRole("button",{name:"Valider et publier"}).click();
  await page.goto("/studio/entrainements");
  const publishedTraining = page.locator(".training-row").filter({hasText:"Créer une campagne sociale E2E"}).first();
  await expect(publishedTraining.getByText("Nouveau",{exact:true})).toHaveCount(0);
});

test("une démonstration peut être recommencée puis supprimée sans perdre l’essai précédent",async({page})=>{
  await login(page);
  const title = `Recommencer une démo E2E ${Date.now()}`;
  const editedTitle = `${title} modifiée`;
  await page.goto("/studio/entrainements");
  await page.getByLabel("Nom du parcours").fill(title);
  await page.getByLabel("Ce que Charly doit apprendre").fill("Vérifier le cycle de vie d’une démonstration.");
  await page.getByRole("button",{name:"Créer la démonstration"}).click();
  await expect(page).toHaveURL(/\/studio\/entrainements\/[0-9a-f-]+\?token=/);
  const firstId = page.url().match(/entrainements\/([0-9a-f-]+)/)?.[1];
  expect(firstId).toBeTruthy();

  await page.goto("/studio/entrainements");
  const firstRow = page.locator(".training-row").filter({hasText:title}).first();
  await expect(firstRow.getByText("Nouveau",{exact:true})).toBeVisible();
  await expect(firstRow.locator("time")).toContainText("Ajouté le");
  await firstRow.locator(`summary[aria-label="Gérer ${title}"]`).click();
  await firstRow.getByRole("link",{name:"Modifier"}).click();
  await expect(page).toHaveURL(new RegExp(`/studio/entrainements/${firstId}\\?edit=1$`));
  await page.locator("#edit-training-title").fill(editedTitle);
  await page.getByRole("button",{name:"Enregistrer les modifications"}).click();
  await expect(page.getByText("Le tutoriel a bien été modifié.")).toBeVisible();
  await expect(page.getByRole("heading",{name:editedTitle})).toBeVisible();

  await page.goto("/studio/entrainements");
  const editedRow = page.locator(".training-row").filter({hasText:editedTitle}).first();
  await editedRow.locator(`summary[aria-label="Gérer ${editedTitle}"]`).click();
  await editedRow.getByRole("button",{name:`Recommencer ${editedTitle}`}).click();
  await expect(page).toHaveURL(/\/studio\/entrainements\/[0-9a-f-]+\?token=.*&restarted=1/);
  const secondId = page.url().match(/entrainements\/([0-9a-f-]+)/)?.[1];
  expect(secondId).toBeTruthy();
  expect(secondId).not.toBe(firstId);
  await expect(page.getByText("Nouvel essai créé. La démonstration précédente reste disponible dans l’historique.")).toBeVisible();

  await page.getByText("Supprimer",{exact:true}).click();
  await page.getByRole("button",{name:`Confirmer la suppression de ${editedTitle}`}).click();
  await expect(page).toHaveURL(/\/studio\/entrainements\?deleted=1$/);
  await expect(page.getByText("La démonstration et ses événements ont bien été supprimés.")).toBeVisible();
  await expect(page.getByText(editedTitle,{exact:true})).toHaveCount(1);
});

test("une capture active reste supprimable sans proposer une modification impossible",async({page,request})=>{
  await login(page);
  const title = `Capture active E2E ${Date.now()}`;
  await page.goto("/studio/entrainements");
  await page.getByLabel("Nom du parcours").fill(title);
  await page.getByLabel("Ce que Charly doit apprendre").fill("Vérifier les actions autorisées pendant une capture active.");
  await page.getByRole("button",{name:"Créer la démonstration"}).click();

  const token = (await page.locator(".training-code code").textContent())?.trim();
  expect(token).toBeTruthy();
  expect((await request.post("/api/training/sessions/connect",{data:{token}})).ok()).toBe(true);

  await page.goto("/studio/entrainements");
  const row = page.locator(".training-row").filter({hasText:title}).first();
  await expect(row.getByText("En cours",{exact:true})).toBeVisible();
  await row.locator(`summary[aria-label="Gérer ${title}"]`).click();
  await expect(row.getByRole("link",{name:"Modifier"})).toHaveCount(0);
  await expect(row.getByRole("button",{name:`Recommencer ${title}`})).toBeVisible();
  await expect(row.getByText("Supprimer…",{exact:true})).toBeVisible();
});

test("la page Qualité permet de lancer les tests et d’ouvrir leur contenu attendu",async({page})=>{
  await login(page);
  await page.goto("/studio/tests");
  await page.getByLabel("Question utilisateur").fill("Comment connecter Gmail en E2E ?");
  await page.getByLabel("Contenu attendu").selectOption({index:1});
  await page.getByLabel("Page Limova").fill("/integrations");
  await page.getByRole("button",{name:"Ajouter au jeu de tests"}).click();
  await expect(page.getByRole("button",{name:"Tester les 1 questions"})).toBeVisible();
  const firstTest = page.locator(".quality-test-row").first();
  await expect(firstTest.getByRole("button",{name:"Tester"})).toBeVisible();
  await firstTest.getByRole("button",{name:"Tester"}).click();
  await expect(firstTest.locator(".status")).toBeVisible();
  await firstTest.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/studio\/contenus\/[0-9a-f-]+$/);
});

test("la trame publiée hiérarchise les contenus et devient le template de Charly",async({page,request})=>{
  test.setTimeout(60_000);
  await login(page);
  await createPublishedOnboarding(page,request,"linkedin-e2e","Lancer sa prospection LinkedIn E2E");
  await createPublishedOnboarding(page,request,"social-e2e","Créer ses premiers posts E2E");

  await page.goto("/studio/trame");
  await expect(page.getByRole("heading",{name:"Donnez un fil conducteur à Charly."})).toBeVisible();
  const library = page.getByLabel("Contenu disponible");
  await library.selectOption({label:"Lancer sa prospection LinkedIn E2E · Parcours"});
  await page.getByRole("button",{name:"Ajouter à la trame"}).click();
  await library.selectOption({label:"Créer ses premiers posts E2E · Parcours"});
  await page.getByRole("button",{name:"Ajouter à la trame"}).click();
  await page.getByRole("button",{name:"Placer Créer ses premiers posts E2E comme branche"}).click();
  await page.getByLabel("Première approche").fill("Demande au membre quel objectif il souhaite traiter aujourd’hui, puis attends sa réponse.");
  await page.getByLabel("Si le membre n’a pas d’idée").fill("Propose la prospection LinkedIn puis la création de posts selon son activité, sans imposer la suite.");
  await page.getByLabel("Ce qui change").fill("Création de la trame E2E");
  await page.getByRole("button",{name:"Enregistrer le brouillon"}).click();
  await expect(page.getByText("Brouillon enregistré. La version actuellement publiée n’a pas changé.")).toBeVisible();
  await page.getByRole("button",{name:"Valider et publier"}).click();
  await expect(page.getByText("La nouvelle trame est publiée. Charly l’utilisera dans les prochaines conversations.")).toBeVisible();

  const response = await request.get("/api/internal/onboarding/template",{headers:{Authorization:"Bearer e2e-service-token-that-is-at-least-32-characters"}});
  expect(response.ok()).toBe(true);
  const template = await response.json();
  expect(template).toMatchObject({revision:"onboarding_v1",version:1,name:"Onboarding principal Charly"});
  expect(template.steps).toHaveLength(2);
  expect(template.steps[0]).toMatchObject({name:"Lancer sa prospection LinkedIn E2E",depth:0});
  expect(template.steps[1]).toMatchObject({name:"Créer ses premiers posts E2E",depth:1});

  await page.goto(`/studio/contenus/${template.steps[0].contentItemId}`);
  await page.getByText("Supprimer",{exact:true}).click();
  await page.getByRole("button",{name:"Confirmer la suppression"}).click();
  await expect(page.getByText("Ce contenu est utilisé dans la trame d’onboarding. Retirez-le d’abord de la trame, puis republiez celle-ci.")).toBeVisible();
});

test("un membre crée, finalise et transforme son tutoriel sans accéder à celui d’un collègue",async({browser})=>{
  test.setTimeout(60_000);
  const baseURL = "http://127.0.0.1:3100";
  const memberContext = await browser.newContext({ baseURL, extraHTTPHeaders: { "x-studio-test-user": "matheo@limova.ai" } });
  const otherMemberContext = await browser.newContext({ baseURL, extraHTTPHeaders: { "x-studio-test-user": "arnaud@limova.ai" } });
  const adminContext = await browser.newContext({ baseURL, extraHTTPHeaders: { "x-studio-test-user": "ugo@limova.ai" } });
  const memberPage = await memberContext.newPage();
  const otherMemberPage = await otherMemberContext.newPage();
  const adminPage = await adminContext.newPage();
  const title = `Tutoriel membre E2E ${Date.now()}`;

  try {
    await memberPage.goto("/studio");
    await expect(memberPage.getByRole("link", { name: "Entraînements", exact: true })).toBeVisible();
    await expect(memberPage.getByRole("link", { name: "SAV IA", exact: true })).toHaveCount(0);
    await expect(memberPage.getByRole("link", { name: "Trame d’onboarding", exact: true })).toHaveCount(0);
    await expect(memberPage.getByRole("link", { name: "Santé", exact: true })).toHaveCount(0);
    await memberPage.goto("/studio/entrainements");
    await memberPage.getByLabel("Nom du parcours").fill(title);
    await memberPage.getByLabel("Ce que Charly doit apprendre").fill("Vérifier tout le parcours de création d’un tutoriel membre.");
    await memberPage.getByLabel("Agent").selectOption("charly");
    await memberPage.getByLabel("Page de départ").fill("/super-powers");
    await memberPage.getByRole("button", { name: "Créer la démonstration" }).click();
    await expect(memberPage).toHaveURL(/\/studio\/entrainements\/[0-9a-f-]+\?token=/);
    const trainingId = memberPage.url().match(/entrainements\/([0-9a-f-]+)/)?.[1];
    const token = (await memberPage.locator(".training-code code").textContent())?.trim();
    expect(trainingId).toBeTruthy();
    expect(token).toBeTruthy();

    const headers = { Authorization: `Bearer ${token}` };
    expect((await memberContext.request.post("/api/training/sessions/connect", { data: { token } })).ok()).toBe(true);
    expect((await memberContext.request.post("/api/training/sessions/events", { headers, data: { kind: "navigation", path: "/super-powers", label: "Départ membre" } })).ok()).toBe(true);
    expect((await memberContext.request.post("/api/training/sessions/events", { headers, data: { kind: "voice_note", path: "/super-powers", label: "Expliquer le parcours au membre." } })).ok()).toBe(true);
    expect((await memberContext.request.post("/api/training/sessions/complete", { headers })).ok()).toBe(true);
    await memberPage.reload();
    await memberPage.getByRole("button", { name: "Transformer en parcours" }).click();
    await expect(memberPage).toHaveURL(/\/studio\/contenus\/[0-9a-f-]+$/);
    await passRealEvaluation(memberPage, memberContext.request);
    await memberPage.getByRole("button", { name: "Demander la validation" }).click();

    const forbiddenResponse = await otherMemberPage.goto(`/studio/entrainements/${trainingId}`);
    expect(forbiddenResponse?.status()).toBe(404);
    await otherMemberPage.goto("/studio/entrainements");
    await expect(otherMemberPage.getByText(title, { exact: true })).toHaveCount(0);

    await adminPage.goto(`/studio/entrainements/${trainingId}`);
    await expect(adminPage.getByRole("heading", { name: title })).toBeVisible();
    await adminPage.goto("/studio/validations");
    const validation = adminPage.locator(".review-card").filter({ hasText: title });
    await validation.click();
    await adminPage.getByRole("button", { name: "Valider et publier" }).click();
    await expect(adminPage.getByText("Publié", { exact: true }).first()).toBeVisible();
  } finally {
    await Promise.all([memberContext.close(), otherMemberContext.close(), adminContext.close()]);
  }
});
