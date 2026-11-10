// The one source the rehearsal page may read: pole B's synthetic SYN report committed next to this file, byte for byte as B delivered it (common-1 r2, no customer
// data), imported statically. No path, file name or secret ever comes from the URL, a form or the environment. Off in a production
// build: the page then says the report is not connected (never that there is none).
export const simulationReportSource: (() => Promise<unknown>) | null = process.env.NODE_ENV === "production" ? null
  : async () => (await import("./simulation-fixtures/syn-rehearsal-report.common-1.r2.json")).default;
