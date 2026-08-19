// The auto-pause half of the arb-linkage condition, minus the half that signs.
//
// docs/GOLIVE_CORELOOP.md condition 3 asks for "an arb-linkage monitor +
// auto-pause". Pausing is a privileged action and this repository keeps no
// signing key in CI, so the automated half stops one step short of broadcast:
// it detects the HALT, reads who is currently allowed to act, and renders the
// exact call — target, function, argument, calldata — so the decision under
// pressure is "send this" rather than "work out what to send".
//
// Nothing in this module or its caller takes a key, and nothing here may grow
// one. If that ever changes the change is the security review, not a detail of
// it.
//
// Pure: every function takes readings and returns text or structure. The chain
// reads live in ../arbPauseConsumer.mjs so the thresholds and the rendering can
// be asserted without a network.

import { createHash } from 'node:crypto';

/** Derived with `cast sig`, not recalled. */
export const SELECTORS = {
  emergencyDisablePair: '0xe24d0ff7', // emergencyDisablePair(address)
  guardian: '0x452a9320', // guardian()
  feeToSetter: '0x094b7415', // feeToSetter()
  disabledPairs: '0x95b1ce84', // disabledPairs(address)
  isPair: '0xe5e31b13', // isPair(address)
  emergencyDisablesToday: '0xa2095484', // emergencyDisablesToday()
  maxEmergencyDisablesPerDay: '0x7317e24f', // MAX_EMERGENCY_DISABLES_PER_DAY()
  guardianPause: '0xd4593872', // guardianPause()
  pause: '0x8456cb59', // pause()
  paused: '0x5c975abb', // paused()
  owner: '0x8da5cb5b', // owner()
  pauseGuardian: '0x24a3d622', // pauseGuardian()
  safeNonce: '0xaffed0e0', // nonce()
  safeThreshold: '0xe75235b8', // getThreshold()
  safeGetOwners: '0xa0e67e2b', // getOwners()
};

/**
 * Mainnet, chain 1. Cross-checked against frontend/scripts/addresses.json.
 *
 * `tegridyLending` is deliberately absent: it is the un-deployed half of B4.
 * Supply TEGRIDY_LENDING once it exists and it joins the plan; leaving a
 * placeholder here would put an address in the plan that nothing verified.
 */
export const ADDRESSES = {
  tegridyFactory: '0xa24C7287eC56A7DEFDc70033803451240e267a52',
  tegridyTwap: '0xdFdd6D72539A425dC917F49FB834901105cA98c9',
  polAccumulator: '0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2',
  nativePair: '0x55875887B43C2E23aE424AF0FC8606Fdb058a481',
};

/**
 * The contracts that actually read TegridyTWAP, by grep of contracts/src for
 * `ITegridyTWAP`: POLAccumulator and TegridyLending, and nothing else.
 *
 * TegridyNFTLending is named in the GOLIVE_CORELOOP condition-3 list but does
 * not consult the oracle in its source — its loans are priced by lender offers.
 * It is left out rather than paused on a guess; see the note this module emits.
 */
export const TWAP_CONSUMERS = [
  { key: 'polAccumulator', name: 'POLAccumulator', address: ADDRESSES.polAccumulator, envOverride: 'POL_ACCUMULATOR' },
  { key: 'tegridyLending', name: 'TegridyLending', address: null, envOverride: 'TEGRIDY_LENDING' },
];

export function encodeAddressArg(selector, address) {
  return `${selector}${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/**
 * What was actually established about a would-be caller, never what is hoped.
 *
 * A Safe reports `eth_getTransactionCount` 1 the moment it is deployed, so that
 * number says nothing about whether its signers can assemble a quorum. The Safe's
 * own `nonce()` is the count of executed transactions, and zero means the
 * emergency path named in the runbook has never once been exercised. This
 * repository has already paid for treating a named authority as a working one.
 */
export function classifyCaller(reading) {
  if (!reading || reading.kind === 'unknown') {
    return { capability: 'unknown', summary: 'could not be read — nothing about this caller is established' };
  }
  if (reading.kind === 'absent') {
    return { capability: 'none', summary: 'not set (zero address) — this path does not exist' };
  }
  if (reading.kind === 'safe') {
    const quorum = `${reading.threshold}-of-${reading.ownerCount}`;
    if (reading.safeNonce === null) {
      return { capability: 'unknown', summary: `Safe (${quorum}); nonce() unreadable — execution history unknown` };
    }
    if (reading.safeNonce === 0) {
      return {
        capability: 'unproven',
        summary: `Safe (${quorum}) with nonce() = 0 — it has NEVER executed a transaction. Do not discover here whether its signers can assemble.`,
      };
    }
    return { capability: 'proven', summary: `Safe (${quorum}), ${reading.safeNonce} executed transaction(s)` };
  }
  if (reading.kind === 'contract') {
    return { capability: 'unproven', summary: 'a contract that is not Safe-shaped — its execution path is not characterised here' };
  }
  // EOA.
  if (reading.txCount === null) {
    return { capability: 'unknown', summary: 'EOA; transaction count unreadable' };
  }
  if (reading.txCount === 0) {
    return { capability: 'unproven', summary: 'EOA that has never sent a transaction — unfunded or unused' };
  }
  const gas = reading.balanceWei === null ? 'balance unreadable' : `${formatEth(reading.balanceWei)} ETH for gas`;
  return { capability: 'proven', summary: `EOA, ${reading.txCount} transaction(s) sent, ${gas}` };
}

export function formatEth(wei) {
  if (wei === null || wei === undefined) return 'unknown';
  const s = (Number(wei) / 1e18).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' ? '0' : s;
}

const RANK = { proven: 0, unproven: 1, unknown: 2, none: 3 };

/** Same address entering through the same function is one caller, not two. */
export function dedupeCallers(callers) {
  const byKey = new Map();
  for (const c of callers) {
    const key = `${(c.address || '').toLowerCase()}|${c.fn || ''}`;
    const seen = byKey.get(key);
    if (seen) seen.role = `${seen.role} + ${c.role}`;
    else byKey.set(key, { ...c });
  }
  return [...byKey.values()];
}

/**
 * The ordered set of privileged calls that answer a HALT.
 *
 * Action 1 is first because it is the only one that closes the oracle at its
 * SOURCE: `disabledPairs` is checked inside both `TegridyTWAP.update` and
 * `TegridyTWAP.consult`, so one call fails every consumer closed — including
 * consumers not yet deployed, which per-contract pausing cannot reach. The
 * per-contract pauses that follow are defence in depth for the case where the
 * factory call is rate-limited or its caller cannot sign.
 */
export function buildPlan(readings, { nativePair = ADDRESSES.nativePair } = {}) {
  const actions = [];
  const notes = [];
  const f = readings.factory;

  // guardian and feeToSetter are separate roles that may hold the same address —
  // they do today. Listing it twice reads as two independent fallbacks, which is
  // the opposite of what a single shared key means.
  const factoryCallers = dedupeCallers(
    [
      { role: 'factory guardian()', address: f.guardian, ...classifyCaller(readings.callers[f.guardian]) },
      { role: 'factory feeToSetter()', address: f.feeToSetter, ...classifyCaller(readings.callers[f.feeToSetter]) },
    ].filter((c) => c.address),
  ).sort((a, b) => RANK[a.capability] - RANK[b.capability]);

  const factoryBlockers = [];
  if (f.isPair === false) factoryBlockers.push('the factory does not recognise this address as one of its pairs — the call reverts NotAPair()');
  if (f.isPair === null) factoryBlockers.push('isPair() unreadable — cannot confirm the call would be accepted');
  if (f.disabled === true) factoryBlockers.push('already disabled — nothing to send');
  if (f.disabled === null) factoryBlockers.push('disabledPairs() unreadable — current state unknown');
  if (f.disablesToday !== null && f.maxDisablesPerDay !== null && f.disablesToday >= f.maxDisablesPerDay) {
    factoryBlockers.push(`the per-day cap is spent (${f.disablesToday}/${f.maxDisablesPerDay}) — the call reverts EmergencyDisableRateLimited() until UTC midnight`);
  }

  actions.push({
    rank: 1,
    title: 'Close the oracle at its source',
    targetName: 'TegridyFactory',
    target: f.address,
    fn: 'emergencyDisablePair(address)',
    args: [nativePair],
    calldata: encodeAddressArg(SELECTORS.emergencyDisablePair, nativePair),
    callers: factoryCallers,
    effect:
      'Sets disabledPairs[nativePair]. TegridyTWAP.update() and TegridyTWAP.consult() both revert PairDisabled(), so every oracle consumer fails closed at once — present and future, deployed or not.',
    blastRadius:
      'This also halts the native pair itself: swap(), mint(), skim() and sync() revert PAIR_DISABLED, and TegridyRouter refuses routes through it. burn() is deliberately left open so LPs can still exit.',
    reversal:
      'NOT instant. Re-enabling runs proposePairDisabled(pair,false) -> PAIR_DISABLE_DELAY (48h) -> executePairDisabled(pair), feeToSetter only.',
    rateLimit:
      f.disablesToday === null || f.maxDisablesPerDay === null
        ? 'per-day cap unreadable'
        : `${f.disablesToday} of ${f.maxDisablesPerDay} emergency disables used today (UTC)`,
    blockers: factoryBlockers,
  });

  let rank = 2;
  for (const consumer of readings.consumers) {
    if (consumer.deployed === null) {
      notes.push(
        `${consumer.name} at ${consumer.address}: its code could not be read, so whether it is live is UNKNOWN. It consults the TWAP — check it by hand before concluding this plan is complete.`,
      );
      continue;
    }
    if (!consumer.deployed) {
      notes.push(
        `${consumer.name} is not deployed (no code at the configured address, or no address configured). It consults the TWAP, so it re-enters this plan the day it ships — set ${consumer.envOverride}.`,
      );
      continue;
    }
    const blockers = [];
    if (consumer.paused === true) blockers.push('already paused — nothing to send');
    if (consumer.paused === null) blockers.push('paused() unreadable — current state unknown');

    const callers = [];
    if (consumer.guardianFnAvailable && consumer.pauseGuardian) {
      callers.push({
        role: 'pauseGuardian()',
        address: consumer.pauseGuardian,
        fn: 'guardianPause()',
        calldata: SELECTORS.guardianPause,
        ...classifyCaller(readings.callers[consumer.pauseGuardian]),
      });
    }
    if (consumer.owner) {
      callers.push({
        role: 'owner()',
        address: consumer.owner,
        fn: 'pause()',
        calldata: SELECTORS.pause,
        ...classifyCaller(readings.callers[consumer.owner]),
      });
    }
    const ranked = dedupeCallers(callers).sort((a, b) => RANK[a.capability] - RANK[b.capability]);
    callers.length = 0;
    callers.push(...ranked);

    if (!consumer.guardianFnAvailable) {
      notes.push(
        `${consumer.name} has no PauseGuardian surface — pauseGuardian() reverts on the deployed bytecode. Its only pause is owner-gated, so there is no fast path for it and the owner must sign.`,
      );
    }

    actions.push({
      rank: rank++,
      title: `Pause ${consumer.name}`,
      targetName: consumer.name,
      target: consumer.address,
      // The function is per-caller here: the guardian and the owner enter through
      // different entry-points, and sending the wrong one reverts.
      fn: callers.length ? callers[0].fn : 'pause()',
      args: [],
      calldata: callers.length ? callers[0].calldata : SELECTORS.pause,
      callers,
      effect: consumer.effect,
      blastRadius: consumer.blastRadius,
      reversal: 'unpause(), owner only. The guardian can pause but never unpause.',
      rateLimit: null,
      blockers,
    });
  }

  notes.push(
    'TegridyNFTLending is listed under GOLIVE_CORELOOP condition 3 but holds no reference to ITegridyTWAP in contracts/src — its loans are priced by lender offers, not the oracle. It is not in this plan. Pause it if the incident is about NFT collateral rather than the TWAP.',
  );

  return { actions, notes, unreadable: readings.unreadable };
}

/**
 * `--account`/`--ledger`, never `--private-key`. The same reasoning as
 * scripts/pull-caller-credit.mjs: a copy-pasteable command with a key in it is
 * how a key reaches a shell history, and cast already supports every hardware
 * and keystore path.
 */
export function castCommand(action, caller) {
  const fn = caller?.fn || action.fn;
  const args = action.args.length ? ` ${action.args.join(' ')}` : '';
  return `cast send ${action.target} "${fn}"${args} --rpc-url $RPC --account <your-keystore>`;
}

export function safeTxBuilderRow(action, caller) {
  const fn = caller?.fn || action.fn;
  return `to: ${action.target} | value: 0 | data: ${caller?.calldata && !action.args.length ? caller.calldata : action.calldata}   (${fn})`;
}

export function renderPlan(linkage, plan) {
  const out = [];
  out.push(`ARB LINKAGE: ${linkage.status} — ${linkage.reason}`);
  if (linkage.status !== 'ERROR') {
    out.push(`  native ${linkage.nativeWethEth} WETH (${linkage.nativePair})`);
    out.push(`  uniswap ${linkage.uniswapWethEth} WETH (${linkage.uniswapPair})`);
    out.push(`  ratio ${linkage.ratio} (halt<${linkage.haltRatio}x, warn<${linkage.warnRatio}x), block ${linkage.blockNumber}, ${linkage.blockAgeSeconds}s old`);
  }
  out.push('');

  if (linkage.status !== 'HALT' && linkage.status !== 'ERROR') {
    out.push('No pause is indicated by the linkage. The plan below is rendered anyway so the');
    out.push('call is known before it is needed, not derived during the incident.');
    out.push('');
  }

  out.push('PRIVILEGED CALLS — this tool holds no key and sends nothing. A human broadcasts.');
  out.push('');
  for (const a of plan.actions) {
    out.push(`[${a.rank}] ${a.title}`);
    out.push(`    target   ${a.target}  (${a.targetName})`);
    // The owner and the guardian enter through different functions on the same
    // contract, and sending the other one reverts. A single action-level function
    // would be read as "the" call and be wrong for one of the two callers.
    const perCaller = new Set(a.callers.map((c) => c.fn || a.fn)).size > 1;
    out.push(`    function ${perCaller ? 'depends on the caller — see below' : a.fn}`);
    out.push(`    args     ${a.args.length ? a.args.join(', ') : '(none)'}`);
    if (!perCaller) out.push(`    calldata ${a.calldata}`);
    if (a.callers.length === 0) {
      out.push('    caller   NONE READABLE — no authorised address was established for this call');
    }
    for (const c of a.callers) {
      out.push(`    caller   ${c.address}  [${c.role} -> ${c.fn || a.fn}]`);
      out.push(`             ${c.capability.toUpperCase()}: ${c.summary}`);
      out.push(`             ${castCommand(a, c)}`);
      // Rendered for every caller that is not a plain proven EOA, since those are
      // exactly the ones that will be executed through a Safe's own interface.
      if (c.capability !== 'proven') out.push(`             Safe tx builder: ${safeTxBuilderRow(a, c)}`);
    }
    out.push(`    effect   ${a.effect}`);
    if (a.blastRadius) out.push(`    also     ${a.blastRadius}`);
    out.push(`    undo     ${a.reversal}`);
    if (a.rateLimit) out.push(`    limit    ${a.rateLimit}`);
    for (const b of a.blockers) out.push(`    BLOCKED  ${b}`);
    out.push('');
  }

  if (plan.notes.length) {
    out.push('NOTES');
    for (const n of plan.notes) out.push(`  - ${n}`);
    out.push('');
  }
  if (plan.unreadable.length) {
    out.push('READS THAT FAILED — nothing above is proven for these:');
    for (const u of plan.unreadable) out.push(`  - ${u}`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * Hashes the SHAPE of the situation, never the rendered report.
 *
 * revenue-watch.yml learned this the expensive way: a body carrying a live gas
 * price hashes differently every run, so the dedupe can never fire once and the
 * alert posts forever. Block number and timestamp move on their own and are
 * excluded here for the same reason; the depth figures are rounded to the
 * decision's resolution so ordinary trading does not count as a new incident.
 */
export function fingerprint(linkage, plan) {
  const facts = [
    linkage.status,
    linkage.ratio === null ? 'null' : String(Math.round(linkage.ratio)),
    linkage.nativeWethEth === null ? 'null' : linkage.nativeWethEth.toFixed(3),
    linkage.uniswapWethEth === null ? 'null' : linkage.uniswapWethEth.toFixed(3),
    ...plan.actions.map((a) => [
      a.target,
      a.fn,
      [...a.blockers].sort().join('~'),
      a.callers.map((c) => `${c.address}:${c.capability}`).sort().join('~'),
    ].join('|')),
    [...linkage.unreadable].sort().join('~'),
    [...plan.unreadable].sort().join('~'),
  ].join('\n');
  return createHash('sha256').update(facts).digest('hex').slice(0, 16);
}

export function summarise(linkage, plan) {
  if (linkage.status === 'ERROR') return 'arb linkage UNKNOWN — the monitor could not read the chain';
  const blocked = plan.actions.filter((a) => a.blockers.length).length;
  const base = `arb linkage ${linkage.status} at ${linkage.ratio}x (halt<${linkage.haltRatio}x)`;
  return blocked ? `${base}; ${blocked} of ${plan.actions.length} prepared calls are blocked` : base;
}

/**
 * `blind` is separate from `status` on purpose. "We looked and the linkage is
 * broken" and "we could not look" demand different responses, and collapsing
 * them would let an outage read as an incident or, far worse, the reverse.
 */
export function renderGithubOutput(linkage, plan, { delimiter } = {}) {
  const delim = delimiter || `EOF_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const body = renderPlan(linkage, plan)
    .split('\n')
    // An RPC controls some of the text above via error messages. A line equal to
    // the heredoc delimiter would end the GITHUB_OUTPUT value early and let the
    // rest be parsed as further outputs.
    .map((line) => (line.trim() === delim ? '[redacted: heredoc delimiter in RPC output]' : line))
    .join('\n');

  return [
    `arb_status=${linkage.status}`,
    `arb_blind=${linkage.status === 'ERROR'}`,
    `arb_summary=${summarise(linkage, plan).replace(/[\r\n]+/g, ' ')}`,
    `arb_fingerprint=${fingerprint(linkage, plan)}`,
    `arb_report<<${delim}`,
    body,
    delim,
  ].join('\n');
}
