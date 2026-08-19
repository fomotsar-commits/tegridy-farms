// Apply sql/001_solana_tables.sql. Idempotent; safe to re-run.
//
// Kept as a separate entry point rather than something the service does at
// boot, because DDL rights and runtime rights are not the same grant and an
// operator is entitled to give this process only the second one.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { createPgClient } from "./db.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function migrate(client) {
  const sql = await readFile(join(HERE, "..", "sql", "001_solana_tables.sql"), "utf-8");
  await client.query(sql);
}

if (process.argv[1] && process.argv[1].endsWith("migrate.js")) {
  const config = loadConfig();
  if (!config.databaseUrl) {
    console.error(
      "[solana-indexer] no DATABASE_PRIVATE_URL or DATABASE_URL — nothing to migrate. " +
        "See indexer-solana/.env.local.example.",
    );
    process.exit(1);
  }
  const client = await createPgClient(config.databaseUrl, { applicationName: "tegridy-solana-migrate" });
  try {
    await migrate(client);
    console.log("[solana-indexer] schema applied");
  } finally {
    await client.end();
  }
}
