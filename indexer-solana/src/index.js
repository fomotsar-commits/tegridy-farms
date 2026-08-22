// Entry point. Boot, then tick forever.
//
// An unconfigured deploy STARTS. It reports what it is missing on /ready, it
// writes nothing, and it exits non-zero only when it cannot even reach the
// database — because there is nowhere to record the fact that it is broken.
// Crash-looping on a missing variable would leave the operator with a restart
// counter and no message; worse, a process that came up with an empty watch
// set and answered /ready with 200 would be publishing "no Solana trades" as a
// finding.

import { loadConfig } from "./config.js";
import { createSolanaRpc } from "./rpc.js";
import { createStore } from "./store.js";
import { createPgClient, schemaIsApplied } from "./db.js";
import { createStatusServer } from "./health.js";
import { runTick } from "./ingest.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const config = loadConfig();

  for (const problem of config.problems) {
    console.warn(`[solana-indexer] not configured: ${problem}`);
  }

  if (!config.databaseUrl) {
    console.error("[solana-indexer] no database to write to and nowhere to record that. Exiting.");
    process.exit(1);
  }

  const ingestClient = await createPgClient(config.databaseUrl, {
    applicationName: "tegridy-solana-ingest",
  });
  if (!(await schemaIsApplied(ingestClient))) {
    console.error(
      "[solana-indexer] solana_* tables are absent. Run `npm run migrate` in indexer-solana/ " +
        "against this database first (indexer-solana/DEPLOY.md §2).",
    );
    process.exit(1);
  }

  const store = createStore(ingestClient);

  if (config.statusPort !== null) {
    const statusClient = await createPgClient(config.databaseUrl, {
      applicationName: "tegridy-solana-status",
    });
    const statusStore = createStore(statusClient);
    createStatusServer({
      readStatus: () => statusStore.readStatus(),
      config,
      staleAfterMs: config.staleAfterMs,
    }).listen(config.statusPort, () => {
      console.log(`[solana-indexer] status listener on :${config.statusPort} (/health /ready /status)`);
    });
  }

  if (config.watches.length > 0) {
    await store.syncWatches(config.watches);
    await store.declareLimitations(config.watches);
  }

  if (config.rpcUrls.length === 0 || config.watches.length === 0) {
    // Deliberately not an exit. /ready stays 503 with the reason, the operator
    // fixes the env, and a redeploy — not a restart loop — turns it on.
    console.warn("[solana-indexer] nothing to index; idling with /ready reporting the reason.");
    return;
  }

  const rpc = createSolanaRpc({
    urls: config.rpcUrls,
    onRotate: (url, e) => console.warn(`[solana-indexer] rotating off ${new URL(url).host}: ${e.message}`),
  });

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (!stopping) {
    const started = Date.now();
    try {
      const { summaries, errors } = await runTick({
        rpc,
        store,
        watches: config.watches,
        pageLimit: config.signaturePageLimit,
        maxPages: config.maxPagesPerTick,
      });
      for (const s of summaries) {
        if (s.fetched > 0 || s.gaps > 0) {
          console.log(
            `[solana-indexer] ${s.pool} read=${s.fetched} trades=${s.trades} claims=${s.claims} gaps=${s.gaps}`,
          );
        }
      }
      for (const e of errors) console.warn(`[solana-indexer] ${e}`);
    } catch (e) {
      // recordTick already carries per-watch errors; this catches the case
      // where recording itself failed, which is the one that must be loud.
      console.error(`[solana-indexer] tick aborted: ${e.message}`);
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(0, config.pollIntervalMs - elapsed));
  }

  await ingestClient.end();
}

main().catch((e) => {
  console.error(`[solana-indexer] fatal: ${e.stack ?? e.message}`);
  process.exit(1);
});
