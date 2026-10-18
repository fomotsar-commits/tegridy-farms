#!/usr/bin/env node
/**
 * Fill in STAKING RELEASE 1 (docs/STAKING_RELEASE_1_WIRING.md) once it is on chain.
 *
 * The site, the address registry and the docs were switched to the new staking contracts
 * BEFORE they were deployed, with placeholders, because the addresses are only known after
 * the deploy. `fill-staking-release.test.mjs` fails while any placeholder is left, so that
 * state cannot be merged by accident.
 *
 * Run from frontend/, after the owner's step 1 AND step 2 (the reward funding), in the
 * checkout he deployed from (its contracts/broadcast holds the receipt):
 *
 *   node scripts/fill-staking-release.mjs [--rpc <url>] [--allow-unfunded]
 *
 * It takes every address from the deploy receipt, not from a person, and writes nothing
 * until every check passes:
 *   1. the receipt is in contracts/broadcast/DeployStakingRelease1.s.sol/1/, sent by the
 *      owner key, and EVERY transaction in that run has status 1 (a half-finished run
 *      leaves one-shot links unset);
 *   2. the chain agrees: code at all ten, and every link the deploy script set (staking
 *      owner, treasury, token, JBAC, 75% early-exit fee, admin, vault; each sister's
 *      staking(); the farm, distributor and splitter wired to the NEW staking; the two
 *      libraries linked into the staking bytecode);
 *   3. the first staking contract still charges 25% (the site's OLD constant);
 *   4. the new contract holds reward TOWELI beyond its stakes (step 2 ran). The site must
 *      not send anyone to a contract whose reward pot is empty: an early exit there pays
 *      the 75% and no rewards. --allow-unfunded skips only this check.
 * A read that does not answer stops it: an unread value is never taken as a pass.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, getAddress, formatEther } from 'viem';
import { redactRpcUrl } from '../../scripts/lib/redact-url.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..');

/** The marker every placeholder carries. Nothing that ships may still contain it. */
export const MARKER = 'PENDING_REDEPLOY';

/** Every file that holds a staking-release placeholder, relative to the repo root. */
export const FILES = [
  'README.md',
  'docs/CONTRACTS.md',
  'docs/MIGRATION_HISTORY.md',
  'docs/TOKENOMICS.md',
  'frontend/scripts/addresses.json',
  'frontend/src/lib/constants.ts',
];

/** Contract name in the receipt -> the key its address fills. */
export const CONTRACTS = {
  TegridyStaking: 'staking',
  TegridyStakingAdmin: 'admin',
  StakingMonitorView: 'monitor',
  TegridyTokenURIReader: 'uriReader',
  TegridyStakingJbacVault: 'vault',
  TegridyLPFarming: 'farm',
  RevenueDistributor: 'distributor',
  ReferralSplitter: 'splitter',
  StakingRewardLib: 'rewardLib',
  StakingViewLib: 'viewLib',
};

/** The placeholders, by the value that replaces each. */
export const TOKENS = {
  staking: `0x${MARKER}_STAKING`,
  admin: `0x${MARKER}_STAKING_ADMIN`,
  monitor: `0x${MARKER}_MONITOR_VIEW`,
  uriReader: `0x${MARKER}_TOKEN_URI_READER`,
  vault: `0x${MARKER}_JBAC_VAULT`,
  farm: `0x${MARKER}_LP_FARMING`,
  distributor: `0x${MARKER}_REVENUE_DISTRIBUTOR`,
  splitter: `0x${MARKER}_REFERRAL_SPLITTER`,
  rewardLib: `0x${MARKER}_REWARD_LIB`,
  viewLib: `0x${MARKER}_VIEW_LIB`,
  receipt: `${MARKER}_RECEIPT`,
  date: `${MARKER}_DATE`,
};

// What the deploy script bakes in (contracts/script/DeployStakingRelease1.s.sol).
export const OWNER = '0x14898258122C0740106391E6e8E4F17F3b6d456E';
export const TREASURY = '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d';
export const TOWELI = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D';
export const JBAC = '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9';
export const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const LP = '0x55875887B43C2E23aE424AF0FC8606Fdb058a481';
export const NEW_PENALTY_BPS = 7500n;
export const OLD_STAKING = '0xcaDc93E96De58EA554c71ca609974625615E046D';
export const OLD_PENALTY_BPS = 2500n;
/** notifyRewardAmount's minimum: less than this in the pot means step 2 did not run. */
export const MIN_FUNDED_WEI = 1_000n * 10n ** 18n;

/**
 * Replace every placeholder in `text`. Throws on a placeholder it does not know, and if
 * any marker is left, so a half-filled file is never written.
 */
export function fillText(text, values) {
  const byToken = new Map(Object.entries(TOKENS).map(([k, t]) => [t, values[k]]));
  const out = text.replace(new RegExp(`(?:0x)?${MARKER}_[A-Z_]+`, 'g'), (m) => {
    if (!byToken.has(m)) throw new Error(`unknown placeholder ${m}`);
    const v = byToken.get(m);
    if (typeof v !== 'string' || v.length === 0) throw new Error(`no value for ${m}`);
    return v;
  });
  if (out.includes(MARKER)) throw new Error(`a ${MARKER} marker is left after filling`);
  return out;
}

/**
 * The newest run in `dir` that deployed TegridyStaking from `owner`: every contract it
 * created, by key, and whether every transaction in it succeeded. Null when there is none.
 */
export function findRelease(dir, owner = OWNER) {
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir).filter((f) => /^run-\d+\.json$/.test(f)).sort().reverse();
  for (const file of runs) {
    const run = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
    const result = releaseFromRun(run, owner);
    if (result) return { file, ...result };
  }
  return null;
}

/** One broadcast run read as a release, or null when it did not deploy TegridyStaking. */
export function releaseFromRun(run, owner = OWNER) {
  const txs = run.transactions ?? [];
  if (!txs.some((t) => t.transactionType === 'CREATE' && t.contractName === 'TegridyStaking')) return null;
  const addresses = {};
  const problems = [];
  for (const t of txs) {
    if (t.transactionType !== 'CREATE' && t.transactionType !== 'CREATE2') continue;
    const key = CONTRACTS[t.contractName];
    if (!key) continue;
    if (addresses[key]) problems.push(`${t.contractName} is created twice in this run`);
    addresses[key] = getAddress(t.contractAddress);
    if (t.transactionType === 'CREATE' && t.transaction?.from?.toLowerCase() !== owner.toLowerCase()) {
      problems.push(`${t.contractName} was sent by ${t.transaction?.from}, not the owner key ${owner}`);
    }
  }
  for (const [name, key] of Object.entries(CONTRACTS)) {
    if (!addresses[key]) problems.push(`the run created no ${name}`);
  }
  const receipts = new Map((run.receipts ?? []).map((r) => [r.transactionHash, r]));
  for (const t of txs) {
    const r = receipts.get(t.hash);
    if (!r) problems.push(`no receipt for ${t.function ?? t.contractName} (${t.hash})`);
    else if (r.status !== '0x1') problems.push(`${t.function ?? t.contractName} (${t.hash}) has status ${r.status}`);
  }
  const blocks = (run.receipts ?? []).map((r) => BigInt(r.blockNumber));
  const firstBlock = blocks.length ? blocks.reduce((a, b) => (a < b ? a : b)) : null;
  return { addresses, problems, firstBlock };
}

function stop(msg) {
  console.error(`\nSTOP: ${msg}\nNothing was written.`);
  process.exit(1);
}

const fn = (name, out) => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: out }] });
const ABI = [
  ...['owner', 'treasury', 'rewardToken', 'jbacNFT', 'stakingAdmin', 'jbacVault', 'staking', 'tegridyStaking',
    'stakingToken', 'votingEscrow', 'weth', 'stakingContract'].map((n) => fn(n, 'address')),
  ...['EARLY_WITHDRAWAL_PENALTY_BPS', 'rewardRate', 'periodFinish', 'totalStaked', 'totalUnsettledRewards', 'referralFeeBps'].map((n) => fn(n, 'uint256')),
  ...['paused', 'setupComplete'].map((n) => fn(n, 'bool')),
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];

/**
 * Every on-chain check of a release, read-only. Returns the mismatches (empty = all as the
 * deploy script set them) and the reward-pot reading. A read that does not answer THROWS:
 * an unread value is never a pass and never a mismatch either.
 */
export async function verifyOnChain(client, a) {
  const problems = [];
  const read = (address, functionName, args) => client.readContract({ address, abi: ABI, functionName, args });
  const same = (x, y) => String(x).toLowerCase() === String(y).toLowerCase();
  const expectEq = async (address, functionName, want, label) => {
    const got = await read(address, functionName);
    if (!same(got, want)) problems.push(`${label}.${functionName}() is ${got}, expected ${want}`);
  };

  const codes = {};
  for (const [key, address] of Object.entries(a)) {
    const code = await client.getCode({ address });
    if (!code || code === '0x') problems.push(`no code at ${key} ${address}`);
    codes[key] = (code ?? '0x').toLowerCase();
  }
  for (const lib of ['rewardLib', 'viewLib']) {
    if (!codes.staking.includes(a[lib].slice(2).toLowerCase())) problems.push(`TegridyStaking is not linked to ${lib} ${a[lib]}`);
  }

  await expectEq(a.staking, 'owner', OWNER, 'TegridyStaking');
  await expectEq(a.staking, 'treasury', TREASURY, 'TegridyStaking');
  await expectEq(a.staking, 'rewardToken', TOWELI, 'TegridyStaking');
  await expectEq(a.staking, 'jbacNFT', JBAC, 'TegridyStaking');
  await expectEq(a.staking, 'stakingAdmin', a.admin, 'TegridyStaking');
  await expectEq(a.staking, 'jbacVault', a.vault, 'TegridyStaking');
  await expectEq(a.staking, 'EARLY_WITHDRAWAL_PENALTY_BPS', NEW_PENALTY_BPS, 'TegridyStaking');
  for (const [key, label] of [['admin', 'TegridyStakingAdmin'], ['monitor', 'StakingMonitorView'], ['uriReader', 'TegridyTokenURIReader'], ['vault', 'TegridyStakingJbacVault']]) {
    await expectEq(a[key], 'staking', a.staking, label);
  }
  await expectEq(a.farm, 'tegridyStaking', a.staking, 'TegridyLPFarming');
  await expectEq(a.farm, 'stakingToken', LP, 'TegridyLPFarming');
  await expectEq(a.farm, 'rewardToken', TOWELI, 'TegridyLPFarming');
  await expectEq(a.distributor, 'votingEscrow', a.staking, 'RevenueDistributor');
  await expectEq(a.distributor, 'weth', WETH, 'RevenueDistributor');
  await expectEq(a.splitter, 'stakingContract', a.staking, 'ReferralSplitter');
  await expectEq(a.splitter, 'setupComplete', true, 'ReferralSplitter');

  // The first contract keeps its own fee; the site quotes it from a constant.
  await expectEq(OLD_STAKING, 'EARLY_WITHDRAWAL_PENALTY_BPS', OLD_PENALTY_BPS, 'the first TegridyStaking');
  const oldPaused = await read(OLD_STAKING, 'paused');

  // The reward pot. Free = balance - staked - unsettled IOUs (the contract's own reserve rule).
  // Since 2026-10-18 the contract sets its own rate from each funding (the pot over four
  // years), so the end of payouts is read, not worked out from pot / rate.
  const rate = await read(a.staking, 'rewardRate');
  const finish = await read(a.staking, 'periodFinish');
  const bal = await read(TOWELI, 'balanceOf', [a.staking]);
  const staked = await read(a.staking, 'totalStaked');
  const owed = await read(a.staking, 'totalUnsettledRewards');
  return { problems, oldPaused, rate, finish, free: bal - staked - owed };
}

async function main() {
  const args = process.argv.slice(2);
  const rpcAt = args.indexOf('--rpc');
  const rpc = rpcAt >= 0 ? args[rpcAt + 1] : 'https://ethereum-rpc.publicnode.com';
  const allowUnfunded = args.includes('--allow-unfunded');

  // 1. The receipt.
  const dir = join(REPO, 'contracts', 'broadcast', 'DeployStakingRelease1.s.sol', '1');
  const r = findRelease(dir);
  if (!r) stop(`no run in ${dir} deploys TegridyStaking. Run this in the checkout the deploy ran from.`);
  if (r.problems.length) stop(`the deploy run ${r.file} is not a finished release:\n  ${r.problems.join('\n  ')}`);
  const a = r.addresses;

  // 2-4. The chain.
  const client = createPublicClient({ transport: http(rpc, { retryCount: 3, timeout: 30_000 }) });
  const chainId = await client.getChainId().catch((e) => stop(`getChainId: ${e.message}`));
  if (chainId !== 1) stop(`the RPC is chain ${chainId}, not Ethereum mainnet`);
  let checked;
  try {
    checked = await verifyOnChain(client, a);
  } catch (e) {
    stop(`a read did not answer on ${redactRpcUrl(rpc)} (${e.shortMessage ?? e.message}). An unread value is not a pass.`);
  }
  const { problems, oldPaused, rate, finish, free } = checked;
  if (problems.length) stop(`the chain does not match the release:\n  ${problems.join('\n  ')}`);
  if (free < MIN_FUNDED_WEI && !allowUnfunded) {
    stop(`the new staking contract holds ${formatEther(free > 0n ? free : 0n)} reward TOWELI. Run step 2 (FundStakingRelease1) first: ` +
      'the site must not send anyone to an empty reward pot, where leaving early pays the 75% and no rewards.');
  }

  const blk = await client.getBlock({ blockNumber: r.firstBlock }).catch((e) => stop(`getBlock(${r.firstBlock}): ${e.message}`));
  const date = new Date(Number(blk.timestamp) * 1000).toISOString().slice(0, 10);

  // 5. Write.
  const values = { ...a, receipt: r.file, date };
  const changed = [];
  for (const rel of FILES) {
    const p = join(REPO, rel);
    const before = readFileSync(p, 'utf-8');
    const after = fillText(before, values);
    if (after !== before) {
      writeFileSync(p, after);
      changed.push(rel);
    }
  }

  console.log(`Receipt   contracts/broadcast/DeployStakingRelease1.s.sol/1/${r.file}, first block ${r.firstBlock}, ${date}`);
  for (const [name, key] of Object.entries(CONTRACTS)) console.log(`${name.padEnd(24)} ${a[key]}`);
  console.log(`Fee       ${NEW_PENALTY_BPS} bps on the new contract; the first one still ${OLD_PENALTY_BPS} bps${oldPaused ? ' and PAUSED: its positions cannot claim or leave. Ask before going on.' : ''}`);
  console.log(`Pot       ${formatEther(free)} TOWELI, paid out at ${formatEther(rate * 86_400n)} TOWELI/day until ${finish > 0n ? new Date(Number(finish) * 1000).toISOString().slice(0, 10) : 'it is funded'} (the four-year schedule)`);
  console.log(`\nFilled ${changed.length} file(s):\n  ${changed.join('\n  ')}`);
  console.log('\nNext: git add those files AND the receipts (both run-*.json and run-latest.json under');
  console.log('contracts/broadcast/DeployStakingRelease1.s.sol/1/), then from frontend/:');
  console.log('  npx vitest run scripts/fill-staking-release.test.mjs src/lib/docsAddressTruth.test.ts src/lib/llmsTxt.test.ts');
  console.log('  node scripts/verify-addresses.mjs');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
