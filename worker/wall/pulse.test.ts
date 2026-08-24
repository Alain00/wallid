import { describe, expect, test } from "bun:test";
import { beat, here, pseudonym, visitorsByDay, type AnalyticsEngineDataset } from "./pulse";

const DAY = 86_400_000;
/** Noon UTC, so the day-boundary tests below move a day without a timezone
 * being able to argue about which day it was. */
const AT = Math.floor(1_770_000_000_000 / DAY) * DAY + DAY / 2;

const secret = "pepper";
const address = "203.0.113.7";
const agent = "Mozilla/5.0 (a browser)";

/** A dataset that keeps what was written, so a test can look at the row rather
 * than at the fact that something happened. */
function recorder() {
  const points: Parameters<AnalyticsEngineDataset["writeDataPoint"]>[0][] = [];
  return {
    points,
    writeDataPoint: (point: (typeof points)[number]) => void points.push(point),
  };
}

const request = (headers: Record<string, string> = { "CF-Connecting-IP": address }) =>
  new Request("https://wallid.lol/wall/i", {
    headers: { "User-Agent": agent, ...headers },
  });

describe("the pseudonym", () => {
  test("is the same person twice within a day", async () => {
    expect(await pseudonym(secret, address, agent, AT)).toBe(
      await pseudonym(secret, address, agent, AT + 3_600_000),
    );
  });

  test("rotates at midnight, so days cannot be joined into a history", async () => {
    expect(await pseudonym(secret, address, agent, AT)).not.toBe(
      await pseudonym(secret, address, agent, AT + DAY),
    );
  });

  test("separates two agents behind one address, because they are two people", async () => {
    expect(await pseudonym(secret, address, agent, AT)).not.toBe(
      await pseudonym(secret, address, "Mozilla/5.0 (another browser)", AT),
    );
  });

  test("is peppered, so the stored value is not a hash of an IP anyone can reverse", async () => {
    expect(await pseudonym(secret, address, agent, AT)).not.toBe(
      await pseudonym("another pepper", address, agent, AT),
    );
  });

  test("is sixteen hex characters", async () => {
    expect(await pseudonym(secret, address, agent, AT)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("a heartbeat", () => {
  test("writes the visitor as both index and blob, and a country", async () => {
    const dataset = recorder();
    const cf = Object.assign(request(), { cf: { country: "PT" } });
    await beat(cf, { PULSE: dataset, WALL_SECRET: secret }, AT);

    const visitor = await pseudonym(secret, address, agent, AT);
    expect(dataset.points).toEqual([{ indexes: [visitor], blobs: [visitor, "PT"], doubles: [1] }]);
  });

  test("writes one row per beat, all under one visitor", async () => {
    const dataset = recorder();
    const env = { PULSE: dataset, WALL_SECRET: secret };
    await beat(request(), env, AT);
    await beat(request(), env, AT + 30_000);

    expect(dataset.points).toHaveLength(2);
    expect(dataset.points[0]!.blobs![0]).toBe(dataset.points[1]!.blobs![0]!);
  });

  test("does not count a request with no address", async () => {
    // Every request in local development, and the reason this is a refusal
    // rather than an empty-string bucket: one bucket holding every uncounted
    // visitor would read as a single extremely busy person.
    const dataset = recorder();
    await beat(request({}), { PULSE: dataset, WALL_SECRET: secret }, AT);
    expect(dataset.points).toEqual([]);
  });

  test("is a no-op with no dataset bound, so the dev server still serves the wall", async () => {
    await beat(request(), { WALL_SECRET: secret }, AT);
  });
});

/**
 * The read, which is the half a stranger sees. Every failure here has to end as
 * `null` — a chip that does not appear — because the alternative is an
 * analytics API's bad minute becoming a 500 on the wall, or worse, "0 people
 * here" printed for the one person who is definitely there.
 */
describe("the live count", () => {
  const creds = { PULSE_ACCOUNT_ID: "acc", PULSE_READ_TOKEN: "tok" };

  /** A fetch that answers with one Analytics Engine reply and remembers what it
   * was asked. */
  const answering = (body: unknown, status = 200) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  };

  /** Nothing should reach the network at all when the answer is knowable
   * without it. */
  const never = (() => {
    throw new Error("must not ask");
  }) as unknown as typeof fetch;

  test("reads the count out of the row", async () => {
    const { fetcher, calls } = answering({ data: [{ here: 7 }] });
    expect(await here(creds, fetcher)).toBe(7);

    const [call] = calls;
    expect(call!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/analytics_engine/sql");
    expect((call!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    // The window, and the column the script reads too. If either moves, the
    // chip and `bun run pulse` start disagreeing about who is here.
    expect(String(call!.init.body)).toContain("count(DISTINCT blob1)");
    expect(String(call!.init.body)).toContain("INTERVAL '90' SECOND");
    expect(String(call!.init.body)).toContain("wallid_pulse");
  });

  test("an empty wall is zero, which is a real answer", async () => {
    const { fetcher } = answering({ data: [{ here: 0 }] });
    expect(await here(creds, fetcher)).toBe(0);
  });

  test("counts come back as strings often enough to be worth rounding", async () => {
    const { fetcher } = answering({ data: [{ here: "12" }] });
    expect(await here(creds, fetcher)).toBe(12);
  });

  test("says nothing without credentials, rather than failing", async () => {
    expect(await here({}, never)).toBeNull();
    expect(await here({ PULSE_ACCOUNT_ID: "acc" }, never)).toBeNull();
    expect(await here({ PULSE_READ_TOKEN: "tok" }, never)).toBeNull();
  });

  test("refuses a dataset name that is not an identifier", async () => {
    expect(await here({ ...creds, PULSE_DATASET: "x; DROP TABLE y" }, never)).toBeNull();
  });

  test("a refused read is silence, not an error", async () => {
    const fetcher = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    expect(await here(creds, fetcher)).toBeNull();
  });

  /* Analytics Engine answers errors with a 200 and an error body about as often
   * as it answers with a status. */
  test("a 200 that is not a row is silence too", async () => {
    const fetcher = (async () => new Response("an error, in prose")) as unknown as typeof fetch;
    expect(await here(creds, fetcher)).toBeNull();

    const empty = (async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch;
    expect(await here(creds, empty)).toBeNull();
  });

  test("a throwing fetch — offline, or the timeout firing — is silence", async () => {
    const fetcher = (async () => {
      throw new Error("aborted");
    }) as unknown as typeof fetch;
    expect(await here(creds, fetcher)).toBeNull();
  });
});

/**
 * The rollup's read. Its failures are quieter than the live count's — nothing
 * is waiting on a cron — but they matter more: a day this misses is a day
 * missing from a total that is supposed to mean "since launch", forever. Which
 * is why the query looks back further than the schedule and every row is
 * upserted rather than inserted.
 */
describe("the daily rollup", () => {
  const creds = { PULSE_ACCOUNT_ID: "acc", PULSE_READ_TOKEN: "tok" };
  const answering = (body: unknown, status = 200) => {
    const calls: { init: RequestInit }[] = [];
    const fetcher = (async (_url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ init });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  };

  /* 2026-08-24 is 20689 days after the epoch. Written out rather than computed
   * from `Date`, so the test asserts the arithmetic rather than repeating it. */
  const rows = {
    data: [
      { day: "2026-08-22 00:00:00", visitors: 41 },
      { day: "2026-08-23 00:00:00", visitors: 128 },
      { day: "2026-08-24 00:00:00", visitors: 7 },
    ],
  };

  test("turns each day into a day number and a count", async () => {
    const { fetcher, calls } = answering(rows);
    expect(await visitorsByDay(creds, fetcher)).toEqual([
      { day: 20687, visitors: 41 },
      { day: 20688, visitors: 128 },
      { day: 20689, visitors: 7 },
    ]);

    const body = String(calls[0]!.init.body);
    // Grouped in UTC, which is the midnight the pseudonym rotates at. Anything
    // else splits a visitor across two rows.
    expect(body).toContain("toStartOfDay(timestamp)");
    expect(body).toContain("count(DISTINCT blob1)");
    // Further back than the hourly schedule, so a missed run heals itself.
    expect(body).toContain("INTERVAL '3' DAY");
  });

  test("the day number is the one the pseudonym rotates on", async () => {
    const { fetcher } = answering(rows);
    const days = (await visitorsByDay(creds, fetcher))!;
    // Same arithmetic as `dayOf`, reached from the other direction.
    expect(days[2]!.day).toBe(Math.floor(Date.parse("2026-08-24T00:00:00Z") / 86_400_000));
  });

  test("drops a row it cannot read rather than the whole day's work", async () => {
    const { fetcher } = answering({
      data: [{ day: "not a date", visitors: 5 }, { day: "2026-08-24 00:00:00", visitors: 9 }],
    });
    expect(await visitorsByDay(creds, fetcher)).toEqual([{ day: 20689, visitors: 9 }]);
  });

  test("says nothing without credentials, and does not ask", async () => {
    const never = (() => {
      throw new Error("must not ask");
    }) as unknown as typeof fetch;
    expect(await visitorsByDay({}, never)).toBeNull();
  });

  test("a refusal is null, not an empty day", async () => {
    const { fetcher } = answering("nope", 500);
    expect(await visitorsByDay(creds, fetcher)).toBeNull();

    const { fetcher: prose } = answering("an error, in prose");
    expect(await visitorsByDay(creds, prose)).toBeNull();
  });
});
