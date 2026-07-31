// Pins our hand-rolled Airlock ABI fragments to the DEPLOYED contract's bytecode.
//
// Every other test of these modules mocks the transport, so a fragment naming a
// function the Airlock does not have decodes canned data and passes forever. That is
// exactly how `integratorFees(address,address)` survived: it came from the SDK's
// airlockAbi (stale — the deployed accessor is `getIntegratorFees`), every live read
// reverted, multicall's allowFailure dropped the failures, and the UI showed
// "nothing to claim" over real integrator revenue.
//
// This suite closes that blind spot for all three Airlock fragments. It stays hermetic:
// the deployed selector set is captured once by
// frontend/scripts/capture-airlock-selectors.mjs into airlockSelectors.fixture.ts, and
// the assertions run against that snapshot rather than the network.
//
// Selectors are DERIVED here with viem's toFunctionSelector, straight off the ABI
// objects the production code uses. Hardcoding them would only re-assert the typo.

import { describe, it, expect } from 'vitest';
import { toFunctionSelector, type AbiFunction } from 'viem';

import { AIRLOCK_FEES_ABI } from './integratorFees';
import { AIRLOCK_ABI, DOPPLER_MAINNET } from './doppler.constants';
import { AIRLOCK_GET_ASSET_DATA } from './ourLaunches';
import {
  AIRLOCK_ADDRESS,
  AIRLOCK_DEPLOYED_SELECTORS,
  AIRLOCK_DISPATCHED_SELECTORS,
} from './airlockSelectors.fixture';

/** Every function fragment that production code points at the Airlock. */
const DECLARED: ReadonlyArray<{ source: string; fn: AbiFunction }> = [
  ...AIRLOCK_FEES_ABI.map((fn) => ({ source: 'AIRLOCK_FEES_ABI', fn: fn as AbiFunction })),
  ...AIRLOCK_ABI.map((fn) => ({ source: 'AIRLOCK_ABI', fn: fn as AbiFunction })),
  { source: 'AIRLOCK_GET_ASSET_DATA', fn: AIRLOCK_GET_ASSET_DATA as AbiFunction },
];

describe('Airlock ABI fragments — pinned to deployed bytecode', () => {
  it('captures the same Airlock the app actually calls', () => {
    // A fixture for a different address would police nothing.
    expect(AIRLOCK_ADDRESS).toBe(DOPPLER_MAINNET.airlock.toLowerCase());
  });

  it('covers all three hand-rolled fragments', () => {
    // Guards against a fragment being added to the app but never listed here — the
    // suite would otherwise stay green while the new fragment goes unpinned.
    expect(DECLARED.map((d) => d.fn.name).sort()).toEqual([
      'collectIntegratorFees',
      'getAssetData',
      'getIntegratorFees',
      'getModuleState',
      'migrate',
      'owner',
    ]);
  });

  it.each(DECLARED.map((d) => [d.source, d.fn.name, d.fn] as const))(
    '%s declares %s, and the deployed Airlock has it',
    (_source, _name, fn) => {
      const selector = toFunctionSelector(fn);
      expect(AIRLOCK_DEPLOYED_SELECTORS.has(selector)).toBe(true);
    },
  );

  // The walk over-reports: a selector the Airlock CALLS on another contract (approve,
  // transfer, balanceOf are all in the set) also lands there. For the view functions we
  // could probe, require the stronger signal — a live call that actually returned data.
  it.each(['getIntegratorFees', 'getModuleState', 'owner', 'getAssetData'])(
    '%s is proven to dispatch, not merely present as a PUSH4 constant',
    (name) => {
      const entry = DECLARED.find((d) => d.fn.name === name);
      expect(entry, `${name} is not declared by any fragment`).toBeDefined();
      expect(AIRLOCK_DISPATCHED_SELECTORS.has(toFunctionSelector(entry!.fn))).toBe(true);
    },
  );
});

describe('the integratorFees regression itself', () => {
  it('never re-declares the SDK name the Airlock does not implement', () => {
    // The whole bug in one line. `integratorFees` reads naturally, the SDK exports it,
    // and it is wrong — reverting on every call.
    // Widened to `{ name: string }` deliberately: AIRLOCK_FEES_ABI is `as const`, so
    // comparing against a name it no longer contains is a compile error (TS2367) rather
    // than the runtime `false` this asserts. The check has to survive the rename being
    // undone, which is precisely the case where the literal type would also change.
    const names = (AIRLOCK_FEES_ABI as readonly { name: string }[]).map((f) => f.name);
    expect(names).not.toContain('integratorFees');
    expect(names).toContain('getIntegratorFees');
  });

  it('confirms 0x2b79198a is genuinely absent from the deployed contract', () => {
    // Pins the negative too: if a future capture ever DID contain integratorFees, the
    // rename above would be wrong and this tells us immediately.
    expect(toFunctionSelector('integratorFees(address,address)')).toBe('0x2b79198a');
    expect(AIRLOCK_DEPLOYED_SELECTORS.has('0x2b79198a')).toBe(false);
    expect(AIRLOCK_DISPATCHED_SELECTORS.has('0xe7f0d8f1')).toBe(true);
  });

  it('reads the fee mapping as (integrator, token) -> uint256', () => {
    // Argument order and return type are load-bearing: src/Airlock.sol declares
    //   mapping(address integrator => mapping(address token => uint256 amount))
    //       public getIntegratorFees;
    // A swapped pair would silently read an empty slot and re-hide the revenue.
    const fn = AIRLOCK_FEES_ABI.find((f) => f.name === 'getIntegratorFees');
    expect(fn?.inputs.map((i) => i.name)).toEqual(['integrator', 'token']);
    expect(fn?.inputs.map((i) => i.type)).toEqual(['address', 'address']);
    expect(fn?.outputs.map((o) => o.type)).toEqual(['uint256']);
    expect(fn?.stateMutability).toBe('view');
  });
});
