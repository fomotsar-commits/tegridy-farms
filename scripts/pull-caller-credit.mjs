#!/usr/bin/env node
/**
 * The stranded swap-fee tool: read `ReferralSplitter.callerCredit(SwapFeeRouter)`, say
 * whether the permissionless pull would work, and hand over the exact command.
 *
 * WHY THIS EXISTS
 * ---------------
 * 80% of every ETH swap fee lands in `callerCredit[SwapFeeRouter]` on the splitter and
 * stays there until somebody calls `SwapFeeRouter.recoverCallerCredit()`. Until this
 * file, nothing in the repository ever called it — see the module header in
 * scripts/lib/caller-credit.mjs for the search and the mainnet readings.
 *
 * WHY IT DOES NOT SEND THE TRANSACTION
 * ------------------------------------
 * It has no signer and takes no private key, on purpose:
 *
 *   1. The repo root has no signing dependency. Adding one so a script can hold a key
 *      would create exactly the surface this repo's rules say to avoid, to save one
 *      copy-paste.
 *   2. `cast send` already supports `--ledger`, `--trezor`, `--account <keystore>` and
 *      `--interactive`. A homegrown signer would offer none of that and would tempt
 *      someone into `PRIVATE_KEY=` in a shell history or a CI secret.
 *   3. `recoverCallerCredit()` is permissionless and argument-free. There is no
 *      privileged key to custody in the first place — any wallet can do it, including
 *      from Etherscan's Write Contract tab with no tooling at all.
 *
 * So this reads the chain, tells you whether pulling is possible and whether it is worth
 * the gas, and prints the command. Broadcasting stays with whoever holds the wallet.
 *
 * USAGE
 *   node scripts/pull-caller-credit.mjs                 # human report
 *   node scripts/pull-caller-credit.mjs --json          # machine readable
 *   node scripts/pull-caller-credit.mjs --rpc https://…
 *   node scripts/pull-caller-credit.mjs --probe         # for CI: writes GITHUB_OUTPUT, never fails
 *
 * Exit 0 = the chain was read. Exit 1 = it was not, so nothing here is proven.
 * `--probe` always exits 0: a watcher must report "could not read" as data, not as a
 * crash that skips every downstream step.
 *
 * Read-only. It never sends a transaction.
 */

import { appendFileSync } from 'node:fs';
import {
  ADDRESSES,
  SELECTORS,
  classifyCallerCredit,
  encodeAddressArg,
  formatEth,
  hexToBigInt,
  pullCommand,
  pullViaExplorerUrl,
  renderGithubOutput,
  renderReport,
} from './lib/caller-credit.mjs';

const DEFAULT_RPC = 'https://ethereum-rpc.publicnode.com';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const RPC = value('rpc', process.env.ETH_RPC_URL || DEFAULT_RPC);
const PROBE = flag('probe');
const JSON_OUT = flag('json');

/** Collected rather than thrown: a failed read is a finding, not a stack trace. */
const errors = [];

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

/** eth_call returning one uint256-shaped word, or null with the reason recorded. */
async function callWord(label, to, data) {
  try {
    return hexToBigInt(await rpc('eth_call', [{ to, data }, 'latest']));
  } catch (e) {
    errors.push(`${label}: ${e.message}`);
    return null;
  }
}

async function callBool(label, to, data) {
  const word = await callWord(label, to, data);
  return word === null ? null : word !== 0n;
}

async function callAddress(label, to, data) {
  const word = await callWord(label, to, data);
  return word === null ? null : `0x${word.toString(16).padStart(40, '0')}`;
}

async function read() {
  const { swapFeeRouter, referralSplitter } = ADDRESSES;

  const creditWei = await callWord('callerCredit', referralSplitter, encodeAddressArg(SELECTORS.callerCredit, swapFeeRouter));
  const routerPaused = await callBool('SwapFeeRouter.paused', swapFeeRouter, SELECTORS.paused);
  const splitterSetupComplete = await callBool('ReferralSplitter.setupComplete', referralSplitter, SELECTORS.setupComplete);
  const lastCallerCreditAt = await callWord('SwapFeeRouter.lastCallerCreditAt', swapFeeRouter, SELECTORS.lastCallerCreditAt);
  const cooldownSeconds = await callWord('SwapFeeRouter.RECOVER_CALLER_CREDIT_COOLDOWN', swapFeeRouter, SELECTORS.recoverCooldown);
  const accumulatedETHFeesWei = await callWord('SwapFeeRouter.accumulatedETHFees', swapFeeRouter, SELECTORS.accumulatedETHFees);
  const wiredSplitter = await callAddress('SwapFeeRouter.referralSplitter', swapFeeRouter, SELECTORS.referralSplitter);

  let splitterBalanceWei = null;
  try {
    splitterBalanceWei = hexToBigInt(await rpc('eth_getBalance', [referralSplitter, 'latest']));
  } catch (e) {
    errors.push(`ReferralSplitter balance: ${e.message}`);
  }

  let nowSeconds = null;
  try {
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    nowSeconds = hexToBigInt(block?.timestamp);
  } catch (e) {
    errors.push(`latest block: ${e.message}`);
  }

  // Gas is estimated against a real simulation of the pull, so a revert shows up here as
  // a failed estimate rather than as a confident "go ahead" that costs someone a wasted
  // transaction. No `from` is supplied: the pull takes no value and reads no balance, and
  // pinning an arbitrary sender would make the estimate depend on that sender's funds.
  let gasEstimate = null;
  try {
    gasEstimate = hexToBigInt(await rpc('eth_estimateGas', [{ to: swapFeeRouter, data: SELECTORS.recoverCallerCredit }]));
  } catch (e) {
    errors.push(`recoverCallerCredit() gas estimate (the pull may be reverting): ${e.message}`);
  }

  let gasPriceWei = null;
  try {
    gasPriceWei = hexToBigInt(await rpc('eth_gasPrice', []));
  } catch (e) {
    errors.push(`eth_gasPrice: ${e.message}`);
  }

  return {
    creditWei,
    routerPaused,
    splitterSetupComplete,
    splitterBalanceWei,
    lastCallerCreditAt,
    cooldownSeconds,
    nowSeconds,
    wiredSplitter,
    accumulatedETHFeesWei,
    gasEstimate,
    gasPriceWei,
    errors,
  };
}

function printHuman(c) {
  console.log('Stranded swap fees — ReferralSplitter.callerCredit(SwapFeeRouter)');
  console.log(`  splitter  ${ADDRESSES.referralSplitter}`);
  console.log(`  router    ${ADDRESSES.swapFeeRouter}`);
  console.log(`  rpc       ${RPC}`);
  console.log('');
  console.log(renderReport(c));
  console.log('');

  if (c.state === 'stranded' && c.pullable) {
    console.log('To pull it (permissionless, no arguments, any wallet):');
    console.log(`  ${pullCommand(RPC)}`);
    console.log(`  or, with no tooling at all: ${pullViaExplorerUrl()}`);
    if (c.economics && !c.economics.worthIt) {
      console.log('');
      console.log(`  NOTE: at the current gas price this costs ${c.economics.costMultiple.toFixed(2)}x what it recovers.`);
      console.log(`  Recovering is still correct eventually — the credit is real protocol revenue and it`);
      console.log(`  compounds with every swap — but there is no hurry, and no reason to automate it while`);
      console.log(`  a robot would burn ${formatEth(c.economics.gasCostWei)} to move ${formatEth(c.creditWei)}.`);
    }
  }

  if (c.unknown.length) {
    console.log('');
    console.log('Reads that failed (nothing above is proven for these):');
    for (const u of c.unknown) console.log(`  - ${u}`);
  }
}

const reading = await read();
const classification = classifyCallerCredit(reading);

if (PROBE) {
  const out = renderGithubOutput(classification);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${out}\n`);
  else console.log(out);

  // Workflow-command annotations so the signal is on the run summary, not only in an
  // issue body. `::warning::` is a single line by contract, hence the flattening.
  if (classification.state === 'stranded') {
    console.log(`::warning::STRANDED FEES — ${classification.creditWei} wei sits in ReferralSplitter.callerCredit(SwapFeeRouter) and reaches the protocol only when someone calls the permissionless recoverCallerCredit(). See: node scripts/pull-caller-credit.mjs`);
  } else if (classification.state === 'unknown') {
    console.log('::warning::callerCredit could not be read — this run does NOT prove nothing is stranded.');
  } else {
    console.log('::notice::No stranded callerCredit.');
  }
  process.exit(0);
}

if (JSON_OUT) {
  console.log(JSON.stringify(classification, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
} else {
  printHuman(classification);
}

process.exit(classification.state === 'unknown' ? 1 : 0);
