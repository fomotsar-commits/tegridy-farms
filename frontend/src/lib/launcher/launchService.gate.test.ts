// WHERE the Heat gate sits on the EVM rail.
//
// Separate from launchService.test.ts because that file mocks `isLauncherEnabled` FALSE
// for the whole module, so `launchToken` returns at its first line and never reaches the
// gate. Here the launcher is enabled, and the gate is the thing under test.
//
// The invariant: a denial happens above the SDK import, above `simulateCreateDynamicAuction`
// and above `createDynamicAuction` — so `broadcast: false` on the resulting LaunchError is a
// fact about the chain, not an optimistic guess. The EVM rail already shipped a
// double-launch once (a receipt-wait timeout re-enabled the button, #125); anything that
// could be mistaken for a broadcast has to stay below this line.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseEther, type Address } from 'viem';

const sdkCtor = vi.hoisted(() => vi.fn());
vi.mock('@whetstone-research/doppler-sdk/evm', () => ({
  DopplerSDK: class {
    constructor(...args: unknown[]) {
      sdkCtor(...args);
    }
    factory = {
      simulateCreateDynamicAuction: vi.fn(),
      createDynamicAuction: vi.fn(),
    };
  },
}));

vi.mock('./config', async (importActual) => {
  const actual = await importActual<typeof import('./config')>();
  return { ...actual, isLauncherEnabled: () => true };
});

import { wizardConfigToLaunchConfig, launchToken, LaunchError, type LaunchWizardInput } from './launchService';
import { HeatGateDenied } from '../heat/launchGate';
import { clearGateAudit } from '../heat/gateAudit';

const CREATOR = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a' as Address;

const wizard = (): LaunchWizardInput => ({
  tier: 'listable',
  name: 'Test Coin',
  symbol: 'TEST',
  tokenURI: 'ipfs://meta',
  totalSupply: '1000000',
  premineBps: 0,
  vestMonths: 0,
  lpLockMonths: 1,
  mcapStartK: 100,
  mcapFloorK: 10,
});

const cfg = () =>
  wizardConfigToLaunchConfig(wizard(), { userAddress: CREATOR, attentionSplits: [], numerairePriceUsd: 3000 });

beforeEach(() => {
  vi.clearAllMocks();
  clearGateAudit();
  // No oracle in the test environment: the gate fails closed, which IS the scenario.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  }));
});

describe('the Heat gate on the EVM rail', () => {
  it('an unreachable oracle DENIES with heat-denied, and the SDK is never constructed', async () => {
    const dummy = {} as never;
    const err = (await launchToken(dummy, dummy, cfg()).catch((e) => e)) as LaunchError;

    expect(err).toBeInstanceOf(LaunchError);
    expect(err.code).toBe('heat-denied');
    // Nothing downstream ran. If the SDK had been constructed, the denial would be
    // sitting somewhere it could be confused with a submit failure.
    expect(sdkCtor).not.toHaveBeenCalled();
  });

  it('the denial is PRE-BROADCAST — the UI may safely offer a retry', async () => {
    const dummy = {} as never;
    const err = (await launchToken(dummy, dummy, cfg()).catch((e) => e)) as LaunchError;
    expect(err.broadcast).toBe(false);
    expect(err.txHash).toBeUndefined();
  });

  it('carries the gate’s own reason, so the wallet is told what the door read', async () => {
    const dummy = {} as never;
    const err = (await launchToken(dummy, dummy, cfg()).catch((e) => e)) as LaunchError;
    expect(err.cause).toBeInstanceOf(HeatGateDenied);
    expect((err.cause as HeatGateDenied).decision.state).toBe('STALE');
    expect((err.cause as HeatGateDenied).decision.address).toBe(CREATOR);
    // "Could not ask" is not "you scored nothing".
    expect((err.cause as HeatGateDenied).decision.degrees).toBeNull();
  });

  it('reads the CREATOR’s address, not some other party to the launch', async () => {
    const dummy = {} as never;
    const err = (await launchToken(dummy, dummy, cfg()).catch((e) => e)) as LaunchError;
    expect((err.cause as HeatGateDenied).audit.address).toBe(CREATOR);
  });

  it('the integrator guard still fires FIRST — the cheap local check precedes a network read', async () => {
    const bad = { ...cfg(), integrator: '0x0000000000000000000000000000000000000000' as Address };
    const dummy = {} as never;
    const err = (await launchToken(dummy, dummy, bad).catch((e) => e)) as LaunchError;
    expect(err.code).toBe('invalid-integrator');
  });

  it('supply is unchanged by the gate — a denial mutates nothing', async () => {
    const c = cfg();
    const before = c.initialSupply;
    await launchToken({} as never, {} as never, c).catch(() => undefined);
    expect(c.initialSupply).toBe(before);
    expect(before).toBe(parseEther('1000000'));
  });
});
