export const AGENTS = [
  { key: "charly", name: "Charly", role: "Onboarding et navigation", color: "#f4b942" },
  { key: "elio", name: "Elio", role: "Prospection et campagnes", color: "#5b7cfa" },
  { key: "john", name: "John", role: "Création et réseaux sociaux", color: "#ee6b5f" },
  { key: "lou", name: "Lou", role: "Marketing et SEO", color: "#9b6de3" },
  { key: "tom", name: "Tom", role: "Support et agents conversationnels", color: "#26a885" },
  { key: "sav", name: "Agent SAV", role: "Qualification des emails et tickets", color: "#176b55" },
  { key: "common", name: "Socle commun", role: "Compte, intégrations et dépannage", color: "#63706a" },
] as const;

export type AgentKey = typeof AGENTS[number]["key"];

export function getAgent(key: string) {
  return AGENTS.find((agent) => agent.key === key) ?? AGENTS.at(-1)!;
}

export function inferAgentKey(slug: string, title: string): AgentKey {
  const value = `${slug} ${title}`.toLocaleLowerCase("fr");
  if (/\b(elio|linkedin|prospection|campagne.d.appels?)\b/.test(value)) return "elio";
  if (/\b(john|jonh|image|vidéo|video|présentation|presentation|réseaux sociaux|reseaux sociaux|post|audio|transcri)/.test(value)) return "john";
  if (/\b(lou|seo|blog|marketing)\b/.test(value)) return "lou";
  if (/\b(tom|support client|standard téléphonique|chatbot)\b/.test(value)) return "tom";
  if (/\b(charly|onboarding|bienvenue|tutoriel|bien démarrer)\b/.test(value)) return "charly";
  return "common";
}
