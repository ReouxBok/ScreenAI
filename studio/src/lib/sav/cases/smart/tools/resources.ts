type SmartResource = Readonly<{
  title: string;
  url: string;
  whenToOffer: string;
  verifiedOn: string;
  allowed: boolean;
}>;

export const SAV_SMART_RESOURCES: readonly SmartResource[] = [
  {
    title: "Webinaires Limova",
    url: "https://bienvenue.limova.ai/webinaires",
    whenToOffer: "Proposer l’inscription lorsque le client découvre Limova, souhaite être accompagné ou se perd dans la prise en main.",
    verifiedOn: "2026-11-19",
    allowed: true,
  },
  {
    title: "Extension Chrome Limova",
    url: "https://chromewebstore.google.com/detail/limova-ai-assistant-onboa/fpkgfhhomlijmhbgcpbpjnfafdedfccj",
    whenToOffer: "Proposer la fiche Chrome Web Store lorsque le client souhaite installer l’extension Limova. Le tutoriel d’installation se trouve dans l’Academy.",
    verifiedOn: "2026-11-19",
    allowed: true,
  },
  {
    title: "Limova Academy",
    url: "https://academy.limova.ai",
    whenToOffer: "Proposer l’Academy lorsque le client cherche un tutoriel Limova ou veut apprendre à utiliser ses Assistants en autonomie.",
    verifiedOn: "2026-11-19",
    allowed: true,
  },
];

const allowedResources = SAV_SMART_RESOURCES.filter((resource) => resource.allowed);

export function isSmartResourceUrlAllowed(url: string): boolean {
  return allowedResources.some((resource) => resource.url === url);
}

export const SMART_RESOURCES_PROMPT = [
  "Ressources Limova à proposer selon le besoin du client.",
  ...allowedResources.map(({ title, url, whenToOffer }) => `- ${title} (${url}). ${whenToOffer}`),
].join("\n");
