// The old V0 follow-ups (J+2/5/10 after a sent reply) are retired (SAV-9). The reminder of a question is the V2 J2 timer, which only emits an
// event and never sends from here. This entry point is kept so that a stale caller, a duplicated or a delayed trigger stays harmless:
// it reads nothing, writes nothing, queues nothing, and leaves every sav.followups row as it is (scheduled rows are a backlog for an
// audited decision, see legacy-backlog.ts). There is no option to bring the old behaviour back.
export async function processDueFollowups(limit = 50, now = new Date()) {
  void limit;
  void now;
  return { retired: true as const, processed: [] as Array<{ followupId: string; status: string }> };
}
