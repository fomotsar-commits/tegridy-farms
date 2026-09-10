#!/usr/bin/env node
/**
 * AUDIT R081 — `npm run e2e` orchestrator: spawn Anvil fork + run Playwright.
 *
 * ⚠ THIS SCRIPT SPENT ITS WHOLE LIFE UNREACHABLE. Its usage block said
 * `pnpm e2e`; this repo is npm, and no `e2e` script existed in
 * frontend/package.json under any name. So the harness that un-skips the
 * state-changing money-path specs shipped complete and was never once invoked
 * — which is why "40 money-path E2E tests are skipped" read as an operator
 * choice rather than a missing one-line script. It is `npm run e2e` now, and
 * .github/workflows/ci.yml runs it.
 *
 * What this does:
 *   1. Resolves an RPC fork URL from $ANVIL_FORK_URL (default: a keyless
 *      public mainnet endpoint that is verified to serve real state).
 *   2. Spawns `anvil` with deterministic mnemonic ("test test ... junk") so
 *      account #9 (0x71be...5788) lines up with DEFAULT_ACCOUNT in
 *      e2e/fixtures/wallet.ts. NO PRIVATE KEYS are committed; Anvil derives
 *      them from the public test mnemonic at runtime.
 *   3. Sets ANVIL_RPC_URL=http://127.0.0.1:<port> so the spec gates flip, the
 *      wallet bridge forwards writes to the fork, and the fixture redirects
 *      the app's own read transports at the fork too.
 *   4. Runs `playwright test`, forwarding any CLI args, then tears Anvil down.
 *
 * Exit code mirrors Playwright's.
 *
 * Usage:
 *   npm run e2e                                  # whole suite on a fork
 *   npm run e2e -- e2e/swap.spec.ts              # one spec
 *   ANVIL_FORK_URL=https://... npm run e2e       # custom fork
 *   ANVIL_FORK_BLOCK=19000000 npm run e2e        # pin to a specific block
 *   E2E_REQUIRE_ANVIL=1 npm run e2e              # CI: no silent mock fallback
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

// THE FORK ENDPOINT IS A CONSUMABLE, NOT A CONSTANT. Two defaults have died
// here now, and each death looked like a broken test suite first.
//
//   eth.llamarpc.com   HTTP 521, no ACAO (src/lib/wagmi.ts records the same).
//   publicnode         HTTP 403 from 2026-09-09: "Archive requests require a
//                      personal token". A fork IS an archive request, so this
//                      is not a rate limit and waiting does not clear it. The
//                      repo had already met the same gate on publicnode's
//                      INDEXED requests (BungalowHolders.test.tsx:7); this is
//                      that policy reaching archive.
//
// Reproduced locally against anvil 1.5.1, not inferred from a CI log: publicnode
// fails with the exact 403 above, and drpc forks and serves a real state read
// (WETH balanceOf came back non-zero). Plain `latest` reads still work on
// publicnode, which is why every other script in this repo still points there
// and only the FORK moved.
//
// If drpc starts rate-limiting under CI load, the durable answer is a funded
// key in a repo secret rather than a fourth free endpoint.
const FORK_URL = process.env.ANVIL_FORK_URL ?? 'https://eth.drpc.org';
const FORK_BLOCK = process.env.ANVIL_FORK_BLOCK; // optional pin
const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 8545);
// CI must never take the mock-mode fallback: a runner without Foundry would
// then run the exact suite this job exists to escape, and report success.
const REQUIRE_ANVIL = ['1', 'true', 'yes'].includes(String(process.env.E2E_REQUIRE_ANVIL ?? '').toLowerCase());
const PW_ARGS = process.argv.slice(2);

// ─── Probe: is `anvil` on PATH? ──────────────────────────────────────────
async function hasAnvil() {
  return new Promise((resolve) => {
    const p = spawn(process.platform === 'win32' ? 'where' : 'which', ['anvil'], {
      stdio: 'ignore',
      shell: false,
    });
    p.on('exit', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

// ─── Probe: is the port already in use? ──────────────────────────────────
async function portFree(port) {
  return new Promise((resolve) => {
    const s = createServer().once('error', () => resolve(false)).once('listening', () => {
      s.close(() => resolve(true));
    });
    s.listen(port, '127.0.0.1');
  });
}

// Poll for the port, but ALSO lose the race the moment anvil dies. A refused
// fork kills anvil in about two seconds; the old shape ignored that and kept
// polling a port nothing would ever bind, so a policy rejection at the upstream
// reported itself as "did not bind within 20s" — a timeout, which reads as a
// slow network or a busy runner. `died()` returns anvil's exit once it has one,
// and the caller uses it to say what actually happened instead of guessing.
async function waitForPort(port, timeoutMs = 15_000, died = () => null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await portFree(port))) return true;
    if (died()) return false;
    await delay(250);
  }
  return false;
}

// ─── Name the cause, so the next occurrence is not a mystery ─────────────
//
// Every death this script has seen upstream looked the same from inside CI: a
// wall of red with no endpoint named in the headline. The 2026-09-09 publicnode
// gate sat for a full trunk run and several PRs reading as a broken money-path
// suite, when not one test had run. So the tail is CLASSIFIED before it is
// printed, and the verdict leads.
function diagnoseFork(tailText) {
  const t = String(tailText);
  const handshakeFailed = /failed to get fork block number/i.test(t);
  if (/Archive requests require a personal token/i.test(t)) {
    return 'the upstream now gates ARCHIVE requests behind a paid token — and a fork IS an archive request';
  }
  if (/\b(401|403)\b/.test(t) && handshakeFailed) {
    return 'the upstream refused the fork handshake for AUTH reasons (HTTP 401/403) — a plan or key gate, which waiting does not clear';
  }
  if (/\b429\b/.test(t) && handshakeFailed) {
    return 'the upstream RATE-LIMITED the fork handshake (HTTP 429) — this one may clear on a retry, unlike an auth gate';
  }
  if (/\b(404|410)\b/.test(t) && handshakeFailed) {
    return 'the upstream endpoint is GONE (HTTP 404/410) — the URL itself is dead, not throttled';
  }
  if (handshakeFailed) {
    return 'anvil could not complete the fork handshake with the upstream';
  }
  return null;
}

// One loud, distinctly-titled failure. `::error::` puts the verdict in the job
// summary and on the workflow-run page, where a generic timeout never appeared.
function reportForkRefused(reason, tailText, fallbackHeadline) {
  const named = reason !== null;
  const headline = named
    ? `Anvil could not fork ${FORK_URL} — ${reason}.`
    : fallbackHeadline;
  console.error('');
  console.error(
    `::error title=${named ? 'Anvil fork endpoint refused' : 'Anvil failed to start'}::${headline} ` +
      'NO TEST RAN — this is the harness failing to reach a chain, not a money-path defect. ' +
      'Set the ANVIL_FORK_URL repo secret to an RPC that serves archive reads.',
  );
  console.error('  ┌───────────────────────────────────────────────────────────────────');
  console.error(`  │ ${named ? 'ANVIL FORK ENDPOINT REFUSED' : 'ANVIL FAILED TO START'}`);
  console.error('  │');
  console.error(`  │ endpoint : ${FORK_URL}`);
  console.error(`  │ cause    : ${named ? reason : 'unknown — anvil produced no recognisable fork error'}`);
  console.error('  │');
  console.error('  │ NOT ONE TEST RAN. The money-path specs never reached Playwright, so');
  console.error('  │ a red here says nothing about swap/stake/liquidity/lending/claim.');
  console.error('  │');
  console.error('  │ To fix: set the ANVIL_FORK_URL repo secret to an RPC that serves');
  console.error('  │ ARCHIVE reads. Verify a candidate by FORKING it, never by a plain');
  console.error('  │ `latest` read — publicnode still answers `latest` and cannot fork.');
  console.error('  │   anvil --fork-url <candidate> --port 18545');
  console.error('  └───────────────────────────────────────────────────────────────────');
  console.error('  anvil said:');
  console.error(String(tailText).replace(/^/gm, '  | '));
  console.error('');
}

function spawnPlaywright(envExtra) {
  const env = { ...process.env, ...envExtra };
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  // `shell: true` on Windows is REQUIRED, not stylistic. Node >= 18.20 refuses to
  // spawn a `.cmd` without a shell (the CVE-2024-27980 mitigation) and throws
  // EINVAL, so `npm run e2e` died on Windows immediately after the fork came up:
  //   [e2e] fork ready at block 25743051
  //   [e2e] orchestrator error: Error: spawn EINVAL
  // Linux CI never saw it, which is why an orchestrator nobody could run locally
  // looked healthy. PW_ARGS is a module-level constant, never user input, so the
  // shell adds no injection surface here.
  const useShell = process.platform === 'win32';
  return spawn(cmd, ['playwright', 'test', ...PW_ARGS], { stdio: 'inherit', env, shell: useShell });
}

async function main() {
  const anvilAvailable = await hasAnvil();

  if (!anvilAvailable) {
    if (REQUIRE_ANVIL) {
      console.error('[e2e] E2E_REQUIRE_ANVIL is set and `anvil` is not on PATH.');
      console.error('[e2e] Refusing to fall back to mock-mode: that would run the money-path specs');
      console.error('[e2e] as skips and report success — the exact false-green this job exists to end.');
      process.exit(1);
    }
    console.log('[e2e] anvil not found on PATH — running specs in mock-mode.');
    console.log('[e2e] Install Foundry to enable on-chain assertions: https://book.getfoundry.sh/getting-started/installation');
    const pw = spawnPlaywright({});
    pw.on('exit', (code) => process.exit(code ?? 1));
    return;
  }

  if (!(await portFree(ANVIL_PORT))) {
    console.error(`[e2e] port ${ANVIL_PORT} already in use — kill the existing process or set ANVIL_PORT.`);
    process.exit(1);
  }

  const anvilArgs = [
    '--host', '127.0.0.1',
    '--port', String(ANVIL_PORT),
    '--fork-url', FORK_URL,
    // Anvil's default mnemonic is "test test test test test test test test
    // test test test junk" — public, deterministic, and matches the address
    // baked into e2e/fixtures/wallet.ts. We pass it explicitly so a future
    // Anvil version with a different default doesn't silently desync the spec.
    '--mnemonic', 'test test test test test test test test test test test junk',
    '--accounts', '10',
    '--balance', '10000',
    '--silent',
  ];
  if (FORK_BLOCK) anvilArgs.push('--fork-block-number', String(FORK_BLOCK));

  console.log(`[e2e] spawning anvil --fork-url ${FORK_URL}${FORK_BLOCK ? ' @' + FORK_BLOCK : ''} on :${ANVIL_PORT}`);
  const anvil = spawn('anvil', anvilArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  anvil.on('error', (e) => {
    console.error('[e2e] anvil failed to start:', e.message);
    process.exit(1);
  });

  // Latch the exit the instant it happens. A refused fork kills anvil in ~2s,
  // and without this latch the startup wait below has no way to tell "not yet"
  // from "never".
  let anvilDied = null;
  anvil.on('exit', (code, signal) => {
    if (!anvilDied) anvilDied = { code, signal };
  });

  // Drain both pipes. An unread pipe fills and blocks the child — and the tail
  // is the only diagnostic there is when a fork dies mid-run.
  const anvilTail = [];
  const keepTail = (chunk) => {
    anvilTail.push(String(chunk));
    if (anvilTail.length > 40) anvilTail.shift();
  };
  anvil.stdout.on('data', keepTail);
  anvil.stderr.on('data', keepTail);

  const ready = await waitForPort(ANVIL_PORT, 20_000, () => anvilDied);
  if (!ready) {
    const tail = anvilTail.join('');
    reportForkRefused(
      diagnoseFork(tail),
      tail,
      anvilDied
        ? `anvil exited (code=${anvilDied.code} signal=${anvilDied.signal}) before it ever bound :${ANVIL_PORT}.`
        : `anvil did not bind :${ANVIL_PORT} within 20s and is still running.`,
    );
    anvil.kill('SIGTERM');
    process.exit(1);
  }

  // Binding is not the same as forking. `anvil` listens before the fork
  // handshake completes, so a dead / rate-limited upstream produces a node
  // that answers on the port and errors on every call — under which the suite
  // would fail with a wall of confusing DOM timeouts instead of the real
  // cause. Prove the fork serves real state before handing it to Playwright.
  const rpcUrl = `http://127.0.0.1:${ANVIL_PORT}`;
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    const body = await res.json();
    const height = Number.parseInt(body?.result ?? '0x0', 16);
    if (!Number.isFinite(height) || height < 1_000_000) {
      throw new Error(`fork head is ${body?.result} — that is not mainnet state`);
    }
    console.log(`[e2e] fork ready at block ${height}`);
  } catch (e) {
    const tail = anvilTail.join('');
    reportForkRefused(
      diagnoseFork(tail),
      tail,
      `anvil is listening on :${ANVIL_PORT} but the fork is not usable: ${e.message}`,
    );
    anvil.kill('SIGTERM');
    process.exit(1);
  }

  const pw = spawnPlaywright({
    ANVIL_RPC_URL: `http://127.0.0.1:${ANVIL_PORT}`,
  });

  // Start at FAILURE and earn success. The previous shape initialised this to
  // 0 and exited on anvil's exit event, so an anvil that died mid-suite —
  // fork RPC rate-limit, OOM — exited the orchestrator 0 while Playwright was
  // still running. A crashed harness reported a passing money-path run.
  let finalCode = 1;
  let playwrightExited = false;

  pw.on('exit', (code) => {
    playwrightExited = true;
    finalCode = code ?? 1;
    anvil.kill('SIGTERM');
  });

  // Forward Ctrl-C cleanly.
  const onSig = () => {
    pw.kill('SIGTERM');
    anvil.kill('SIGTERM');
    process.exit(130);
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  anvil.on('exit', (code, signal) => {
    if (!playwrightExited) {
      console.error(`[e2e] anvil exited early (code=${code} signal=${signal}) while the suite was still running.`);
      console.error('[e2e] The remaining specs would have run against a dead fork; failing the run.');
      console.error(anvilTail.join(''));
      pw.kill('SIGTERM');
      process.exit(1);
    }
    process.exit(finalCode);
  });
}

// Only run when invoked as a program. Importing this file (the test does) must
// not spawn anvil — the pure classifier below is the point of the export.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error('[e2e] orchestrator error:', e);
    process.exit(1);
  });
}

// Exported for the test. `diagnoseFork` is the piece whose correctness cannot be
// observed by running this script: every branch but the archive one needs an
// upstream that is failing in that specific way RIGHT NOW to exercise it, so
// three of the four would sit unverified until the outage they exist to explain.
// They shipped broken once already -- a `\b` that survived authoring as a raw
// 0x08 byte, which matches nothing, and the live publicnode case passed anyway
// because it hits the one branch that carries no word boundary.
export { diagnoseFork };
