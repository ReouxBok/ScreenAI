import { rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { categories, contentItems, contentVersions } from "../src/db/schema";
import { CATEGORIES } from "../src/lib/content";
const target=path.resolve(process.env.STUDIO_E2E_DB_DIR ?? ".e2e-db");
try { await rename(target,path.join(os.tmpdir(),`limova-studio-e2e-backup-${Date.now()}`)); } catch (error) { if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
const client=new PGlite(`file://${target}`,{extensions:{vector}});
const db=drizzle(client);
await migrate(db,{migrationsFolder:path.resolve("drizzle")});
await db.insert(categories).values(CATEGORIES.map(([slug,label],position)=>({slug,label,position}))).onConflictDoNothing();
// Synthetic, unindexed sources for SAV-51. No production tutorial or provider is used.
const onboardingBody = `# Procédure synthétique de renommage
## Quand utiliser ce parcours
Quand le nom d’un espace de démonstration doit changer.
## Point d’entrée
Ouvrir « Paramètres » en bas à gauche.
## Prérequis
- Disposer du rôle administrateur de l’espace de démonstration.
## Questions à poser si l’information manque
- Quel espace de démonstration voulez-vous renommer ?
## Étapes opérationnelles
1. Ouvrir la liste concernée et sélectionner l’élément exact à modifier.
2. Saisir le nouveau nom dans « Nom de l’espace ».
3. Cliquer sur « Enregistrer » et attendre la confirmation.
## Vérification de réussite
- Le nouveau nom apparaît dans l’en-tête de l’espace de démonstration.
## Variantes et blocages
- Si le nom est déjà utilisé : choisir un nom différent.
## Reprise sûre
- Si la confirmation ne s’affiche pas, vérifier le nom affiché avant de recommencer.`;
for (let n = 1; n <= 21; n++) {
  const suffix = String(n).padStart(12, "0");
  const itemId = `00000051-0000-4000-8000-${suffix}`;
  const versionId = `00000051-0000-4000-9000-${suffix}`;
  await db.insert(contentItems).values({ id: itemId, slug: `sav51-synthetic-tutorial-${n}`, type: "onboarding", title: n === 1 ? "Renommer l’espace — démo SAV-51 (titre exact)" : `SAV-51 · Tutoriel synthétique ${String(n).padStart(2, "0")}`, summary: "Source fictive de recette, sans connaissance métier réelle.", ownerEmail: "ugo@limova.ai", agentKey: "charly", status: "published", aiEnabled: true });
  await db.insert(contentVersions).values({ id: versionId, itemId, version: 1, bodyMarkdown: onboardingBody,
    metadata: { objective: "Renommer un espace de démonstration", proposalSignals: [], qualificationQuestions: [], expectedPages: [], successCriteria: [], branches: [], fallbacks: [], actionSteps: [] },
    changeNote: "Source de recette entièrement fictive", authorEmail: "ugo@limova.ai" });
  await db.update(contentItems).set({ currentDraftVersionId: versionId, publishedVersionId: versionId }).where(eq(contentItems.id, itemId));
}
await client.close();
console.log(`E2E database ready at ${target}`);
