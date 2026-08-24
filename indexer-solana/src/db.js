// Postgres connections, and the reason there are two of them.
//
// `pg` is imported DYNAMICALLY. Every module in src/ except this one is
// dependency-free and therefore testable without a database driver installed;
// a top-level `import pg` here would drag the driver into the import graph of
// the unit tests, which have no use for it.
//
// TWO CLIENTS, NOT A POOL. store.js writes each signature inside an explicit
// BEGIN/COMMIT, and a Pool hands out a different connection per query — the
// BEGIN would land on one backend and the COMMIT on another, so the
// transaction that makes the cursor advance atomic with its rows would silently
// not be one. A single Client serialises its queries onto one backend, which is
// exactly what that guarantee needs.
//
// The status listener gets its own client for the mirror-image reason: a SELECT
// issued on the ingest client while a commit is open would be queued INTO that
// transaction and would report uncommitted state as fact.

/**
 * @param {string} connectionString
 * @param {{ applicationName?: string }} [opts]
 */
export async function createPgClient(connectionString, opts = {}) {
  const pg = (await import("pg")).default ?? (await import("pg"));
  const client = new pg.Client({
    connectionString,
    application_name: opts.applicationName ?? "tegridy-indexer-solana",
    // Managed Postgres (Railway, Supabase, Neon) terminates plaintext.
    // `rejectUnauthorized: false` matches how those providers issue certs;
    // it is transport encryption without host verification, not a hardening
    // claim — the connection string itself is the secret.
    ssl: /\bsslmode=disable\b/.test(connectionString) ? false : { rejectUnauthorized: false },
  });
  // AUDIT FIX 2026-08-24: a node-postgres Client with no 'error' listener turns
  // an idle-connection reset (server restart, LB idle timeout) into either an
  // uncaught 'error' event crash or — after node 16 — a zombified client whose
  // every query rejects while /health keeps answering 200. There is no
  // in-place reconnect for a Client mid-transaction, and the cursor design
  // makes restarts free (per-signature atomic commits), so the honest move is
  // a loud exit and a supervisor restart — never a silent zombie.
  client.on("error", (err) => {
    console.error(
      `[db] postgres connection lost (${opts.applicationName ?? "tegridy-indexer-solana"}): ${err.message} — exiting for a clean supervisor restart`,
    );
    process.exit(1);
  });
  await client.connect();
  return client;
}

/**
 * Does the schema exist?
 *
 * Called at boot so a deploy against a database that never had sql/001 applied
 * fails immediately with the command to run, rather than throwing "relation
 * solana_watch does not exist" once per tick forever while /health answers 200.
 */
export async function schemaIsApplied(client) {
  const { rows } = await client.query(`SELECT to_regclass('solana_watch') AS t`);
  return Boolean(rows?.[0]?.t);
}
