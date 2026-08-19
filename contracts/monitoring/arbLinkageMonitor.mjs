#!/usr/bin/env node
// Arb-linkage monitor — the load-bearing safety condition for the core-loop
// oracle unlock (docs/GOLIVE_CORELOOP.md §"Conditions", B4 / condition 3).
//
// The TWAP oracle reads the NATIVE TOWELI/WETH pool. That pool is safe from
// price manipulation ONLY while a DEEPER, arb-linked venue (the UNCX-locked
// Uniswap TOWELI/WETH pool) keeps it honest — an attacker who pumps the native
// pool is arbed back by anyone bridging price from Uniswap, making a sustained
// TWAP dislocation EV-negative. The adversarial review's load-bearing assumption
// is: "the native pool is NOT the only liquid venue."
//
// This monitor makes that assumption OBSERVABLE. It compares the WETH depth of
// the two pools and emits GO / WARN / HALT:
//   - HALT  (exit 2): Uniswap WETH depth < 3x native, or either venue cannot
//                     quote -> manipulation cost collapses.
//                     ACTION: `node scripts/monitoring/arbPauseConsumer.mjs`
//                     renders the exact privileged call to make.
//   - WARN  (exit 1): < 4x, or native below the live floor -> react before HALT.
//   - GO    (exit 0): >= 4x and native above the floor -> the arb linkage holds.
//   - ERROR (exit 2): could not read. UNKNOWN, never healthy.
//
// The rule and the chain reads live in lib/arbLinkage.mjs so this monitor and
// the pause-preparation consumer cannot drift apart on what "broken" means.
//
// Dependency-free: raw JSON-RPC over fetch (node >= 18). Keyless RPC roster with
// fallback (publicnode/drpc/merkle live; ankr/cloudflare/llamarpc dead — do not
// re-add). Read-only; it NEVER signs.
//
// USAGE:
//   node arbLinkageMonitor.mjs            # human-readable, exit code = severity
//   node arbLinkageMonitor.mjs --json     # machine-readable line for alerting/cron

import { publicResult, readLinkage, renderHuman, resolveConfig } from './lib/arbLinkage.mjs';

const JSON_OUT = process.argv.includes('--json');

async function main() {
  const result = await readLinkage(resolveConfig());
  // publicResult, not the raw reading: this line gets redirected into logs and
  // pasted into tickets, and $RPC may be a keyed endpoint.
  if (JSON_OUT) console.log(JSON.stringify(publicResult(result)));
  else console.log(renderHuman(result));
  // Set exitCode + let the (now handle-free) loop drain naturally — avoids the
  // process.exit()/libuv close race that crashes on Windows.
  process.exitCode = result.code;
}

main().catch((e) => {
  // Unreachable by design: readLinkage converts every read failure into an ERROR
  // reading. Retained because the alternative to a loud crash here is an
  // unhandled rejection, which on some node versions still exits 0.
  const at = new Date().toISOString();
  if (JSON_OUT) console.log(JSON.stringify({ status: 'ERROR', code: 2, reason: `monitor crashed: ${e.message || e}`, unreadable: [], at }));
  else console.error(`ERROR (treat as HALT) — monitor crashed: ${e.message || e}`);
  process.exitCode = 2;
});
