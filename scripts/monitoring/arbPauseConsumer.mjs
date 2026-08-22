#!/usr/bin/env node
/**
 * The auto-pause half of the arb-linkage safety condition — everything except
 * the signature.
 *
 * WHAT IT DOES
 * ------------
 * Runs the arb-linkage monitor's rule (shared, not reimplemented — see
 * contracts/monitoring/lib/arbLinkage.mjs), and reads the live pause surface of
 * everything the TWAP feeds. On a HALT it renders the exact privileged call:
 * target, function, argument, calldata, and WHO is currently authorised to send
 * it, with what that address has actually been observed to do.
 *
 * WHY IT DOES NOT SEND THE TRANSACTION
 * ------------------------------------
 * Pausing is privileged, and a key that can pause on a schedule is a key sitting
 * in CI. The trade is not close: the monitor runs unattended on a public runner,
 * the pause is recoverable but the key is not, and a false HALT that pauses the
 * protocol automatically is a self-inflicted outage with no human in the loop.
 * So the automation ends at "here is the call, here is who can send it, here is
 * what it will break" — which is the part that is slow to derive at 3am, not the
 * part that is slow to type.
 *
 * The consequence is honest and worth stating plainly: this is alerting plus
 * preparation. Time-to-pause is bounded by a human reading a notification.
 *
 * USAGE
 *   node scripts/monitoring/arbPauseConsumer.mjs            # human report
 *   node scripts/monitoring/arbPauseConsumer.mjs --json     # machine readable
 *   node scripts/monitoring/arbPauseConsumer.mjs --probe    # for CI: writes GITHUB_OUTPUT, never fails
 *
 * Exit 0 = GO. 1 = WARN. 2 = HALT or unreadable. `--probe` always exits 0: a
 * watcher must report "could not read" as data, not as a crash that skips every
 * downstream step.
 *
 * Read-only. It never sends a transaction, and it takes no key.
 */

import { appendFileSync } from 'node:fs';
import { makeRpc, publicResult, readLinkage, redactEndpoint, resolveConfig } from '../../contracts/monitoring/lib/arbLinkage.mjs';
import {
  ADDRESSES,
  SELECTORS,
  TWAP_CONSUMERS,
  buildPlan,
  encodeAddressArg,
  renderGithubOutput,
  renderPlan,
  summarise,
} from './lib/pausePlan.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const PROBE = flag('probe');
const JSON_OUT = flag('json');

const config = resolveConfig();

/** Collected rather than thrown: a failed read is a finding, not a stack trace. */
const unreadable = [];

/**
 * Bound in main() to the endpoint that already served a complete, chain-checked,
 * current reading of the linkage. Reading the pause surface from a different
 * endpoint than the one that produced the verdict is how a plan ends up
 * describing a chain the verdict was not about.
 */
let rpc;

/**
 * `optional` marks a call whose REVERT is itself the answer — "this bytecode has
 * no such function". Recording those as failed reads would fill the incident
 * report with faults that are not faults, and the report is only useful if every
 * line in its failure list is worth chasing.
 */
async function call(label, to, data, { optional = false } = {}) {
  try {
    const hex = await rpc('eth_call', [{ to, data }, 'latest']);
    return typeof hex === 'string' && hex !== '0x' ? hex : null;
  } catch (e) {
    if (!optional) unreadable.push(`${label}: ${e.message || e}`);
    return null;
  }
}

const wordAt = (hex, i) => (hex ? BigInt(`0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64)}`) : null);
const toAddress = (w) => (w === null ? null : `0x${w.toString(16).padStart(40, '0')}`);
const ZERO = '0x0000000000000000000000000000000000000000';

async function readAddress(label, to, selector, opts) {
  const hex = await call(label, to, selector, opts);
  const addr = toAddress(wordAt(hex, 0));
  return addr === ZERO ? null : addr;
}

async function readUint(label, to, selector, opts) {
  const w = wordAt(await call(label, to, selector, opts), 0);
  return w === null ? null : Number(w);
}

async function readBool(label, to, selector, opts) {
  const w = wordAt(await call(label, to, selector, opts), 0);
  return w === null ? null : w !== 0n;
}

/**
 * A would-be caller, characterised only by what the chain reports. `getOwners()`
 * is decoded from the dynamic-array header rather than fully, because only the
 * count is used and decoding the tail would add a failure mode for nothing.
 */
async function readCaller(address) {
  if (!address) return null;

  let code;
  try {
    code = await rpc('eth_getCode', [address, 'latest']);
  } catch (e) {
    unreadable.push(`${address} code: ${e.message || e}`);
    return { kind: 'unknown' };
  }

  let balanceWei = null;
  try {
    balanceWei = BigInt(await rpc('eth_getBalance', [address, 'latest']));
  } catch (e) {
    unreadable.push(`${address} balance: ${e.message || e}`);
  }

  if (!code || code === '0x') {
    let txCount = null;
    try {
      txCount = Number(BigInt(await rpc('eth_getTransactionCount', [address, 'latest'])));
    } catch (e) {
      unreadable.push(`${address} tx count: ${e.message || e}`);
    }
    return { kind: 'eoa', txCount, balanceWei };
  }

  // eth_getTransactionCount on a Safe counts CREATEs, not executions, so it is
  // deliberately not consulted here. These three are optional: a revert means
  // the contract is simply not Safe-shaped.
  const opt = { optional: true };
  const nonceHex = await call(`${address} nonce()`, address, SELECTORS.safeNonce, opt);
  const thresholdHex = await call(`${address} getThreshold()`, address, SELECTORS.safeThreshold, opt);
  const ownersHex = await call(`${address} getOwners()`, address, SELECTORS.safeGetOwners, opt);
  if (nonceHex === null || thresholdHex === null) return { kind: 'contract', balanceWei };

  return {
    kind: 'safe',
    safeNonce: Number(wordAt(nonceHex, 0)),
    threshold: Number(wordAt(thresholdHex, 0)),
    ownerCount: ownersHex ? Number(wordAt(ownersHex, 1)) : null,
    balanceWei,
  };
}

const EFFECTS = {
  polAccumulator:
    'Blocks accumulate(), which consults TegridyTWAP to size its swap and its LP add. Note the entry-point is already onlyOwner, so the exposure this closes is a compromised or mistaken owner, not the public.',
  tegridyLending:
    'Blocks the whenNotPaused origination paths that value TOWELI collateral through TegridyTWAP.consult().',
};

const BLAST = {
  polAccumulator: 'POL accumulation stops. No user funds are affected; nothing else routes through it.',
  tegridyLending: 'New borrows stop. Repayment and liquidation paths are intentionally left open by the contract so positions can still be closed.',
};

async function readPauseSurface() {
  const factoryAddress = process.env.TEGRIDY_FACTORY || ADDRESSES.tegridyFactory;
  const nativePair = config.nativePair;

  const factory = {
    address: factoryAddress,
    guardian: await readAddress('TegridyFactory.guardian()', factoryAddress, SELECTORS.guardian),
    feeToSetter: await readAddress('TegridyFactory.feeToSetter()', factoryAddress, SELECTORS.feeToSetter),
    isPair: await readBool('TegridyFactory.isPair(nativePair)', factoryAddress, encodeAddressArg(SELECTORS.isPair, nativePair)),
    disabled: await readBool('TegridyFactory.disabledPairs(nativePair)', factoryAddress, encodeAddressArg(SELECTORS.disabledPairs, nativePair)),
    disablesToday: await readUint('TegridyFactory.emergencyDisablesToday()', factoryAddress, SELECTORS.emergencyDisablesToday),
    // Read, not recalled. A cap quoted from source would go stale against a
    // redeploy, and the number decides whether the primary call reverts.
    maxDisablesPerDay: await readUint('TegridyFactory.MAX_EMERGENCY_DISABLES_PER_DAY()', factoryAddress, SELECTORS.maxEmergencyDisablesPerDay),
  };

  const consumers = [];
  for (const spec of TWAP_CONSUMERS) {
    const address = process.env[spec.envOverride] || spec.address;
    if (!address) {
      consumers.push({ ...spec, address: null, deployed: false });
      continue;
    }
    // Tri-state. A failed code read must not collapse into "not deployed": that
    // would drop a live, oracle-consuming contract out of the pause plan on an
    // RPC hiccup, and drop it silently.
    let code;
    try {
      code = await rpc('eth_getCode', [address, 'latest']);
    } catch (e) {
      unreadable.push(`${spec.name} code: ${e.message || e}`);
      consumers.push({ ...spec, address, deployed: null });
      continue;
    }
    if (!code || code === '0x') {
      consumers.push({ ...spec, address, deployed: false });
      continue;
    }
    consumers.push({
      ...spec,
      address,
      deployed: true,
      paused: await readBool(`${spec.name}.paused()`, address, SELECTORS.paused),
      owner: await readAddress(`${spec.name}.owner()`, address, SELECTORS.owner),
      // A revert here is the answer, not a fault: it means the deployed bytecode
      // carries no PauseGuardian surface and there is no fast path for it.
      pauseGuardian: await readAddress(`${spec.name}.pauseGuardian()`, address, SELECTORS.pauseGuardian, { optional: true }),
      effect: EFFECTS[spec.key] || `Pauses ${spec.name}.`,
      blastRadius: BLAST[spec.key] || null,
    });
  }
  for (const c of consumers) c.guardianFnAvailable = Boolean(c.pauseGuardian);

  const callers = {};
  const addresses = new Set([factory.guardian, factory.feeToSetter]);
  for (const c of consumers) {
    if (c.owner) addresses.add(c.owner);
    if (c.pauseGuardian) addresses.add(c.pauseGuardian);
  }
  for (const a of addresses) {
    if (a) callers[a] = await readCaller(a);
  }

  return { factory, consumers, callers, unreadable };
}

async function main() {
  const reading = await readLinkage(config);
  const endpointUrl = reading.endpointUrl || config.rpcs[0];
  if (!reading.endpointUrl) {
    unreadable.push(
      `no endpoint served the linkage; the pause surface below was read from ${redactEndpoint(endpointUrl)} unverified`,
    );
  }
  rpc = makeRpc(endpointUrl, { timeoutMs: config.timeoutMs });
  const readings = await readPauseSurface();
  // Everything downstream renders into a public issue body.
  const linkage = publicResult(reading);
  const plan = buildPlan(readings, { nativePair: config.nativePair });

  if (PROBE) {
    const out = renderGithubOutput(linkage, plan);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${out}\n`);
    else console.log(out);

    // Workflow-command annotations so the signal reaches the run summary and not
    // only an issue body. `::error::`/`::warning::` are single-line by contract.
    if (linkage.status === 'HALT') {
      console.log(`::error::ARB LINKAGE HALT — ${linkage.reason.replace(/[\r\n]+/g, ' ')}. The oracle-dependent features must be paused; the exact calls are in the run summary and the incident issue.`);
    } else if (linkage.status === 'ERROR') {
      console.log('::error::Arb linkage UNKNOWN — no endpoint served a complete reading. This run does NOT establish that the linkage holds.');
    } else if (linkage.status === 'WARN') {
      console.log(`::warning::Arb linkage WARN — ${linkage.reason.replace(/[\r\n]+/g, ' ')}`);
    } else {
      console.log(`::notice::${summarise(linkage, plan)}`);
    }
    process.exitCode = 0;
    return;
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ linkage, plan }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  } else {
    console.log(renderPlan(linkage, plan));
  }
  process.exitCode = linkage.code;
}

main().catch((e) => {
  // A crash here leaves the linkage unestablished, which is exit 2 for the same
  // reason an unreadable chain is.
  console.error(`ERROR (treat as HALT) — pause consumer crashed: ${e.message || e}`);
  process.exitCode = PROBE ? 0 : 2;
});
