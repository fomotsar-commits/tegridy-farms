// node --test scripts/monitoring/lib/pausePlan.test.mjs
//
// The plan is read under time pressure by someone deciding whether to halt a
// live protocol. What is asserted here is that it cannot overstate what it
// knows: a caller is never "proven" on a reading that did not establish it, a
// blocked call is never rendered as ready, and no command it prints carries a key.

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  ADDRESSES,
  SELECTORS,
  buildPlan,
  castCommand,
  classifyCaller,
  dedupeCallers,
  encodeAddressArg,
  fingerprint,
  renderGithubOutput,
  renderPlan,
  summarise,
} from './pausePlan.mjs';

const NATIVE = '0x55875887B43C2E23aE424AF0FC8606Fdb058a481';
const EOA = '0x14898258122c0740106391e6e8e4f17f3b6d456e';
const SAFE = '0xcdca0f0621ce34012ad61bbd140f327eb778f354';

const linkage = {
  status: 'HALT',
  code: 2,
  reason: 'arb venue depth 2.10x < 3x native — pause oracle features',
  ratio: 2.1,
  nativeWethEth: 3.5,
  uniswapWethEth: 7.35,
  nativePair: NATIVE,
  uniswapPair: '0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D',
  haltRatio: 3,
  warnRatio: 4,
  liveFloorWeth: 1,
  blockNumber: 25_790_000,
  blockAgeSeconds: 11,
  unreadable: [],
};

const readings = ({ overrides = {}, consumers, callers } = {}) => ({
  factory: {
    address: ADDRESSES.tegridyFactory,
    guardian: EOA,
    feeToSetter: EOA,
    isPair: true,
    disabled: false,
    disablesToday: 0,
    maxDisablesPerDay: 3,
    ...overrides,
  },
  consumers: consumers || [
    {
      key: 'polAccumulator',
      name: 'POLAccumulator',
      address: ADDRESSES.polAccumulator,
      envOverride: 'POL_ACCUMULATOR',
      deployed: true,
      paused: false,
      owner: EOA,
      pauseGuardian: SAFE,
      guardianFnAvailable: true,
      effect: 'Blocks accumulate().',
      blastRadius: 'POL accumulation stops.',
    },
    { key: 'tegridyLending', name: 'TegridyLending', address: null, envOverride: 'TEGRIDY_LENDING', deployed: false },
  ],
  callers: callers || {
    [EOA]: { kind: 'eoa', txCount: 97, balanceWei: 9_199_000_000_000_000n },
    [SAFE]: { kind: 'safe', safeNonce: 0, threshold: 1, ownerCount: 2, balanceWei: 0n },
  },
  unreadable: [],
});

test('a Safe that has never executed is UNPROVEN, however it is named in a runbook', () => {
  const c = classifyCaller({ kind: 'safe', safeNonce: 0, threshold: 1, ownerCount: 2 });
  assert.equal(c.capability, 'unproven');
  assert.match(c.summary, /NEVER executed/);
});

test('a Safe with executions is PROVEN', () => {
  assert.equal(classifyCaller({ kind: 'safe', safeNonce: 4, threshold: 2, ownerCount: 3 }).capability, 'proven');
});

test('an EOA that has never sent a transaction is UNPROVEN', () => {
  assert.equal(classifyCaller({ kind: 'eoa', txCount: 0, balanceWei: 0n }).capability, 'unproven');
});

test('an unreadable caller is UNKNOWN, never proven and never absent', () => {
  assert.equal(classifyCaller({ kind: 'unknown' }).capability, 'unknown');
  assert.equal(classifyCaller(null).capability, 'unknown');
});

test('an unset role reports as none rather than as a caller', () => {
  assert.equal(classifyCaller({ kind: 'absent' }).capability, 'none');
});

test('the factory disable ranks first — it is the only call that closes the oracle at source', () => {
  const plan = buildPlan(readings());
  assert.equal(plan.actions[0].rank, 1);
  assert.equal(plan.actions[0].target, ADDRESSES.tegridyFactory);
  assert.equal(plan.actions[0].fn, 'emergencyDisablePair(address)');
  assert.deepEqual(plan.actions[0].args, [NATIVE]);
  assert.equal(
    plan.actions[0].calldata,
    `${SELECTORS.emergencyDisablePair}00000000000000000000000055875887b43c2e23ae424af0fc8606fdb058a481`,
  );
});

test('the factory action states that undoing it is timelocked, not instant', () => {
  assert.match(buildPlan(readings()).actions[0].reversal, /48h/);
});

test('an already-disabled pair is reported as blocked rather than as a call to make', () => {
  const plan = buildPlan(readings({ overrides: { disabled: true } }));
  assert.match(plan.actions[0].blockers.join(' '), /already disabled/);
});

test('a spent per-day cap is a blocker, because the call would revert', () => {
  const plan = buildPlan(readings({ overrides: { disablesToday: 3 } }));
  assert.match(plan.actions[0].blockers.join(' '), /per-day cap is spent/);
});

test('an unreadable precondition blocks rather than being assumed favourable', () => {
  const plan = buildPlan(readings({ overrides: { isPair: null, disabled: null } }));
  const blockers = plan.actions[0].blockers.join(' ');
  assert.match(blockers, /isPair\(\) unreadable/);
  assert.match(blockers, /disabledPairs\(\) unreadable/);
});

test('a pair the factory does not recognise is blocked with the revert named', () => {
  const plan = buildPlan(readings({ overrides: { isPair: false } }));
  assert.match(plan.actions[0].blockers.join(' '), /NotAPair/);
});

test('proven callers are offered before unproven ones', () => {
  const plan = buildPlan(readings());
  const pol = plan.actions.find((a) => a.targetName === 'POLAccumulator');
  assert.equal(pol.callers[0].capability, 'proven');
  assert.equal(pol.callers[0].address, EOA);
  assert.equal(pol.callers[1].capability, 'unproven');
});

test('the guardian entry-point is guardianPause(), not pause()', () => {
  const plan = buildPlan(readings());
  const pol = plan.actions.find((a) => a.targetName === 'POLAccumulator');
  const guardianCaller = pol.callers.find((c) => c.address === SAFE);
  assert.equal(guardianCaller.fn, 'guardianPause()');
  assert.equal(guardianCaller.calldata, SELECTORS.guardianPause);
  const ownerCaller = pol.callers.find((c) => c.address === EOA);
  assert.equal(ownerCaller.fn, 'pause()');
});

test('a contract with no PauseGuardian surface yields an owner-only path and says so', () => {
  const plan = buildPlan(
    readings({
      consumers: [
        {
          key: 'tegridyLending',
          name: 'TegridyLending',
          address: '0x0000000000000000000000000000000000000abc',
          envOverride: 'TEGRIDY_LENDING',
          deployed: true,
          paused: false,
          owner: EOA,
          pauseGuardian: null,
          guardianFnAvailable: false,
          effect: 'Blocks origination.',
          blastRadius: null,
        },
      ],
    }),
  );
  const lending = plan.actions.find((a) => a.targetName === 'TegridyLending');
  assert.equal(lending.callers.length, 1);
  assert.equal(lending.callers[0].fn, 'pause()');
  assert.match(plan.notes.join(' '), /no PauseGuardian surface/);
});

test('an undeployed TWAP consumer is named as absent, never given an invented address', () => {
  const plan = buildPlan(readings());
  assert.equal(plan.actions.some((a) => a.targetName === 'TegridyLending'), false);
  assert.match(plan.notes.join(' '), /TegridyLending is not deployed/);
  assert.match(plan.notes.join(' '), /TEGRIDY_LENDING/);
});

test('a consumer whose code could not be read is UNKNOWN, never quietly "not deployed"', () => {
  const plan = buildPlan(
    readings({
      consumers: [
        { key: 'tegridyLending', name: 'TegridyLending', address: '0x0000000000000000000000000000000000000abc', envOverride: 'TEGRIDY_LENDING', deployed: null },
      ],
    }),
  );
  const notes = plan.notes.join(' ');
  assert.match(notes, /whether it is live is UNKNOWN/);
  assert.equal(/TegridyLending is not deployed/.test(notes), false);
});

test('TegridyNFTLending is excluded with the reason stated, not silently dropped', () => {
  assert.match(buildPlan(readings()).notes.join(' '), /TegridyNFTLending.*not in this plan/s);
});

test('one address holding two roles is listed once, with both roles named', () => {
  const merged = dedupeCallers([
    { role: 'factory guardian()', address: EOA, capability: 'proven' },
    { role: 'factory feeToSetter()', address: EOA, capability: 'proven' },
  ]);
  assert.equal(merged.length, 1);
  assert.match(merged[0].role, /guardian\(\) \+ .*feeToSetter\(\)/);
});

test('no rendered command carries a private key', () => {
  const plan = buildPlan(readings());
  const text = renderPlan(linkage, plan);
  assert.equal(text.includes('--private-key'), false);
  assert.equal(text.includes('PRIVATE_KEY'), false);
  assert.match(castCommand(plan.actions[0], plan.actions[0].callers[0]), /--account/);
});

test('the report states that nothing was sent', () => {
  assert.match(renderPlan(linkage, buildPlan(readings())), /holds no key and sends nothing/);
});

test('an unreadable pause surface is surfaced, not omitted', () => {
  const r = readings();
  r.unreadable = ['TegridyFactory.guardian(): HTTP 503'];
  assert.match(renderPlan(linkage, buildPlan(r)), /READS THAT FAILED/);
});

test('the fingerprint ignores block motion so an unchanged incident stops re-posting', () => {
  const plan = buildPlan(readings());
  const later = { ...linkage, blockNumber: linkage.blockNumber + 300, blockAgeSeconds: 3, at: 'later' };
  assert.equal(fingerprint(linkage, plan), fingerprint(later, plan));
});

test('the fingerprint changes when the situation does', () => {
  const plan = buildPlan(readings());
  const blocked = buildPlan(readings({ overrides: { disabled: true } }));
  assert.notEqual(fingerprint(linkage, plan), fingerprint(linkage, blocked));
  assert.notEqual(fingerprint(linkage, plan), fingerprint({ ...linkage, status: 'GO', ratio: 9 }, plan));
});

test('a blind reading summarises as unknown, never as a linkage that was measured', () => {
  const blind = { ...linkage, status: 'ERROR', ratio: null, nativeWethEth: null, uniswapWethEth: null };
  const s = summarise(blind, buildPlan(readings()));
  assert.match(s, /UNKNOWN/);
  assert.equal(/\d+x/.test(s), false);
});

test('github output separates blind from broken', () => {
  const plan = buildPlan(readings());
  const halt = renderGithubOutput(linkage, plan, { delimiter: 'EOF_X' });
  assert.match(halt, /arb_status=HALT/);
  assert.match(halt, /arb_blind=false/);

  const blind = { ...linkage, status: 'ERROR', ratio: null, nativeWethEth: null, uniswapWethEth: null };
  assert.match(renderGithubOutput(blind, plan, { delimiter: 'EOF_X' }), /arb_blind=true/);
});

test('a delimiter appearing in RPC-supplied text cannot close the heredoc early', () => {
  const r = readings();
  // The reachable shape: an RPC error string carrying its own newline, so the
  // delimiter lands at the start of a line rather than behind the renderer's
  // bullet prefix.
  r.unreadable = ['TegridyFactory.guardian(): upstream said\nEOF_X\narb_status=GO'];
  const out = renderGithubOutput(linkage, buildPlan(r), { delimiter: 'EOF_X' });
  const body = out.split('arb_report<<EOF_X\n')[1];
  assert.equal(body.split('\n').filter((l) => l.trim() === 'EOF_X').length, 1, 'exactly the real terminator');
  assert.match(out, /\[redacted: heredoc delimiter in RPC output\]/);
});

test('the summary counts blocked calls so a plan of dead ends is not read as ready', () => {
  const plan = buildPlan(readings({ overrides: { disabled: true } }));
  assert.match(summarise(linkage, plan), /1 of \d+ prepared calls are blocked/);
});

test('address arguments encode to a left-padded word', () => {
  assert.equal(
    encodeAddressArg('0xdeadbeef', '0x0000000000000000000000000000000000000001'),
    '0xdeadbeef0000000000000000000000000000000000000000000000000000000000000001',
  );
});
