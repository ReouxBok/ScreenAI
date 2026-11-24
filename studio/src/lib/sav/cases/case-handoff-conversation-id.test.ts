import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handoffConversationId } from "./case-handoff-summary";
import type { CaseFact } from "./case-types";

describe("identifiant de conversation transmis par le client", () => {
  const id = randomUUID(), organization = randomUUID(), workspace = randomUUID();
  const v3 = `https://new.limova.ai/organizations/${organization}/workspaces/${workspace}/conversations/${id}`;
  const legacy = `https://limova.ai/thread/${id}`;
  const extract = (text: string) => handoffConversationId({ facts: [] }, { files: [], omitted: 0, linkTexts: [text] });

  it.each([v3, legacy])("extrait uniquement l'UUID depuis %s", url => {
    expect(extract(`Voici le lien : ${url}.`)).toBe(id);
  });

  it.each([
    ["hôte externe", legacy.replace("limova.ai", "limova.ai.example.invalid")],
    ["hôte d'authentification", legacy.replace("limova.ai", "auth.limova.ai")],
    ["hôte d'identité", legacy.replace("limova.ai", "id.limova.ai")],
    ["chemin de connexion", legacy.replace("/thread/", "/login/../thread/")],
    ["paramètre de jeton", `https://limova.ai/share/${id}?token=synthetic`],
    ["fragment de connexion", `https://limova.ai/share/${id}#%256cogin`],
    ["jeton magique V3", `${v3}?magic_token=synthetic`],
    ["HTTP", legacy.replace("https:", "http:")],
    ["port", legacy.replace("limova.ai", "limova.ai:8443")],
    ["port HTTPS explicite", legacy.replace("limova.ai", "limova.ai:443")],
    ["identifiants", legacy.replace("limova.ai", "synthetic:example@limova.ai")],
    ["UUID absent", legacy.replace(id, "conversation-fictive")],
    ["texte sans lien", `Conversation ${id}`],
    ["URL très longue", `${legacy}?q=${"a".repeat(100_000)}`],
    ["hôte Unicode", legacy.replace("limova.ai", "ｌimova.ai")],
    ["double encodage", legacy.replace("/thread/", "/%2574hread/")],
  ])("écarte %s", (_label, text) => {
    expect(extract(text)).toBeNull();
  });

  it("ignore un lien d'authentification avant un lien valide", () => {
    const validId = randomUUID();
    expect(extract(`${legacy}?token=synthetic ${v3.replace(id, validId)}`)).toBe(validId);
  });

  it("garde le premier identifiant et lit aussi les propos enregistrés", () => {
    const statement: CaseFact = {
      id: "f1", kind: "customer_statement", source: { type: "email", id: randomUUID() },
      text: legacy, at: "2026-11-24T07:00:00.000Z", key: null,
    };
    const secondId = randomUUID();
    const fromMail = { files: [], omitted: 0, linkTexts: [`${v3.replace(id, secondId)} ${legacy}`] };
    expect(handoffConversationId({ facts: [statement] }, fromMail)).toBe(secondId);
    expect(handoffConversationId({ facts: [statement] })).toBe(id);
  });
});
