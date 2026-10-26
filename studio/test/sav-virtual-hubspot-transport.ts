import type * as Transport from "../src/lib/sav/hubspot-transport";

/** Business scenarios keep the real transport but do not wait on its rate limit. */
export function virtualSavHubspotTransportModule(actual: typeof Transport) {
  return {
    ...actual,
    createSavHubspotTransport: (network?: typeof fetch) => {
      let offset = 0;
      return actual.createSavHubspotTransport(network, {
        // Keep explicit Date changes visible to expiry/continuity scenarios.
        now: () => Date.now() + offset,
        wait: async (delay, signal) => {
          if (signal?.aborted) throw new Error("SAV_HUBSPOT_READ_CANCELLED");
          offset += delay;
        }
      });
    }
  };
}
