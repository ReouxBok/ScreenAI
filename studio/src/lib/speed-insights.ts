// Only known route shapes may leave the browser. Never send search terms,
// returnTo, training tokens, case identifiers or an SDK-provided raw route.
const staticRoutes = new Set([
  "/studio", "/studio/contenus", "/studio/contenus/nouveau",
  "/studio/entrainements", "/studio/validations", "/studio/tests",
  "/studio/trame", "/studio/sante", "/studio/sav",
  "/studio/sav/pilote", "/studio/sav/resolutions", "/studio/sav/evaluation",
  "/studio/sav/intake", "/studio/sav/intake/budget", "/studio/sav/intake/launch",
  "/studio/sav/intake/comparison", "/studio/sav/intake/pause",
  "/studio/sav/connaissances", "/studio/sav/connaissances/playbook",
  "/studio/sav/connaissances/diagnostic", "/studio/sav/connaissances/apprentissage",
  "/studio/sav/connaissances/proposer", "/studio/sav/connaissances/imports",
]);
const detailRoute = /^(\/studio\/(?:contenus|entrainements|sav|sav\/intake|sav\/connaissances))\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizeStudioVital(event: { type: "vital"; url: string; route?: string }) {
  try {
    const url = new URL(event.url);
    if (url.protocol !== "https:" || url.hostname !== "studio.limova.ai" || url.port || url.username || url.password) return null;
    const route = staticRoutes.has(url.pathname) ? url.pathname
      : url.pathname.match(detailRoute)?.[1].concat("/[id]");
    if (!route) return null;
    return { type: event.type, url: `${url.origin}${route}`, route };
  } catch {
    return null;
  }
}
