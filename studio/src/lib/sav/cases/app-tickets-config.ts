import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";

/*
 * SAV-138 (Ugo 25/11): HubSpot tickets created from the Limova app (no mail thread) are picked up by the existing reconcile pass (`app-tickets.ts`).
 *
 * `SAV_APP_TICKETS_MODE` (production only, `VERCEL_ENV=production`):
 *   - absent, empty or any other value: `off`. Strictly today's behaviour: not one extra HubSpot call, no row written.
 *   - `shadow`: each pass reads the new open unowned support tickets (bounded search), applies the category gate and records, per ticket, what it WOULD do
 *     (`sav.sync_state`, keys `sav-app-ticket.v1:shadow:<ticketId>`, readable through the admin MCP tool `app_tickets_report`). No owner change, no case,
 *     no model, no mail, no Slack.
 *   - `live`: same detection and gate, then the ticket is assigned to the Agent SAV owner (`SAV_V2_HUBSPOT_OWNER_ID`) ONCE and enters the existing threadless
 *     path (`startV2FromThreadlessTicket`). Live also needs `SAV_APP_TICKETS_SOURCE_TYPES`; without it the live pass does nothing.
 * `SAV_APP_TICKETS_SOURCE_TYPES`: comma-separated HubSpot `source_type` values the app's tickets carry (e.g. the value shadow shows for them). `EMAIL` (V1's
 *   tickets) is never accepted. Shadow ignores it (it records every non-mail source type, so Ugo can see which one the app uses).
 * `SAV_APP_TICKETS_LOOKBACK_MINUTES`: how far before its first run each mode looks (default 60, max 1440). Never a replay of old tickets.
 *
 * Category gate (Ugo 25/11, overrides the 19/11 rule for these two categories only): a ticket whose HubSpot category contains « Facturation » or
 * « Résiliation » is never touched: no assignment, no model, no Slack notice, no customer message; it stays with the team.
 */

type Env = Readonly<Record<string, string | undefined>>;
export type SavAppTicketsMode = "off" | "shadow" | "live";

export function savAppTicketsMode(env: Env = process.env): SavAppTicketsMode {
  if (env.VERCEL_ENV !== "production") return "off";
  const value = env.SAV_APP_TICKETS_MODE;
  return value === "shadow" || value === "live" ? value : "off";
}

const SOURCE_TYPE = /^[A-Z][A-Z0-9_]{0,39}$/;
export function savAppTicketsSourceTypes(env: Env = process.env): string[] {
  return [...new Set((env.SAV_APP_TICKETS_SOURCE_TYPES ?? "").split(",").map(value => value.trim()))]
    .filter(value => SOURCE_TYPE.test(value) && value !== SAV_HUBSPOT_SUPPORT.source);
}

/** The two categories that are never touched. HubSpot stores a multi-select as `a;b`. */
export const SAV_APP_TICKETS_GATED_CATEGORIES: readonly string[] = [SAV_HUBSPOT_SUPPORT.categories.billing, SAV_HUBSPOT_SUPPORT.categories.cancellation];
export function appTicketCategoryGated(categories: string | null | undefined): boolean {
  return (categories ?? "").split(";").map(value => value.trim()).some(value => SAV_APP_TICKETS_GATED_CATEGORIES.includes(value));
}

/** A HubSpot source type as recorded (never free text): the value itself when it looks like an enum, else `OTHER`; none: `NONE`. */
export const appTicketSourceLabel = (value: string | null | undefined) => !value ? "NONE" : SOURCE_TYPE.test(value) ? value : "OTHER";
