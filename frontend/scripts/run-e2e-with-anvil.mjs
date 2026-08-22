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

// eth.llamarpc.com was the default and is dead for this purpose — HTTP 521,
// no ACAO (src/lib/wagmi.ts records the same finding). publicnode is the
// endpoint the fixture's own notes verified against a real fork read.
const FORK_URL = process.env.ANVIL_FORK_URL ?? 'https://ethereum-rpc.publicnode.com';
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

async function waitForPort(port, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await portFree(port))) return true;
    await delay(250);
  }
  return false;
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

  // Drain both pipes. An unread pipe fills and blocks the child — and the tail
  // is the only diagnostic there is when a fork dies mid-run.
  const anvilTail = [];
  const keepTail = (chunk) => {
    anvilTail.push(String(chunk));
    if (anvilTail.length > 40) anvilTail.shift();
  };
  anvil.stdout.on('data', keepTail);
  anvil.stderr.on('data', keepTail);

  const ready = await waitForPort(ANVIL_PORT, 20_000);
  if (!ready) {
    console.error('[e2e] anvil did not bind within 20s; aborting.');
    console.error(anvilTail.join(''));
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
    console.error(`[e2e] anvil is listening but the fork is not usable: ${e.message}`);
    console.error(`[e2e] upstream was ${FORK_URL}`);
    console.error(anvilTail.join(''));
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

main().catch((e) => {
  console.error('[e2e] orchestrator error:', e);
  process.exit(1);
});
