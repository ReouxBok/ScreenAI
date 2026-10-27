/** Only this verified address may read or change the Studio daily cap, not other administrators. */
export const SAV_INTAKE_BUDGET_OWNER_EMAIL = "ugo@limova.ai";
/** Dollars with at most two decimals, converted through cents: no floating point drift. */
export function parseUsdToNano(value: string) {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw Error("SAV_INTAKE_BUDGET_AMOUNT_INVALID");
  return (Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))) * 10_000_000;
}
export const formatNanoUsd = (nano: number) => `${(nano / 1e9).toFixed(2).replace(".", ",")} USD`;
