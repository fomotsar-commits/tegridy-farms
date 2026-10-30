// The all-time volume counter, every five minutes: the vercel.json cron calls this, so the
// home page's figure is minutes old instead of hours. It is the same count as the hourly
// GitHub job (scripts/venue-volume.mjs), which stays as the backup. When both run at once,
// the row's version lets one write and the other writes nothing, so no swap counts twice.
//
//   GET /api/venue-volume-count   → Vercel cron only (Authorization: Bearer CRON_SECRET)
//
// Without CRON_SECRET set it counts nothing (503), and the hourly job carries on alone.
// Each source gets 20 seconds: a five-minute run has only a few minutes of swaps to read.
import { timingSafeEqual } from "node:crypto";
import { main } from "../scripts/venue-volume.mjs";
import { EVM_CHAINS, evmRpc, solanaRpc } from "../scripts/lib/venue-volume-chain.mjs";
import { logSafe } from "./_lib/logSafe.js";

const SOURCE_BUDGET_MS = 20_000;

function bearerMatches(req, secret) {
  const got = Buffer.from(String(req.headers?.authorization || ""));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export default async function handler(req, res, { run = main, fetchImpl = globalThis.fetch } = {}) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return res.status(503).json({ error: "The counter is not set up." });
  if (!bearerMatches(req, secret)) return res.status(401).json({ error: "Not allowed." });

  const lines = [];
  const note = (m) => lines.push(logSafe(String(m)));
  const code = await run({
    env: {
      SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
      SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    },
    fetchImpl,
    // The keyed RPC when there is one: Vercel's shared addresses are throttled on the public one.
    deps: {
      solana: solanaRpc({ fetchImpl, url: process.env.SOLANA_RPC_URL || undefined, pauseMs: 100 }),
      evm: (name) => evmRpc({ fetchImpl, rpcs: EVM_CHAINS[name].rpcs, pauseMs: 100 }),
      fetchImpl,
    },
    budgetMs: SOURCE_BUDGET_MS,
    log: note,
    error: note,
  }).catch((e) => {
    note(`the count stopped: ${e?.message ?? e}`);
    return 1;
  });
  console.log(`[venue-volume-count] exit ${code}\n${lines.join("\n")}`);
  return res.status(code === 0 ? 200 : 502).json({ ok: code === 0 });
}
