#!/usr/bin/env node
// Score the site's Jupiter swaps that are new since the last run: Jupiter's quote against
// what reached the trader, both read from the chain.
//
// Run every hour by .github/workflows/fill-scoreboard.yml, with SUPABASE_URL and
// SUPABASE_SERVICE_KEY. By hand, from the repo root, with those two set:
//   node frontend/scripts/fill-scoreboard.mjs
// `--dry-run` needs no secrets: it reads all of history, prints the 30-day summary and the
// swaps it could not score, and writes nothing.
//
// Rows are upserted by signature BEFORE the cursor moves, so a run that fails partway is
// read again by the next one and changes nothing twice. Exit 1 when the run did not finish.

import { pathToFileURL } from "node:url";
import { solanaRpc } from "./lib/venue-volume-chain.mjs";
import { readFills } from "./lib/fill-scoreboard-chain.mjs";
import { postgrest } from "./venue-volume.mjs";
import { summarize } from "../api/_lib/fillScoreboardPolicy.js";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"];
const SOURCE = "jupiter";
const CHUNK = 500;

async function writeCursor(db, row, next) {
  if (row) {
    const r = await db(`fill_scoreboard_cursor?source=eq.${SOURCE}&version=eq.${row.version}`, {
      method: "PATCH",
      body: JSON.stringify({ ...next, version: row.version + 1 }),
    });
    if (r.status !== 200 || !Array.isArray(r.body) || r.body.length !== 1) {
      throw new Error(`cursor write refused (HTTP ${r.status}); another run may have moved it first`);
    }
    return;
  }
  const r = await db("fill_scoreboard_cursor", { method: "POST", body: JSON.stringify({ source: SOURCE, ...next, version: 1 }) });
  if (r.status !== 201) throw new Error(`first cursor write refused (HTTP ${r.status})`);
}

export async function main({
  env = process.env,
  fetchImpl = globalThis.fetch,
  call = null,
  log = console.log,
  error = console.error,
  dryRun = false,
  nowMs = Date.now(),
} = {}) {
  const rpc = call ?? solanaRpc({ fetchImpl });
  if (dryRun) {
    const got = await readFills(rpc, {});
    log(JSON.stringify(summarize(got.rows, { counted_to: got.countedTo, last_ok_at: got.countedTo }, nowMs), null, 1));
    for (const r of got.rows.filter((x) => x.unread_reason)) log(`not scored: ${r.signature} (${r.unread_reason})`);
    log(`${got.rows.length} fee-paying swap(s) in all of history`);
    return 0;
  }
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    error(`::error title=Fill scoreboard not configured::Missing repo secrets: ${missing.join(" ")}. Nothing was scored.`);
    return 1;
  }
  const db = postgrest(env, fetchImpl);
  const read = await db("fill_scoreboard_cursor?select=*").catch((e) => ({ status: 0, body: { message: e.message } }));
  if (read.status === 404 || read.body?.code === "PGRST205" || read.body?.code === "42P01") {
    log("::notice title=fill_scoreboard does not exist yet::Migration 029 has not been applied, so there is nowhere to write.");
    return 0;
  }
  if (read.status !== 200 || !Array.isArray(read.body)) {
    error(`::error title=Fill scoreboard could not read its cursor::HTTP ${read.status}. Nothing was scored.`);
    return 1;
  }
  const row = read.body.find((r) => r.source === SOURCE) ?? null;
  try {
    const got = await readFills(rpc, row?.cursor ?? {});
    for (let i = 0; i < got.rows.length; i += CHUNK) {
      const r = await db("fill_scoreboard?on_conflict=signature", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(got.rows.slice(i, i + CHUNK)),
      });
      if (r.status !== 201 && r.status !== 204) throw new Error(`rows refused (HTTP ${r.status})`);
    }
    const now = new Date().toISOString();
    await writeCursor(db, row, { cursor: got.cursor, counted_to: got.countedTo, last_ok_at: now, last_error: null });
    const unscored = got.rows.filter((r) => r.unread_reason).length;
    log(`jupiter: +${got.rows.length} swap(s)${unscored ? `, ${unscored} not scored` : ""}`);
    return 0;
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 300);
    error(`::error title=Fill scoreboard not updated::${msg}`);
    if (row) {
      await db(`fill_scoreboard_cursor?source=eq.${SOURCE}`, {
        method: "PATCH",
        body: JSON.stringify({ last_error: msg, last_error_at: new Date().toISOString() }),
      }).catch(() => {});
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main({ dryRun: process.argv.includes("--dry-run") });
}
