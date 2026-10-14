#!/usr/bin/env node
/**
 * Fill in the NFT launchpad redeploy (audit finding F1) once it is on chain.
 *
 * The site, the registry and the docs were switched to the new launchpad BEFORE it was
 * deployed, with placeholders (every one contains PENDING_REDEPLOY), because the address
 * is only known after the deploy. `fill-launchpad-redeploy.test.mjs` fails while any
 * placeholder is left, so that state cannot be merged by accident.
 *
 * Run from frontend/, after the owner's deploy, in the checkout he deployed from (its
 * contracts/broadcast holds the receipt):
 *
 *   node scripts/fill-launchpad-redeploy.mjs <new launchpad address> [--rpc <url>]
 *
 * It writes nothing until every check passes:
 *   1. the deploy receipt is in contracts/broadcast/DeployLaunchpadV2.s.sol/1/ (rule 5 of
 *      verify-addresses.mjs needs it committed), sent by the owner key, status 1;
 *   2. the chain agrees: code at the address, owner, fee 500 bps to the treasury, WETH,
 *      no sequencer feed, dropTemplate() equal to the template the receipt created, and
 *      the template carries the F1 fix (fixedPriceNeedsProposal in its dispatcher) with
 *      exactly the bytes the fork rehearsal deployed;
 *   3. the old launchpad still has 0 collections (the plan assumed nothing moves).
 * A read that does not answer stops it: an unread value is never taken as a pass.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, getAddress, isAddress, getContractAddress, keccak256, toFunctionSelector } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..');

/** The marker every placeholder carries. Nothing that ships may still contain it. */
export const MARKER = 'PENDING_REDEPLOY';

/** Every file that holds a placeholder, relative to the repo root. */
export const FILES = [
  'README.md',
  'contracts/script/rehome-ownership.sh',
  'docs/CONTRACTS.md',
  'docs/MIGRATION_HISTORY.md',
  'docs/SAFE_REHOME_RUNBOOK.md',
  'docs/audits/audit_101/OPEN_FINDINGS_FIXED_IN_SOURCE_2026_10_14.md',
  'frontend/scripts/addresses.json',
  'frontend/src/lib/constants.ts',
  'frontend/src/lib/dropRules.ts',
  'scripts/verify-ownership.mjs',
];

/** The placeholders, by the value that replaces each. */
export const TOKENS = {
  launchpad: `0x${MARKER}_LAUNCHPAD`,
  template: `0x${MARKER}_DROP_TEMPLATE`,
  receipt: `${MARKER}_RECEIPT`,
  block: `${MARKER}_BLOCK`,
  date: `${MARKER}_DATE`,
};

// The settings the deploy script bakes in, which the replaced launchpad also has.
export const OWNER = '0x14898258122C0740106391E6e8E4F17F3b6d456E';
export const TREASURY = '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d';
export const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const FEE_BPS = 500;
export const OLD_LAUNCHPAD = '0xa6149B4d05138A4073902A0Ca0345c2d0E470dF7';
export const OLD_TEMPLATE = '0xA35ec3e20C4361144b0D99573DEa00B67873e872';
const ZERO = '0x0000000000000000000000000000000000000000';

// From the fork rehearsal (owner pack launchpad-v2-redeploy-2026-10, evidence/). The
// template has no immutables, so its runtime code is the same wherever it lands.
export const TEMPLATE_CODE_KECCAK = '0x8a9589d45f930c146f3157da80c0d9c17f34b4e5a162fb12e53ca8130eb1ce2f';
// The launchpad's code embeds its template's address, so this holds only for the
// predicted address (the owner key's nonce 109 at the deploy).
export const PREDICTED_LAUNCHPAD = '0x580C4B14f1221e57BE89Bf8C0aaf3E0FeeA4c5cA';
export const PREDICTED_LAUNCHPAD_CODE_KECCAK = '0x070c4b753e1b713d2ead84ec4cb01599c2f41df628854931997dbcdb563e8e95';

const F1_FLAG = `63${toFunctionSelector('fixedPriceNeedsProposal()').slice(2)}`;

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

/** The receipt in `dir` that created `launchpad` from the owner key, or null. */
export function findReceipt(dir, launchpad) {
  if (!existsSync(dir)) return null;
  const want = launchpad.toLowerCase();
  const runs = readdirSync(dir).filter((f) => /^run-\d+\.json$/.test(f)).sort();
  for (const file of runs.reverse()) {
    const run = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
    for (const tx of run.transactions ?? []) {
      if (tx.transactionType !== 'CREATE' || tx.contractName !== 'TegridyLaunchpadV2') continue;
      if (tx.contractAddress?.toLowerCase() !== want) continue;
      const rcpt = (run.receipts ?? []).find((r) => r.transactionHash === tx.hash);
      const inner = (tx.additionalContracts ?? []).find((c) => c.contractName === 'TegridyDropV2');
      return {
        file,
        from: tx.transaction?.from,
        nonce: BigInt(tx.transaction?.nonce ?? -1),
        hash: tx.hash,
        status: rcpt?.status,
        block: rcpt ? BigInt(rcpt.blockNumber) : null,
        template: inner?.address ?? null,
      };
    }
  }
  return null;
}

function stop(msg) {
  console.error(`\nSTOP: ${msg}\nNothing was written.`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const rpcAt = args.indexOf('--rpc');
  const rpc = rpcAt >= 0 ? args[rpcAt + 1] : 'https://eth.drpc.org';
  const given = args.find((a, i) => !a.startsWith('--') && i !== rpcAt + 1);
  if (!given || !isAddress(given, { strict: false })) stop('give the new launchpad address: node scripts/fill-launchpad-redeploy.mjs 0x...');
  const launchpad = getAddress(given);
  if (launchpad.toLowerCase() === OLD_LAUNCHPAD.toLowerCase()) stop('that is the OLD launchpad');

  // 1. The receipt.
  const dir = join(REPO, 'contracts', 'broadcast', 'DeployLaunchpadV2.s.sol', '1');
  const r = findReceipt(dir, launchpad);
  if (!r) stop(`no receipt in ${dir} creates ${launchpad}. Run this in the checkout the deploy ran from.`);
  if (r.from?.toLowerCase() !== OWNER.toLowerCase()) stop(`the receipt's sender is ${r.from}, not the owner key ${OWNER}`);
  if (r.status !== '0x1') stop(`the deploy receipt's status is ${r.status}, not 0x1`);
  if (!r.template) stop('the receipt lists no TegridyDropV2 created inside the constructor');
  const template = getAddress(r.template);
  if (getContractAddress({ from: launchpad, nonce: 1n }).toLowerCase() !== template.toLowerCase()) {
    stop(`the receipt's template ${template} is not the launchpad's first CREATE`);
  }

  // 2. The chain.
  const client = createPublicClient({ transport: http(rpc, { retryCount: 3, timeout: 30_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 1) stop(`the RPC is chain ${chainId}, not Ethereum mainnet`);
  const abi = [
    'owner', 'pendingOwner', 'protocolFeeBps', 'protocolFeeRecipient', 'weth', 'sequencerFeed',
    'dropTemplate', 'getCollectionCount', 'paused',
  ].map((name) => ({
    type: 'function', name, stateMutability: 'view', inputs: [],
    outputs: [{ type: ['protocolFeeBps', 'getCollectionCount'].includes(name) ? 'uint256' : name === 'paused' ? 'bool' : 'address' }],
  }));
  const read = async (address, functionName) => {
    try {
      return await client.readContract({ address, abi, functionName });
    } catch (e) {
      stop(`${functionName}() on ${address} did not answer (${e.shortMessage ?? e.message}). An unread value is not a pass.`);
    }
  };
  const code = await client.getCode({ address: launchpad }).catch((e) => stop(`getCode: ${e.message}`));
  if (!code || code === '0x') stop(`no code at ${launchpad} on ${rpc}`);
  const got = {
    owner: await read(launchpad, 'owner'),
    pendingOwner: await read(launchpad, 'pendingOwner'),
    feeBps: Number(await read(launchpad, 'protocolFeeBps')),
    recipient: await read(launchpad, 'protocolFeeRecipient'),
    weth: await read(launchpad, 'weth'),
    feed: await read(launchpad, 'sequencerFeed'),
    template: await read(launchpad, 'dropTemplate'),
    count: await read(launchpad, 'getCollectionCount'),
    paused: await read(launchpad, 'paused'),
    oldCount: await read(OLD_LAUNCHPAD, 'getCollectionCount'),
    oldPaused: await read(OLD_LAUNCHPAD, 'paused'),
  };
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  if (!same(got.owner, OWNER)) stop(`owner() is ${got.owner}, expected ${OWNER}`);
  if (got.feeBps !== FEE_BPS) stop(`protocolFeeBps() is ${got.feeBps}, expected ${FEE_BPS}`);
  if (!same(got.recipient, TREASURY)) stop(`protocolFeeRecipient() is ${got.recipient}, expected ${TREASURY}`);
  if (!same(got.weth, WETH)) stop(`weth() is ${got.weth}`);
  if (!same(got.feed, ZERO)) stop(`sequencerFeed() is ${got.feed}, expected zero on mainnet`);
  if (!same(got.template, template)) stop(`dropTemplate() is ${got.template}, the receipt says ${template}`);
  if (got.oldCount !== 0n) stop(`the OLD launchpad now has ${got.oldCount} collection(s); the plan assumed none. Ask before going on.`);

  const tcode = await client.getCode({ address: template }).catch((e) => stop(`getCode(template): ${e.message}`));
  if (!tcode || tcode === '0x') stop(`no code at the template ${template}`);
  if (!tcode.toLowerCase().includes(F1_FLAG)) stop('the template has no fixedPriceNeedsProposal(): it is not the F1 fix');
  if (keccak256(tcode) !== TEMPLATE_CODE_KECCAK) {
    stop(`the template's code hash ${keccak256(tcode)} is not the rehearsed ${TEMPLATE_CODE_KECCAK}: it was built from different source`);
  }
  if (same(launchpad, PREDICTED_LAUNCHPAD) && keccak256(code) !== PREDICTED_LAUNCHPAD_CODE_KECCAK) {
    stop(`the launchpad's code hash ${keccak256(code)} is not the rehearsed ${PREDICTED_LAUNCHPAD_CODE_KECCAK}`);
  }
  const blk = await client.getBlock({ blockNumber: r.block }).catch((e) => stop(`getBlock(${r.block}): ${e.message}`));
  const date = new Date(Number(blk.timestamp) * 1000).toISOString().slice(0, 10);

  // 3. Write.
  const values = { launchpad, template, receipt: r.file, block: r.block.toLocaleString('en-US'), date };
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

  console.log(`Launchpad  ${launchpad}`);
  console.log(`Template   ${template} (F1 fix present, code hash as rehearsed)`);
  console.log(`Receipt    contracts/broadcast/DeployLaunchpadV2.s.sol/1/${r.file}, block ${values.block}, ${date}`);
  console.log(`Owner      ${got.owner}; pendingOwner ${got.pendingOwner}${same(got.pendingOwner, OWNER) ? ' (the script\'s transfer to itself: harmless, expires in 14 days)' : ''}`);
  console.log(`Fee        ${got.feeBps} bps to ${got.recipient}`);
  console.log(`New: ${got.count} collection(s), paused ${got.paused}. Old: ${got.oldCount} collection(s), paused ${got.oldPaused}.`);
  console.log(`\nFilled ${changed.length} file(s):\n  ${changed.join('\n  ')}`);
  console.log('\nNext: git add those files AND the receipt (both run-*.json and run-latest.json), then');
  console.log('  npx vitest run scripts/fill-launchpad-redeploy.test.mjs src/lib/docsAddressTruth.test.ts');
  console.log('  node scripts/verify-addresses.mjs');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
