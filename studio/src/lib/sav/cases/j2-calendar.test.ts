import { describe, expect, it, vi } from "vitest";
import { J2_MIN_DELAY_MS, nextJ2Slot } from "./j2-calendar";

const utc = (value: string) => new Date(value);
const due = (sent: string) => nextJ2Slot(utc(sent)).toISOString();
const paris = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const inParis = (date: Date) => paris.format(date).replace(/\./g, "");

// Same rows as the SAV-8 report table.
const EXAMPLES: Array<{ label: string; sentUtc: string; sentParis: string; dueUtc: string; dueParis: string }> = [
  { label: "lundi 23h", sentUtc: "2026-10-26T22:00:00.000Z", sentParis: "lun 26/10/2026 23:00", dueUtc: "2026-10-28T08:00:00.000Z", dueParis: "mer 28/10/2026 09:00" },
  { label: "créneau ouvert, 24 h exactes", sentUtc: "2026-10-27T09:30:00.000Z", sentParis: "mar 27/10/2026 10:30", dueUtc: "2026-10-28T09:30:00.000Z", dueParis: "mer 28/10/2026 10:30" },
  { label: "17:59", sentUtc: "2026-11-02T16:59:00.000Z", sentParis: "lun 02/11/2026 17:59", dueUtc: "2026-11-03T16:59:00.000Z", dueParis: "mar 03/11/2026 17:59" },
  { label: "18:00", sentUtc: "2026-11-02T17:00:00.000Z", sentParis: "lun 02/11/2026 18:00", dueUtc: "2026-11-04T08:00:00.000Z", dueParis: "mer 04/11/2026 09:00" },
  { label: "échéance avant 9h", sentUtc: "2026-11-04T05:00:00.000Z", sentParis: "mer 04/11/2026 06:00", dueUtc: "2026-11-05T08:00:00.000Z", dueParis: "jeu 05/11/2026 09:00" },
  { label: "vendredi après-midi", sentUtc: "2026-11-06T14:00:00.000Z", sentParis: "ven 06/11/2026 15:00", dueUtc: "2026-11-09T08:00:00.000Z", dueParis: "lun 09/11/2026 09:00" },
  { label: "samedi soir", sentUtc: "2026-11-07T19:00:00.000Z", sentParis: "sam 07/11/2026 20:00", dueUtc: "2026-11-09T08:00:00.000Z", dueParis: "lun 09/11/2026 09:00" },
  { label: "changement d'heure d'octobre", sentUtc: "2026-10-23T10:00:00.000Z", sentParis: "ven 23/10/2026 12:00", dueUtc: "2026-10-26T08:00:00.000Z", dueParis: "lun 26/10/2026 09:00" },
  { label: "changement d'heure de mars", sentUtc: "2026-03-27T16:00:00.000Z", sentParis: "ven 27/03/2026 17:00", dueUtc: "2026-03-30T07:00:00.000Z", dueParis: "lun 30/03/2026 09:00" },
  { label: "dimanche midi", sentUtc: "2026-11-08T11:00:00.000Z", sentParis: "dim 08/11/2026 12:00", dueUtc: "2026-11-09T11:00:00.000Z", dueParis: "lun 09/11/2026 12:00" },
];

describe("nextJ2Slot - table of ten examples", () => {
  for (const example of EXAMPLES) {
    it(`${example.label}: ${example.sentParis} -> ${example.dueParis}`, () => {
      const sent = utc(example.sentUtc);
      const result = nextJ2Slot(sent);
      expect(inParis(sent)).toBe(example.sentParis);
      expect(result.toISOString()).toBe(example.dueUtc);
      expect(inParis(result)).toBe(example.dueParis);
    });
  }
});

describe("nextJ2Slot - rule", () => {
  it("moves Monday 23:00 to Wednesday 09:00", () => {
    expect(due("2026-10-26T22:00:00Z")).toBe("2026-10-28T08:00:00.000Z");
  });

  it("keeps the exact 24 h instant when it falls inside a business slot", () => {
    expect(due("2026-10-27T09:30:15.250Z")).toBe("2026-10-28T09:30:15.250Z");
  });

  it("skips weekends from every weekend hour", () => {
    // One send every two hours from Saturday 2026-11-07 00:00 Paris (UTC+1), i.e. due from Sunday 00:00 on.
    for (let hour = 0; hour < 48; hour += 2) {
      const sent = new Date(Date.UTC(2026, 10, 6, 23, 0) + hour * 3_600_000);
      const expected = hour <= 32 ? "2026-11-09T08:00:00.000Z" // due Sunday or Monday before 09:00 -> Monday 09:00
        : hour <= 40 ? new Date(sent.getTime() + J2_MIN_DELAY_MS).toISOString() // due Monday 10:00-16:00: kept as is
        : "2026-11-10T08:00:00.000Z"; // due Monday 18:00 or later -> Tuesday 09:00
      expect(nextJ2Slot(sent).toISOString(), `+${hour}h`).toBe(expected);
    }
  });

  it("sunday sends land on Monday 24 h later when that is inside the slot", () => {
    expect(due("2026-11-08T11:00:00Z")).toBe("2026-11-09T11:00:00.000Z"); // Sun 12:00 Paris -> Mon 12:00 Paris
    expect(due("2026-11-08T17:30:00Z")).toBe("2026-11-10T08:00:00.000Z"); // Sun 18:30 -> Mon 18:30 closed -> Tue 09:00
  });

  describe("slot edges", () => {
    // Monday 2026-11-02, Paris UTC+1: due is Tuesday at the same wall-clock time.
    it("accepts 17:59:59.999 and refuses 18:00:00.000 (exclusive end)", () => {
      expect(due("2026-11-02T16:59:59.999Z")).toBe("2026-11-03T16:59:59.999Z");
      expect(due("2026-11-02T17:00:00.000Z")).toBe("2026-11-04T08:00:00.000Z");
    });

    it("refuses 08:59:59.999 and accepts 09:00:00.000 (inclusive start)", () => {
      expect(due("2026-11-02T07:59:59.999Z")).toBe("2026-11-03T08:00:00.000Z");
      expect(due("2026-11-02T08:00:00.000Z")).toBe("2026-11-03T08:00:00.000Z");
    });

    it("never returns less than 24 real hours after the question", () => {
      for (const sent of ["2026-11-02T08:00:00.000Z", "2026-11-02T16:59:59.999Z", "2026-11-06T16:59:59.999Z", "2026-10-25T01:30:00.000Z"]) {
        expect(nextJ2Slot(utc(sent)).getTime()).toBeGreaterThanOrEqual(utc(sent).getTime() + J2_MIN_DELAY_MS);
      }
    });
  });

  describe("daylight saving time (Europe/Paris)", () => {
    it("spring forward 2026-03-29: Friday 17:00 CET -> Monday 09:00 CEST (UTC offset drops from 8h to 7h)", () => {
      expect(due("2026-03-27T16:00:00Z")).toBe("2026-03-30T07:00:00.000Z");
    });

    it("spring forward: a send during the last winter hour and the first summer hour both wait for Monday 09:00 CEST", () => {
      expect(due("2026-03-29T00:30:00Z")).toBe("2026-03-30T07:00:00.000Z"); // 01:30 CET
      expect(due("2026-03-29T01:30:00Z")).toBe("2026-03-30T07:00:00.000Z"); // 03:30 CEST
    });

    it("spring forward: 24 real hours across the switch read 11:00 on the wall clock, not 10:00", () => {
      // Sat 2026-03-28 10:00 CET + 24 real hours = Sun 11:00 CEST: Sunday -> Monday 09:00.
      expect(due("2026-03-28T09:00:00Z")).toBe("2026-03-30T07:00:00.000Z");
    });

    it("autumn back 2026-10-25: Friday 12:00 CEST -> Monday 09:00 CET (UTC offset rises from 7h to 8h)", () => {
      expect(due("2026-10-23T10:00:00Z")).toBe("2026-10-26T08:00:00.000Z");
    });

    it("autumn back: both occurrences of 02:30 on the switch Sunday resolve to Monday 09:00 CET", () => {
      expect(due("2026-10-25T00:30:00Z")).toBe("2026-10-26T08:00:00.000Z"); // 02:30 CEST (first)
      expect(due("2026-10-25T01:30:00Z")).toBe("2026-10-26T08:00:00.000Z"); // 02:30 CET (second)
    });

    it("uses the offset of the slot day, not of the send day, for a send before the switch", () => {
      // Thursday 2026-10-22 09:00 CEST -> Friday 09:00 CEST (no change), Friday 18:30 CEST -> Monday 09:00 CET.
      expect(due("2026-10-22T07:00:00Z")).toBe("2026-10-23T07:00:00.000Z");
      expect(due("2026-10-23T16:30:00Z")).toBe("2026-10-26T08:00:00.000Z");
    });

    it("handles the 2027 switches too (last Sundays: 28 March and 31 October)", () => {
      expect(due("2027-03-26T16:00:00Z")).toBe("2027-03-29T07:00:00.000Z"); // Fri 17:00 CET -> Mon 09:00 CEST
      expect(due("2027-10-29T10:00:00Z")).toBe("2027-11-01T08:00:00.000Z"); // Fri 12:00 CEST -> Mon 09:00 CET
    });
  });

  describe("public holidays", () => {
    it("are open days: only Saturday and Sunday are closed (decision Ugo, 2026-10-27)", () => {
      expect(due("2026-05-07T10:00:00Z")).toBe("2026-05-08T10:00:00.000Z"); // Friday 8 May 2026
      expect(due("2026-11-10T09:00:00Z")).toBe("2026-11-11T09:00:00.000Z"); // Wednesday 11 November 2026
      expect(due("2026-12-24T13:00:00Z")).toBe("2026-12-25T13:00:00.000Z"); // Friday 25 December 2026
    });

    it("has no holiday parameter: an extra argument changes nothing", () => {
      const withExtra = nextJ2Slot as unknown as (sentAt: Date, holidays: string[]) => Date;
      expect(nextJ2Slot.length).toBe(1);
      expect(withExtra(utc("2026-11-16T09:00:00Z"), ["2026-11-17"]).toISOString()).toBe("2026-11-17T09:00:00.000Z");
    });
  });

  describe("invalid input", () => {
    it("rejects anything that is not a valid Date", () => {
      expect(() => nextJ2Slot(new Date("not a date"))).toThrow(RangeError);
      for (const bad of ["2026-10-26T22:00:00Z", 1_792_000_000_000, null, undefined, {}, [] as unknown]) {
        expect(() => nextJ2Slot(bad as Date)).toThrow(TypeError);
      }
    });

    it("rejects implausible instants instead of computing a slot", () => {
      expect(() => nextJ2Slot(new Date(Date.UTC(1969, 11, 31)))).toThrow(RangeError);
      expect(() => nextJ2Slot(new Date(Date.UTC(3000, 0, 1)))).toThrow(RangeError);
      expect(() => nextJ2Slot(new Date(8.64e15))).toThrow(RangeError);
    });

    it("handles the leap day", () => {
      // Monday 2028-02-28 20:00 Paris -> Tuesday 29 February 20:00 is closed -> Wednesday 1 March 09:00.
      expect(due("2028-02-28T19:00:00Z")).toBe("2028-03-01T08:00:00.000Z");
    });
  });

  describe("determinism", () => {
    it("does not mutate sentAt and returns a new Date", () => {
      const sent = utc("2026-10-26T22:00:00Z");
      const before = sent.getTime();
      const result = nextJ2Slot(sent);
      expect(sent.getTime()).toBe(before);
      expect(result).not.toBe(sent);
    });

    it("ignores the ambient system time zone", async () => {
      const original = process.env.TZ;
      try {
        for (const zone of ["UTC", "America/Los_Angeles", "Pacific/Auckland", "Asia/Kolkata", "Europe/Paris"]) {
          process.env.TZ = zone;
          vi.resetModules(); // the module caches its Intl formatter: re-import so a formatter built without an explicit zone would pick up this one
          const fresh = await import("./j2-calendar");
          expect(new Date(0).getTimezoneOffset() === 0, zone).toBe(zone === "UTC"); // guards the guard: the process zone really changed
          for (const example of EXAMPLES) expect(fresh.nextJ2Slot(utc(example.sentUtc)).toISOString(), `${zone} ${example.label}`).toBe(example.dueUtc);
        }
      } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
        vi.resetModules();
      }
    });

    it("never reads the clock", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(utc("2031-07-14T03:00:00Z"));
        const now = vi.spyOn(Date, "now");
        expect(due("2026-10-26T22:00:00Z")).toBe("2026-10-28T08:00:00.000Z");
        expect(now).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// Independent oracle: scans forward hour by hour with a separately built formatter, instead of reusing the module's day-stepping.
const oracleFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", hourCycle: "h23",
});
function isOpen(ms: number) {
  const p = Object.fromEntries(oracleFormat.formatToParts(ms).map((part) => [part.type, part.value]));
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  return Number(p.hour) >= 9 && Number(p.hour) < 18;
}
function oracle(sentMs: number) {
  const earliest = sentMs + J2_MIN_DELAY_MS;
  if (isOpen(earliest)) return earliest;
  let probe = Math.ceil(earliest / 3_600_000) * 3_600_000; // slots can only open on a whole UTC hour
  while (!isOpen(probe)) probe += 3_600_000;
  return probe;
}

describe("nextJ2Slot - sweep against an independent oracle", () => {
  it("matches over 2026-2027 sent every 113 minutes", () => {
    let checked = 0;
    for (let sent = Date.UTC(2026, 0, 1); sent < Date.UTC(2028, 0, 1); sent += 113 * 60_000) {
      const expected = oracle(sent);
      const actual = nextJ2Slot(new Date(sent)).getTime();
      if (actual !== expected) throw new Error(`sent ${new Date(sent).toISOString()}: ${new Date(actual).toISOString()} != ${new Date(expected).toISOString()}`);
      expect(actual).toBeGreaterThanOrEqual(sent + J2_MIN_DELAY_MS);
      checked += 1;
    }
    expect(checked).toBe(9303);
  });

  it("matches minute by minute through both 2026 DST switch days", () => {
    for (const [from, to] of [[Date.UTC(2026, 2, 27), Date.UTC(2026, 2, 31)], [Date.UTC(2026, 9, 23), Date.UTC(2026, 9, 27)]]) {
      for (let sent = from; sent < to; sent += 60_000) {
        expect(nextJ2Slot(new Date(sent)).getTime()).toBe(oracle(sent));
      }
    }
  });
});
