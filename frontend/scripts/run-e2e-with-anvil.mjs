#!/usr/bin/env node
/**
 * AUDIT R081 — `pnpm e2e` orchestrator: spawn Anvil fork + run Playwright specs.
 *
 * What this does:
 *   1. Resolves an RPC fork URL from $ANVIL_FORK_URL (default: public mainnet
 *      llamarpc — replace with a paid endpoint for stable runs).
 *   2. Spawns `anvil` with deterministic mnemonic ("test test ... junk") so
 *      account #9 (0x71be...5788) lines up with DEFAULT_ACCOUNT in
 *      e2e/fixtures/wallet.ts. NO PRIVATE KEYS are committed; Anvil derives
 *      them from the public test mnemonic at runtime.
 *   3. Sets ANVIL_RPC_URL=http://127.0.0.1:8545 so spec test.skip() gates
 *      flip and on-chain assertions fire.
 *   4. Runs `playwright test`, then tears Anvil down.
 *
 * Falls back to mock-mode if `anvil` is not installed (Foundry not present
 * on the dev box). Exit code mirrors Playwright's.
 *
 * Usage:
 *   pnpm e2e                                # uses default fork URL
 *   ANVIL_FORK_URL=https://...  pnpm e2e    # custom fork
 *   ANVIL_FORK_BLOCK=19000000   pnpm e2e    # pin to a specific block
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';

const FORK_URL = process.env.ANVIL_FORK_URL ?? 'https://eth.llamarpc.com';
const FORK_BLOCK = process.env.ANVIL_FORK_BLOCK; // optional pin
const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 8545);

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
  return spawn(cmd, ['playwright', 'test'], { stdio: 'inherit', env, shell: false });
}

async function main() {
  const anvilAvailable = await hasAnvil();

  if (!anvilAvailable) {
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

  const ready = await waitForPort(ANVIL_PORT, 20_000);
  if (!ready) {
    console.error('[e2e] anvil did not bind within 20s; aborting.');
    anvil.kill('SIGTERM');
    process.exit(1);
  }

  const pw = spawnPlaywright({
    ANVIL_RPC_URL: `http://127.0.0.1:${ANVIL_PORT}`,
  });

  let finalCode = 0;
  pw.on('exit', (code) => {
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

  anvil.on('exit', () => process.exit(finalCode));
}

main().catch((e) => {
  console.error('[e2e] orchestrator error:', e);
  process.exit(1);
});
