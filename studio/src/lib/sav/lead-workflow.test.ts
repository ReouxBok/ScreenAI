import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { categories, contentItems, contentVersions } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, auth: vi.fn(), redirect: vi.fn(), embed: vi.fn(async (texts: string[]) => texts.map(() => new Array(768).fill(1))) }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("@/lib/auth", () => ({ requireApiStaff: state.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: state.redirect }));
vi.mock("@/lib/embeddings", () => ({ embedTexts: state.embed }));
import { saveContentAction } from "@/app/studio/actions";
import { publish, setContentAiEnabled, submitForReview } from "../workflow";
import { searchKnowledge } from "../search";

let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
const actor = { email: "ugo@limova.ai", role: "admin" };
function form(itemId?: string, template = "Bonjour, modèle fictif : https://example.invalid/demo.") {
  const data = new FormData();
  for (const [key, value] of Object.entries({ type: "article", agentKey: "sav", slug: "lead-fixture", title: "Découverte produit fictive", summary: "Lead avant achat fictif",
    categorySlug: "agents", bodyMarkdown: "## Modèle fictif\n\n" + template, changeNote: "Recette isolée du modèle fictif", intents: "informations produit",
    savResolution: "on", savAudience: "lead", savResponseTemplate: template, savSymptoms: "Lead demandant des informations produit avant achat",
    savSteps: "Orienter vers un formulaire fictif", savEscalation: "Qualification humaine en cas de doute", savSourceReference: "Source de recette fictive", savSourceDate: new Date().toISOString().slice(0, 10) })) data.set(key, value);
  if (itemId) data.set("itemId", itemId);
  return data;
}
describe("Staff lead knowledge: authenticated form through isolated database retrieval", () => {
  beforeAll(async () => {
    fixture = await createSavTestDb(); state.db = fixture.db; state.auth.mockResolvedValue(actor);
    await fixture.db.insert(categories).values({ slug: "agents", label: "Agents" });
  }, 30_000);
  afterAll(async () => { await fixture?.client.close(); });
  it("rejects unauthenticated writes before any draft is created", async () => {
    state.auth.mockRejectedValueOnce(new Error("UNAUTHENTICATED"));
    await expect(saveContentAction(form())).rejects.toThrow("UNAUTHENTICATED");
    expect(await fixture.db.select().from(contentItems)).toHaveLength(0);
  });
  it.each([{ agentKey: "charly", visibility: "charly_only" }, { agentKey: "sav", visibility: "charly_and_help" }])("rejects saving a lead card outside private SAV scope: %s", async scope => {
    const { saveDraft } = await import("../workflow");
    await expect(saveDraft({ type: "article", slug: "invalid-lead-scope", locale: "fr-FR", title: "Modèle fictif", summary: "Test de scope fictif",
      categorySlug: "agents", ...scope, ownerEmail: actor.email, bodyMarkdown: "Modèle fictif de plus de vingt caractères.", changeNote: "Test de scope",
      metadata: { resolution: { audience: "lead", escalation: "Qualification humaine" } } }, actor.email)).rejects.toThrow("SAV_LEAD_KNOWLEDGE_SCOPE_REQUIRED");
  });
  it("keeps draft/review/inactive publication out of retrieval, then scopes active published evidence to leads", async () => {
    const data = form(); data.set("sourceMetadata", '{"importKind":"hubspot","ticketId":"invented"}');
    await saveContentAction(data);
    const [item] = await fixture.db.select().from(contentItems);
    const [v1] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.itemId, item.id));
    expect(item).toMatchObject({ status: "draft", aiEnabled: false, publishedVersionId: null });
    expect(v1.metadata.sourceMetadata).toMatchObject({ editorialSource: { kind: "staff_supplied", recordedBy: actor.email } });
    expect(v1.metadata.sourceMetadata).not.toHaveProperty("importKind");
    const query = { query: "informations produit", scope: "sav", savAudience: "lead", contentTypes: ["article"] };
    expect((await searchKnowledge(query)).results).toHaveLength(0);
    await submitForReview(item.id, actor.email, "Revue fictive");
    expect((await searchKnowledge(query)).results).toHaveLength(0);
    await expect(publish(item.id, "staff@example.invalid", { expectedVersionId: v1.id })).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    await publish(item.id, actor.email, { expectedVersionId: v1.id });
    expect((await searchKnowledge(query)).results).toHaveLength(0);
    await setContentAiEnabled(item.id, true, actor.email, { expectedPublishedVersionId: v1.id, expectedActiveVersionId: null });
    const found = await searchKnowledge(query);
    expect(found.results).toHaveLength(1);
    expect(found.results[0]).toMatchObject({ id: item.id, contentVersionId: v1.id, resolution: { audience: "lead", responseTemplate: data.get("savResponseTemplate") } });
    expect((await searchKnowledge({ query: "informations produit", scope: "sav" })).results).toHaveLength(0);
    expect((await searchKnowledge({ query: "informations produit", scope: "extension", savAudience: "lead", contentTypes: ["article"] })).results).toHaveLength(0);
    const v2form = form(item.id, "Bonjour, deuxième modèle fictif : https://example.invalid/demo.");
    v2form.set("savSourceReference", "Deuxième source fictive");
    await saveContentAction(v2form);
    const versions = await fixture.db.select().from(contentVersions).where(eq(contentVersions.itemId, item.id));
    const v2 = versions.find(version => version.version === 2)!;
    expect(v2.metadata).toMatchObject({ resolution: { audience: "lead", responseTemplate: v2form.get("savResponseTemplate") }, sourceMetadata: { editorialSource: { reference: "Deuxième source fictive" } } });
    const forged = form(item.id); forged.delete("savResolution"); forged.set("agentKey", "charly");
    await expect(saveContentAction(forged)).rejects.toThrow("SAV_LEAD_KNOWLEDGE_SCOPE_REQUIRED");
    expect((await searchKnowledge(query)).results[0].contentVersionId).toBe(v1.id);
    await setContentAiEnabled(item.id, false, actor.email);
    expect((await searchKnowledge(query)).results).toHaveLength(0);
  });
});
