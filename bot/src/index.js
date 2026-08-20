// The process. Boot checks, a long-poll loop, and nothing else.
//
// THIS FILE IS NOT DEPLOYED BY THIS REPO. The bot is a long-running service and it
// runs where the operator puts it — see bot/DEPLOY.md, which is written the way
// indexer/DEPLOY.md is and for the same reason: everything up to the hosting
// decision is done here, and the hosting decision costs money and creates an
// account this repo cannot create.
//
// WHAT IT DOES NOT DO, because a service that quietly does less than its logs
// suggest is the failure this venue keeps writing guards against:
//
//   * It does not run a schedule. There is no timer here that watches a price, a
//     rule or a position. The venue has no keeper, so nothing in this process can
//     deliver an alert, and /alerts says exactly that to any user who asks.
//   * It does not persist anything. The update offset lives in memory; a restart
//     resumes from Telegram's own backlog. There is no local database, so there is
//     no local database to leak.
//   * It does not hold, derive, decrypt or transmit a key. There is no code path
//     to, and frontend/api/__tests__/bot-noncustodial.test.js fails the build if
//     one appears.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig, fatalConfigProblems, describeCapabilities } from "./config.js";
import { deriveChatRef } from "./chatRef.js";
import { Telegram, extractMessage } from "./telegram.js";
import { handleMessage } from "./commands.js";
import { beginLink, readLink, revokeLink, readHeat } from "./venueClient.js";
import { recentSwaps } from "./indexerClient.js";

/** Backoff ceiling for a failing poll. Long enough to ride out a venue restart. */
const MAX_BACKOFF_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function preflight(cfg) {
  const fatal = fatalConfigProblems(cfg);
  for (const line of fatal) console.error(`FATAL: ${line}`);
  for (const cap of describeCapabilities(cfg)) {
    console.log(`${cap.available ? "[ on ]" : "[ off]"} ${cap.label} — ${cap.detail}`);
  }
  console.log(`venue: ${cfg.venueOrigin}`);
  console.log(`app:   ${cfg.appOrigin}`);
  return fatal.length === 0;
}

export async function main(argv = process.argv.slice(2)) {
  const cfg = loadConfig();
  const ok = preflight(cfg);
  if (argv.includes("--preflight")) return ok ? 0 : 1;
  if (!ok) return 1;

  const tg = new Telegram(cfg.botToken);
  const me = await tg.whoAmI();
  console.log(`connected as @${me.username}`);

  const deps = {
    cfg,
    venue: { beginLink, readLink, revokeLink, readHeat },
    indexer: { recentSwaps },
  };

  let offset = 0;
  let backoff = 1000;
  for (;;) {
    let updates;
    try {
      updates = await tg.getUpdates(offset, cfg.pollTimeoutSec);
      backoff = 1000;
    } catch (err) {
      // Never the update payload — see telegram.js. A poll failure is about the
      // connection, and the message that would have been in it may be one the
      // user should not have sent.
      console.error(`poll failed: ${err.message}`);
      await sleep(Math.min(backoff, MAX_BACKOFF_MS));
      backoff *= 2;
      continue;
    }

    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      const msg = extractMessage(update);
      if (!msg) continue;

      let reply;
      try {
        reply = await handleMessage(
          { text: msg.text, chatRef: deriveChatRef(cfg.linkSecret, msg.userId) },
          deps,
        );
      } catch (err) {
        // The router's own failure. Answer rather than going silent: a user who
        // gets nothing back assumes the command worked.
        console.error(`router error: ${err.message}`);
        reply = { text: "Something failed on my side and I could not answer that. Nothing was changed." };
      }

      try {
        await tg.sendMessage(msg.chatId, reply.text);
      } catch (err) {
        console.error(`send failed: ${err.message}`);
      }
    }
  }
}

// Entry guard so the module can be imported by a test without launching a poll
// loop. Compared as resolved PATHS rather than as URL strings: a hand-built
// `file://` URL and Node's own differ on Windows drive letters, and the failure of
// that comparison is silent — the module imports, the loop never starts, and the
// process exits 0 looking healthy.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code ?? 0));
}
