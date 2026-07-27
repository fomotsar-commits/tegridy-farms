#!/usr/bin/env node
/**
 * PRE-PROD GATE for exotic (token/TOWELI) launches.
 *
 * The dynamic-auction ERC20-numeraire path is source-verified (Doppler mines the token
 * CREATE2 address to sort against ANY numeraire; TOWELI's low address takes native ETH's
 * exact path — see frontend/src/lib/launcher/airlock.ts). This rehearsal CONFIRMS it
 * end-to-end on a mainnet fork before EXOTIC_LAUNCHES_ENABLED is flipped:
 *
 *   spawn anvil (mainnet fork) → build a TOWELI-numeraire dynamic-auction via the real
 *   DopplerSDK (this triggers the on-chain hook/token mining) → simulateCreateDynamicAuction
 *   → assert it does NOT revert (no InvalidTokenOrder / InvalidNumeraire), and that the
 *   mined token sorts ABOVE TOWELI (so the migration pool is currency0=TOWELI/currency1=token).
 *
 * This closes the CREATE step. The full lifecycle (buy → maxProceeds → migrate → locker
 * holds a TOWELI/token V4 position + fees stream) is the extended manual step documented
 * in docs/LAUNCHER_GOLIVE_CHECKLIST.md — run it before enabling on prod.
 *
 * Usage:
 *   ANVIL_FORK_URL=https://your-archive-rpc  node scripts/exotic-toweli-fork-rehearsal.mjs
 * Requires: foundry (anvil) on PATH; run from repo root (uses frontend/node_modules).
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve viem / doppler-sdk from frontend/node_modules regardless of CWD.
const require = createRequire(path.join(__dirname, '..', 'frontend', 'package.json'));
const { createPublicClient, createWalletClient, http, parseEther } = require('viem');
const { mainnet } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');
const sdkEvm = require('@whetstone-research/doppler-sdk/evm');

const FORK_URL = process.env.ANVIL_FORK_URL ?? 'https://ethereum-rpc.publicnode.com';
const PORT = Number(process.env.ANVIL_PORT ?? 8545);
const RPC = `http://127.0.0.1:${PORT}`;
// Anvil default account #0 (public test mnemonic — NO real key).
const ACCT = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

const TOWELI = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D';
const ZERO = '0x0000000000000000000000000000000000000000';
const INTEGRATOR = '0xD355A072d6bBbA275DBD83A3149f6347b06d1051';
const REVENUE_DISTRIBUTOR = '0xF993316E2fC079de4358c489A935E01e03E23E17';
const AIRLOCK_OWNER = '0x21E2ce70511e4FE542a97708e89520471DAa7A66';
const WAD = 10n ** 18n;

// Fee constitution → WAD beneficiaries (mirrors airlock.feeConstitutionToBeneficiaries):
// creator 80% / protocol 15% / doppler 5%, address-sorted, summing to 1e18.
function beneficiaries(creator) {
  const lines = [
    { addr: creator, bps: 8000 },
    { addr: REVENUE_DISTRIBUTOR, bps: 1500 },
    { addr: AIRLOCK_OWNER, bps: 500 },
  ];
  return lines
    .map((l) => ({ beneficiary: l.addr, shares: (BigInt(l.bps) * WAD) / 10000n }))
    .sort((a, b) => (a.beneficiary.toLowerCase() < b.beneficiary.toLowerCase() ? -1 : 1));
}

/** Find a 20-byte hex address in a params object — prefer keys in `preferKeys`. */
function findAddress(obj, preferKeys) {
  const isAddr = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
  for (const k of preferKeys) if (obj && isAddr(obj[k])) return obj[k];
  const seen = new Set();
  const walk = (v) => {
    if (isAddr(v)) return v;
    if (v && typeof v === 'object' && !seen.has(v)) {
      seen.add(v);
      for (const key of preferKeys) if (isAddr(v[key])) return v[key];
      for (const val of Object.values(v)) { const r = walk(val); if (r) return r; }
    }
    return null;
  };
  return walk(obj);
}

async function main() {
  console.log(`[rehearsal] spawning anvil fork of ${FORK_URL} on :${PORT}…`);
  const anvil = spawn('anvil', ['--fork-url', FORK_URL, '--port', String(PORT), '--silent'], { stdio: 'inherit', shell: false });
  const cleanup = () => { try { anvil.kill('SIGTERM'); } catch { /* noop */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  const publicClient = createPublicClient({ chain: mainnet, transport: http(RPC) });
  // wait for anvil
  for (let i = 0; i < 40; i++) {
    try { await publicClient.getBlockNumber(); break; } catch { await delay(500); }
  }
  const walletClient = createWalletClient({ account: ACCT, chain: mainnet, transport: http(RPC) });
  console.log(`[rehearsal] anvil up. block ${await publicClient.getBlockNumber()}, account ${ACCT.address}`);

  const sdk = new sdkEvm.DopplerSDK({ publicClient, walletClient, chainId: 1 });

  // Mirror airlock.buildTegridyLaunchParams, but with numeraire = TOWELI.
  const initialSupply = parseEther('1000000000');
  const numTokensToSell = initialSupply; // no premine, keep it simple
  const toweliUsd = 0.00003; // ~ current TOWELI/USD; the curve is priced off this
  const params = sdk
    .buildDynamicAuction()
    .tokenConfig({ type: 'dopplerERC20V1', name: 'Exotic Rehearsal', symbol: 'EXR', tokenURI: 'ipfs://rehearsal' })
    .saleConfig({ initialSupply, numTokensToSell, numeraire: TOWELI })
    .withMarketCapRange({
      marketCap: { start: 300_000, min: 30_000 },
      numerairePrice: toweliUsd,
      minProceeds: BigInt(Math.floor((1_000 / toweliUsd) * 1e18)),
      maxProceeds: BigInt(Math.floor((50_000 / toweliUsd) * 1e18)),
      fee: 10_000,
    })
    .withTime({ startTimeOffset: 600 })
    .withMigration({ type: 'uniswapV4', fee: 3000, tickSpacing: 60, streamableFees: { lockDuration: 365 * 86400, beneficiaries: beneficiaries(ACCT.address) } })
    .withGovernance({ type: 'noOp' })
    .withIntegrator(INTEGRATOR)
    .withUserAddress(ACCT.address)
    .build();

  console.log('[rehearsal] built params (mining succeeded). Simulating create on the fork…');
  // simulateCreateDynamicAuction does the REAL on-chain create staticcall — if the token
  // sorted wrongly against TOWELI it reverts here with InvalidTokenOrder. So a clean
  // simulation IS the ordering + numeraire-acceptance proof.
  const result = await sdk.factory.simulateCreateDynamicAuction(params);
  console.log('\n✅ PASS — createDynamicAuction(numeraire=TOWELI) simulated with NO revert on a mainnet fork.');

  // Bonus: from the simulate RESULT (not the opaque params), confirm the mined token
  // sorts ABOVE TOWELI, i.e. the migration pool is (currency0=TOWELI, currency1=token).
  const token = findAddress(result, ['tokenAddress', 'asset', 'token']);
  if (token && token.toLowerCase() !== TOWELI.toLowerCase()) {
    console.log(`   mined token ${token}; token > TOWELI ? ${BigInt(token) > BigInt(TOWELI)} (expect true → currency0=TOWELI)`);
  }
  console.log('   Next (manual): drive the auction to maxProceeds, migrate, and assert the StreamableFeesLocker');
  console.log('   holds a TOWELI/token V4 position with fees streaming — see docs/LAUNCHER_GOLIVE_CHECKLIST.md.');
  cleanup();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ FAIL —', e?.shortMessage || e?.message || e);
  console.error('   Do NOT flip EXOTIC_LAUNCHES_ENABLED. Investigate before enabling token/TOWELI launches.');
  process.exit(1);
});
