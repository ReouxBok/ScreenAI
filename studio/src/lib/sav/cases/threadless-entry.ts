export async function startV2FromThreadlessTicket(input: { ticketId: string; ownerTransitionKey: string; observedAt: string }) {
  void input;
  return { status: "threadless_not_enabled" } as const;
}
