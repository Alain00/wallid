import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import type { D1Database, D1PreparedStatement } from "./db";

/**
 * D1, as `bun:sqlite`.
 *
 * Two callers, and they want it for the same reason. The tests want it because
 * a mock cannot fail the way this feature depends on failing: every rule the
 * wall has (one cell to one holder, one settle per Stripe event) is a
 * uniqueness constraint rather than a check in application code, so a suite
 * that stubs the database out asserts the happy path and nothing else. The dev
 * server wants it because `bun run site` is a `Bun.serve`, not a Worker, and
 * without this the wall's endpoints simply are not there — the landing page
 * spends development looking like a wall nobody has ever written to.
 *
 * Both get the real SQL over the real migrations against the engine D1 is. What
 * neither gets is the network: no latency, no subrequest limits, and `batch` is
 * a local transaction rather than a remote one. `wrangler dev` is still the
 * thing to reach for when the question is about Cloudflare rather than about
 * the wall.
 */

const MIGRATIONS = new URL("./migrations/", import.meta.url).pathname;

/**
 * The migrations, in the order wrangler would apply them — filename order,
 * which is what `0001_` is for.
 *
 * Which ones have run is recorded, because unlike the tests the dev server
 * keeps its database between boots and `CREATE TABLE` twice is an error. The
 * table is deliberately not the one wrangler uses: this is a local scratch
 * database, and pretending its bookkeeping is wrangler's would invite somebody
 * to trust it.
 */
export function migrate(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS dev_migrations (name TEXT PRIMARY KEY)");
  const done = new Set(
    (db.query("SELECT name FROM dev_migrations").all() as { name: string }[]).map(row => row.name),
  );
  for (const file of readdirSync(MIGRATIONS).filter(name => name.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    db.exec(readFileSync(MIGRATIONS + file, "utf8"));
    db.query("INSERT INTO dev_migrations (name) VALUES (?1)").run(file);
  }
}

/** A prepared statement that has kept hold of its own SQL, so that `batch` can
 * run it synchronously inside a transaction rather than awaiting a promise it
 * would have to unwrap. */
type Bound = D1PreparedStatement & { sql: string; values: unknown[] };

/**
 * A database that answers D1's shape. In memory by default; the dev server
 * passes a path so a wall survives a restart.
 *
 * `bun:sqlite` binds `?1`-style parameters from a positional array, which is
 * the same thing D1's `.bind()` does, so the statements in `db.ts` are the
 * strings that ship rather than a translation of them.
 */
export function sqliteD1(path = ":memory:"): D1Database & { raw: Database } {
  const db = new Database(path, { create: true });
  migrate(db);

  const run = (sql: string, values: unknown[]) => db.query(sql).run(...(values as never[]));

  const statement = (sql: string, values: unknown[] = []): Bound => ({
    sql,
    values,
    bind: (...next: unknown[]) => statement(sql, next),
    all: async <T>() => ({ results: db.query(sql).all(...(values as never[])) as T[] }),
    first: async <T>() => (db.query(sql).get(...(values as never[])) as T) ?? null,
    run: async () => ({ meta: { changes: run(sql, values).changes } }),
  });

  return {
    raw: db,
    prepare: (sql: string) => statement(sql),
    /**
     * A transaction, because that is what D1's is — sequential, non-concurrent,
     * and rolled back whole if any statement fails. The settle path leans on
     * exactly that: the payment row is written before any cell is taken, so a
     * redelivered webhook loses its primary key and the whole batch unwinds.
     */
    batch: async <T>(statements: D1PreparedStatement[]) => {
      const all = statements as Bound[];
      db.transaction(() => {
        for (const each of all) run(each.sql, each.values);
      })();
      return all.map(() => ({ results: [] as T[] }));
    },
  };
}
