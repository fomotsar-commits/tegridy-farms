import { describe, it, expect } from 'vitest';
import { buildFactSheet, defaultGateConfig, runGate, type RawTokenFacts } from './gate';
import { DOPPLER_MAINNET } from './doppler.constants';

const NOW = 1_800_000_000; // fixed clock for determinism
const DAY = 86_400;

/** A pristine Doppler flagship launch: safe template, all powers clear, LP locked 2y, admin renounced, no team float. */
function cleanFlagship(overrides: Partial<RawTokenFacts> = {}): RawTokenFacts {
  return {
    token: '0x1111111111111111111111111111111111111111',
    chainId: 1,
    name: 'Good Token',
    symbol: 'GOOD',
    totalSupply: 1_000_000_000n,
    tokenFactory: DOPPLER_MAINNET.modules.dopplerErc20V1Factory.address,
    templateCodehash: '0xabc0000000000000000000000000000000000000000000000000000000000000',
    powers: { mint: false, pause: false, blacklist: false, feeOnTransfer: false, upgrade: false, balanceLimit: false },
    owner: '0x0000000000000000000000000000000000000000',
    ownerRenounced: true,
    ownerIsTimelock: false,
    liquidity: { locked: true, locker: DOPPLER_MAINNET.support.streamableFeesLocker, unlockAt: NOW + 730 * DAY },
    feeConstitution: [
      { recipient: 'creator', shareBps: 6000, role: 'creator' },
      { recipient: 'Tegridy stakers', shareBps: 1000, role: 'protocol-stakers' },
      { recipient: 'Tegridy POL', shareBps: 1000, role: 'protocol-pol' },
      { recipient: 'Doppler', shareBps: 500, role: 'doppler' },
    ],
    vesting: [],
    teamAllocationBps: 0,
    teamAllocationVestedBps: 0,
    observedAt: NOW,
    ...overrides,
  };
}

const cfg = defaultGateConfig(NOW);

describe('runGate — tier determination', () => {
  it('grants flagship to a pristine Doppler launch', () => {
    const { tier, checks } = runGate(cleanFlagship(), cfg);
    expect(tier).toBe('flagship');
    expect(checks.every((c) => c.passed)).toBe(true);
  });

  it('drops to listable when LP lock is below the 12-month flagship floor', () => {
    const { tier, checks } = runGate(cleanFlagship({ liquidity: { locked: true, locker: null, unlockAt: NOW + 45 * DAY } }), cfg);
    expect(tier).toBe('listable');
    // the listable lock floor (30d) still passes; only the flagship 12mo check fails
    expect(checks.find((c) => c.id === 'lp-lock-floor')!.passed).toBe(true);
    expect(checks.find((c) => c.id === 'lp-lock-12mo')!.passed).toBe(false);
  });

  it('drops to listable when the owner is neither renounced nor a timelock', () => {
    const { tier } = runGate(cleanFlagship({ ownerRenounced: false, owner: '0x00000000000000000000000000000000000000ff' }), cfg);
    expect(tier).toBe('listable');
  });

  it('accepts a timelock owner for flagship', () => {
    const { tier } = runGate(cleanFlagship({ ownerRenounced: false, ownerIsTimelock: true }), cfg);
    expect(tier).toBe('flagship');
  });

  it('drops to listable when insider float exceeds the flagship cap but is fully vested', () => {
    const { tier, checks } = runGate(cleanFlagship({ teamAllocationBps: 3000, teamAllocationVestedBps: 3000 }), cfg);
    expect(tier).toBe('listable');
    expect(checks.find((c) => c.id === 'insider-float-cap')!.passed).toBe(false);
    expect(checks.find((c) => c.id === 'team-allocation-vested')!.passed).toBe(true);
  });
});

describe('runGate — listable disqualifiers force tier none', () => {
  it('mint power fails the gate entirely', () => {
    const { tier, checks } = runGate(cleanFlagship({ powers: { ...cleanFlagship().powers, mint: true } }), cfg);
    expect(tier).toBe('none');
    expect(checks.find((c) => c.id === 'no-mint')!.passed).toBe(false);
  });

  it('fee-on-transfer fails the gate', () => {
    const { tier } = runGate(cleanFlagship({ powers: { ...cleanFlagship().powers, feeOnTransfer: true } }), cfg);
    expect(tier).toBe('none');
  });

  it('blacklist power fails the gate', () => {
    const { tier } = runGate(cleanFlagship({ powers: { ...cleanFlagship().powers, blacklist: true } }), cfg);
    expect(tier).toBe('none');
  });

  it('upgradeable logic fails the gate', () => {
    const { tier } = runGate(cleanFlagship({ powers: { ...cleanFlagship().powers, upgrade: true } }), cfg);
    expect(tier).toBe('none');
  });

  it('unlocked liquidity fails the gate', () => {
    const { tier } = runGate(cleanFlagship({ liquidity: { locked: false, locker: null, unlockAt: null } }), cfg);
    expect(tier).toBe('none');
  });

  it('unknown (non-Doppler) template fails the template check', () => {
    const { tier, checks } = runGate(cleanFlagship({ tokenFactory: '0xdead00000000000000000000000000000000dead' }), cfg);
    expect(tier).toBe('none');
    expect(checks.find((c) => c.id === 'template-known-safe')!.passed).toBe(false);
  });

  it('partially-vested team allocation fails the listable vesting check', () => {
    const { tier, checks } = runGate(cleanFlagship({ teamAllocationBps: 1000, teamAllocationVestedBps: 400 }), cfg);
    expect(tier).toBe('none');
    expect(checks.find((c) => c.id === 'team-allocation-vested')!.passed).toBe(false);
  });
});

describe('runGate — adversarial edge cases', () => {
  it('treats a lock that expires exactly at the floor as passing (>=)', () => {
    const { checks } = runGate(cleanFlagship({ liquidity: { locked: true, locker: null, unlockAt: NOW + 30 * DAY } }), cfg);
    expect(checks.find((c) => c.id === 'lp-lock-floor')!.passed).toBe(true);
  });

  it('treats a lock one second under the floor as failing', () => {
    const { tier } = runGate(cleanFlagship({ liquidity: { locked: true, locker: null, unlockAt: NOW + 30 * DAY - 1 } }), cfg);
    expect(tier).toBe('none'); // fails listable lock floor
  });

  it('a "locked" flag with a null unlockAt is treated as no lock (cannot verify duration)', () => {
    const { tier } = runGate(cleanFlagship({ liquidity: { locked: true, locker: null, unlockAt: null } }), cfg);
    expect(tier).toBe('none');
  });

  it('an already-expired lock does not count', () => {
    const { tier } = runGate(cleanFlagship({ liquidity: { locked: true, locker: null, unlockAt: NOW - 1 } }), cfg);
    expect(tier).toBe('none');
  });
});

describe('buildFactSheet — disclosure assembly', () => {
  it('produces neutral residual-power disclosures and a matching tier', () => {
    const sheet = buildFactSheet(cleanFlagship(), cfg);
    expect(sheet.tier).toBe('flagship');
    expect(sheet.knownSafeTemplate).toBe(true);
    const mint = sheet.residualPowers.find((p) => p.power === 'mint')!;
    expect(mint.present).toBe(false);
    expect(mint.disclosure).toContain('no post-launch minting');
    // never asserts safety — even a flagship sheet only states facts
    const serialized = JSON.stringify(sheet, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase();
    expect(serialized).not.toContain('guaranteed');
    expect(serialized).not.toContain('safe to buy');
  });

  it('discloses a mint power in plain buyer-facing language when present', () => {
    const sheet = buildFactSheet(cleanFlagship({ powers: { ...cleanFlagship().powers, mint: true } }), cfg);
    expect(sheet.tier).toBe('none');
    const mint = sheet.residualPowers.find((p) => p.power === 'mint')!;
    expect(mint.present).toBe(true);
    expect(mint.disclosure).toContain('diluting holders');
  });

  it('reports LP lock remaining days in the liquidity note', () => {
    const sheet = buildFactSheet(cleanFlagship(), cfg);
    expect(sheet.liquidity.locked).toBe(true);
    expect(sheet.liquidity.note).toContain('730d remaining');
  });

  it('carries the fee constitution through unchanged', () => {
    const sheet = buildFactSheet(cleanFlagship(), cfg);
    const total = sheet.feeConstitution.reduce((n, l) => n + l.shareBps, 0);
    expect(total).toBe(8500); // 60/10/10/5 of the fee split, in bps
  });
});
