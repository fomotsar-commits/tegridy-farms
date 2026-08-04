#!/usr/bin/env node
/**
 * Pre-flight and read-back guard for IRREVERSIBLE one-shot setters.
 *
 * WHY
 * ---
 * Several setters in this protocol can succeed exactly once. They revert
 * `…AlreadySet` on a second call, so a typo is not a bug you fix — it is the
 * permanent state of a live contract. `VoteIncentives.setGaugeController` is the
 * one the plan intends to fire; it is not the only one.
 *
 * The danger is not a revert. A revert is free. The danger is a call that
 * SUCCEEDS against a plausible-but-wrong address.
 *
 * Every selector below was DERIVED with `cast sig`, not recalled. Two of them
 * were wrong the first time this file was written because they were recalled:
 * restakingContract() is 0xf1f3b3e7 and sequencerFeed() is 0x3b521cb6. A wrong
 * getter here would report a loaded shot as fired, or the reverse.
 *
 * WHAT IT DOES
 *   --list                       every one-shot, and whether it has already fired
 *   --check <key> --to <addr>    pre-flight: refuse unless every precondition holds
 *   --verify <key> --to <addr>   post-flight: read the slot back and diff vs intent
 *   --self-test                  prove the decision table
 *
 * It NEVER sends a transaction. It prints calldata for a human to broadcast.
 *
 * THE INVENTORY BELOW WAS BUILT BY READING EVERY SETTER BODY, then reading each
 * slot on mainnet (2026-08-02). Two results worth carrying:
 *
 *   • `GaugeController.setRestakingContract` is NOT one-shot and is deliberately
 *     absent. It is a timelocked propose/execute/cancel that emits
 *     `RestakingContractChanged(old, new)` — rotatable. Its `RestakingAlreadySet`
 *     error is declared but unreachable in that flow. Grepping for the error name
 *     would have put it on this list; reading the body kept it off.
 *
 *   • `setGaugeController` already enforces `codeLen > 0 && codeLen != 23`
 *     ("GC_MUST_BE_CONTRACT"), the EIP-7702 carve-out. The four
 *     `setRestakingContract` setters DO NOT. So a 7702-delegated EOA would be
 *     accepted there and permanently brick the slot. This guard applies the
 *     stricter rule everywhere, precisely because the contracts do not.
 */

const DEFAULT_RPC = 'https://ethereum-rpc.publicnode.com';

/** EIP-7702 designators are exactly 23 bytes (0xef0100 + 20). */
export const EIP7702_CODE_LEN = 23;

// key -> { contract, address, getter selector, setter selector, setter sig, notes }
export const ONESHOTS = {
  'voteincentives.gaugeController': {
    contract: 'VoteIncentives',
    address: '0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF',
    getter: '0x99eecb3b', // gaugeController()
    setter: '0x0091d2b8', // setGaugeController(address)
    sig: 'setGaugeController(address)',
    expectContract: true,
    why: 'While this reads 0x0, _requireGaugedPair is a COMPLETE NO-OP — the live '
       + 'bribe market accepts deposits against arbitrary pairs. Wiring it is the fix, '
       + 'and it can only be done once.',
  },
  'voteincentives.restakingContract': {
    contract: 'VoteIncentives',
    address: '0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF',
    getter: '0xf1f3b3e7', // restakingContract()
    setter: '0x2be25dd6', // setRestakingContract(address)
    sig: 'setRestakingContract(address)',
    expectContract: true,
    weakerThanItLooks: 'This setter has NO code-length check — unlike setGaugeController. '
       + 'A typo’d EOA or 7702 address is accepted and the slot is bricked forever.',
    why: 'Dormant: TegridyRestaking is EIP-170 blocked and undeployed.',
  },
  'communitygrants.restakingContract': {
    contract: 'CommunityGrants',
    address: '0xebc3aaf48297b8ccfa8272d9e68c1545eb9cd471',
    getter: '0xf1f3b3e7', setter: '0x2be25dd6', sig: 'setRestakingContract(address)',
    expectContract: true,
    weakerThanItLooks: 'No code-length check in the setter.',
    why: 'Dormant until TegridyRestaking exists.',
  },
  'memebountyboard.restakingContract': {
    contract: 'MemeBountyBoard',
    address: '0x6d2c6ec29d97fe8b6d1471091deee36baf69d890',
    getter: '0xf1f3b3e7', setter: '0x2be25dd6', sig: 'setRestakingContract(address)',
    expectContract: true,
    weakerThanItLooks: 'No code-length check in the setter.',
    why: 'Dormant until TegridyRestaking exists.',
  },
  'referralsplitter.restakingContract': {
    contract: 'ReferralSplitter',
    address: '0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c',
    getter: '0xf1f3b3e7', setter: '0x2be25dd6', sig: 'setRestakingContract(address)',
    expectContract: true,
    weakerThanItLooks: 'No code-length check in the setter.',
    why: 'Dormant until TegridyRestaking exists.',
  },
  'swapfeerouter.sequencerFeed': {
    contract: 'SwapFeeRouter',
    address: '0x6d5791A660e79175F74C6D639584C98422d5956E',
    getter: '0x3b521cb6', // sequencerFeed()
    setter: '0x8a45d536', // setSequencerFeed(address)
    sig: 'setSequencerFeed(address)',
    expectContract: true,
    neverOnMainnet: true,
    why: 'Chainlink L2 Sequencer Uptime feed. DeployLaunchpadV2.s.sol:39-40 — '
       + '"address(0) on mainnet / non-L2 (no-op)". There is no such feed on mainnet, '
       + 'so firing this here is a mistake, not a step.',
  },
  'nftlending.sequencerFeed': {
    contract: 'TegridyNFTLending',
    address: '0x89BeB6cc0255B7465c01aA38a6f937efd345f14F',
    getter: '0x3b521cb6', setter: '0x8a45d536', sig: 'setSequencerFeed(address)',
    expectContract: true,
    neverOnMainnet: true,
    why: 'Same as swapfeerouter.sequencerFeed — mainnet has no L2 sequencer feed.',
  },
};

const ZERO = '0x0000000000000000000000000000000000000000';

// ── pure decision core ────────────────────────────────────────────────────
/**
 * Decide whether an irreversible call is safe to broadcast.
 * Pure so --self-test can cover every refusal without touching a chain.
 */
export function preflight({ spec, currentValue, targetCode, target, chainId }) {
  const blockers = [];
  const warnings = [];
  const t = (target || '').toLowerCase();

  if (spec.neverOnMainnet && chainId === 1) {
    blockers.push(
      `${spec.sig} must NEVER be fired on mainnet (chainId 1). ${spec.why}`,
    );
  }

  if (currentValue === null) {
    blockers.push('could not read the current value — refusing to fire blind');
    return { ok: false, blockers, warnings };
  }
  if (currentValue !== ZERO) {
    blockers.push(
      `already fired: reads ${currentValue}. A second call reverts — this is spent, not pending.`,
    );
  }

  if (!t || t === ZERO) blockers.push('target is the zero address');
  if (t && t === spec.address.toLowerCase()) blockers.push('target is the contract itself');

  if (spec.expectContract) {
    if (targetCode === null) {
      blockers.push('could not read the target’s code — refusing to fire blind');
    } else {
      const len = (targetCode.length - 2) / 2;
      if (len === 0) {
        blockers.push('target has NO CODE — it is an EOA, not a contract');
      } else if (len === EIP7702_CODE_LEN) {
        // The exact case setGaugeController's "GC_MUST_BE_CONTRACT" carve-out
        // exists for, and the case the restaking setters do NOT check.
        blockers.push(
          `target is a ${EIP7702_CODE_LEN}-byte EIP-7702 designator (a delegated EOA), not a contract`,
        );
      }
    }
  }

  if (spec.weakerThanItLooks) warnings.push(spec.weakerThanItLooks);

  return { ok: blockers.length === 0, blockers, warnings };
}

/** Post-broadcast: did the slot land on exactly what we intended? */
export function verifyReadBack({ currentValue, target }) {
  if (currentValue === null) return { ok: false, message: 'could not read the slot back' };
  if (currentValue === ZERO) return { ok: false, message: 'slot is STILL ZERO — the call did not land' };
  if (currentValue.toLowerCase() !== (target || '').toLowerCase()) {
    return { ok: false, message: `slot reads ${currentValue}, intended ${target} — WRONG TARGET, and it is permanent` };
  }
  return { ok: true, message: `slot reads ${currentValue} — matches intent` };
}

/** ABI-encode a `f(address)` call. */
export function encodeAddressCall(selector, address) {
  return selector + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

// ── rpc ───────────────────────────────────────────────────────────────────
async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const j = await res.json();
  return j.error ? null : j.result;
}
const call = (url, to, data) => rpc(url, 'eth_call', [{ to, data }, 'latest']);

function decodeAddress(hex) {
  if (typeof hex !== 'string' || hex.length < 66) return null;
  return '0x' + hex.slice(2).slice(24, 64).toLowerCase();
}

// ── self-test ─────────────────────────────────────────────────────────────
function selfTest() {
  const spec = ONESHOTS['voteincentives.gaugeController'];
  const good = '0x' + 'ab'.repeat(20);
  const base = { spec, currentValue: ZERO, targetCode: '0x6080604052', target: good, chainId: 1 };
  const cases = [];
  const ok = (n, c) => cases.push([n, c]);

  ok('a loaded shot at a real contract passes', preflight(base).ok);
  ok('an already-fired slot is refused',
    preflight({ ...base, currentValue: '0x' + 'cd'.repeat(20) }).blockers.some((b) => /already fired/.test(b)));
  ok('an unreadable current value is refused rather than assumed empty',
    preflight({ ...base, currentValue: null }).blockers.some((b) => /refusing to fire blind/.test(b)));
  ok('the zero address is refused',
    preflight({ ...base, target: ZERO }).blockers.some((b) => /zero address/.test(b)));
  ok('the contract itself is refused',
    preflight({ ...base, target: spec.address }).blockers.some((b) => /contract itself/.test(b)));
  ok('a code-less EOA target is refused',
    preflight({ ...base, targetCode: '0x' }).blockers.some((b) => /NO CODE/.test(b)));
  ok('a 23-byte EIP-7702 designator is refused',
    preflight({ ...base, targetCode: '0xef0100' + 'bb'.repeat(20) }).blockers.some((b) => /7702/.test(b)));
  ok('unreadable target code is refused rather than assumed a contract',
    preflight({ ...base, targetCode: null }).blockers.some((b) => /refusing to fire blind/.test(b)));
  ok('a never-on-mainnet setter is refused on chainId 1', (() => {
    const s = ONESHOTS['swapfeerouter.sequencerFeed'];
    return preflight({ spec: s, currentValue: ZERO, targetCode: '0x6080', target: good, chainId: 1 })
      .blockers.some((b) => /NEVER be fired on mainnet/.test(b));
  })());
  ok('the same setter is allowed off mainnet', (() => {
    const s = ONESHOTS['swapfeerouter.sequencerFeed'];
    return preflight({ spec: s, currentValue: ZERO, targetCode: '0x6080', target: good, chainId: 8453 }).ok;
  })());
  ok('a setter lacking its own code check still WARNS', (() => {
    const s = ONESHOTS['voteincentives.restakingContract'];
    return preflight({ spec: s, currentValue: ZERO, targetCode: '0x6080', target: good, chainId: 1 })
      .warnings.some((w) => /NO code-length check/.test(w));
  })());
  ok('read-back matches intent', verifyReadBack({ currentValue: good, target: good }).ok);
  ok('read-back catches a still-zero slot',
    /STILL ZERO/.test(verifyReadBack({ currentValue: ZERO, target: good }).message));
  ok('read-back catches the WRONG target',
    /WRONG TARGET/.test(verifyReadBack({ currentValue: '0x' + '99'.repeat(20), target: good }).message));
  ok('calldata encodes to 4-byte selector + 32-byte word',
    encodeAddressCall('0x0091d2b8', good) === '0x0091d2b8' + '00'.repeat(12) + 'ab'.repeat(20));

  let failed = 0;
  for (const [n, pass] of cases) {
    if (pass) console.log(`  ✅ ${n}`);
    else { failed++; console.error(`  ❌ ${n}`); }
  }
  if (failed) {
    console.error(`\n❌ oneshot-guard self-test: ${failed}/${cases.length} failed`);
    process.exit(1);
  }
  console.log(`\n✅ oneshot-guard self-test: ${cases.length}/${cases.length} passed`);
}

// ── main ──────────────────────────────────────────────────────────────────
const arg = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();

  const url = arg(argv, '--rpc') || process.env.ETH_RPC_URL || DEFAULT_RPC;
  const chainId = Number(await rpc(url, 'eth_chainId', [])) || 1;

  if (argv.includes('--list') || argv.length === 0) {
    console.log(`one-shot setters (chainId ${chainId})\n`);
    for (const [key, spec] of Object.entries(ONESHOTS)) {
      const v = decodeAddress(await call(url, spec.address, spec.getter));
      const state = v === null ? '?? unreadable'
        : v === ZERO ? '🔴 UNFIRED — one shot remaining'
        : `✅ fired -> ${v}`;
      console.log(`  ${key}`);
      console.log(`     ${spec.contract} ${spec.address}`);
      console.log(`     ${state}`);
      if (spec.neverOnMainnet) console.log('     🛑 MUST NEVER BE FIRED ON MAINNET');
      if (spec.weakerThanItLooks) console.log(`     ⚠ ${spec.weakerThanItLooks}`);
      console.log('');
    }
    console.log('Nothing was asserted. Use --check <key> --to <address> before broadcasting.');
    return;
  }

  const key = arg(argv, '--check') || arg(argv, '--verify');
  const target = arg(argv, '--to');
  const spec = ONESHOTS[key];
  if (!spec) {
    throw new Error(`unknown one-shot '${key}'. Known: ${Object.keys(ONESHOTS).join(', ')}`);
  }
  if (!target || !/^0x[0-9a-fA-F]{40}$/.test(target)) {
    throw new Error('--to <address> is required and must be a 20-byte hex address');
  }

  const currentValue = decodeAddress(await call(url, spec.address, spec.getter));

  if (argv.includes('--verify')) {
    const r = verifyReadBack({ currentValue, target });
    console.log(r.ok ? `✅ ${r.message}` : `❌ ${r.message}`);
    process.exit(r.ok ? 0 : 1);
  }

  const targetCode = await rpc(url, 'eth_getCode', [target, 'latest']);
  const { ok, blockers, warnings } = preflight({ spec, currentValue, targetCode, target, chainId });

  console.log(`${spec.contract}.${spec.sig}`);
  console.log(`  contract  ${spec.address}`);
  console.log(`  target    ${target}`);
  console.log(`  current   ${currentValue ?? 'UNREADABLE'}`);
  console.log(`  chainId   ${chainId}\n`);
  if (spec.why) console.log(`  ${spec.why}\n`);
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
  for (const b of blockers) console.error(`  ❌ ${b}`);

  if (!ok) {
    console.error('\n🛑 DO NOT BROADCAST.');
    process.exit(1);
  }

  // Simulate from the current owner, so an onlyOwner failure surfaces here
  // rather than as a reverted broadcast.
  const owner = decodeAddress(await call(url, spec.address, '0x8da5cb5b'));
  const data = encodeAddressCall(spec.setter, target);
  const sim = await rpc(url, 'eth_call', [{ from: owner, to: spec.address, data }, 'latest']);
  if (sim === null) {
    console.error(`  ❌ simulation from owner ${owner} REVERTED — do not broadcast`);
    process.exit(1);
  }

  console.log('  ✅ every precondition holds, and the call simulates cleanly from the owner.\n');
  console.log(`  owner    ${owner}`);
  console.log(`  to       ${spec.address}`);
  console.log(`  data     ${data}\n`);
  console.log('  Have a second person read that calldata before signing.');
  console.log(`  IMMEDIATELY after broadcasting, run:`);
  console.log(`    node scripts/oneshot-guard.mjs --verify ${key} --to ${target}`);
  console.log('  A receipt is not proof of state.');
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`❌ oneshot-guard could not run: ${err.message}`);
  process.exit(1);
});
