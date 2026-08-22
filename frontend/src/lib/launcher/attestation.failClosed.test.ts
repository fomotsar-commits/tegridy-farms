// THE ATTESTATION MUST NOT WRITE A FABRICATED ZERO TO MAINNET.
//
// The live `/launch` button re-collects the token's facts with NO LockResolver, so
// `collector.DEFAULT_LOCK_RESOLVER` answers `readable: false` having touched no chain.
// The two LP-lock gate checks then "fail" on a locker nobody queried, the tier
// collapses to 'none', and `encodeFactSheetData` writes `tier = 0` and
// `liquidityUnlockAt = 0` — one screen after the wizard rendered the same launch as
// FLAGSHIP. Permanently, publicly, about somebody else's token.
//
// Two schema columns carry the defect, and neither has room for a third value:
//   uint8  tier               0 = "meets no bar" AND "was never evaluated"
//   uint64 liquidityUnlockAt  0 = "no lock"      AND "the locker was never queried"
//
// So the invariant these tests pin is NOT a message and NOT a tier value. It is:
// bytes only ever leave this module when every column in them was read.

import { describe, it, expect, vi } from 'vitest';

// `attestFactSheet` carries an internal launcher gate (INFO#17); hold it open so these
// tests are exercising the REFUSAL, not that unrelated guard.
const gate = vi.hoisted(() => ({ enabled: true }));
vi.mock('./config', () => ({ isLauncherEnabled: () => gate.enabled }));

import { decodeAbiParameters, parseAbiParameters, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { collectTokenFacts, type ChainReader } from './collector';
import { buildFactSheet, runGate, defaultGateConfig, type RawTokenFacts } from './gate';
import {
  attestFactSheet,
  attestationRefusal,
  AttestationRefused,
  canonicalDisclosuresJson,
  disclosuresDigest,
  encodeFactSheetData,
} from './attestation';
import { FACT_SHEET_EAS_SCHEMA, TIER_CODE, type LaunchFactSheet } from './factSheet';
import { DOPPLER_MAINNET } from './doppler.constants';

const NOW = 1_800_000_000;
const DAY = 86_400;
const IMPL = DOPPLER_MAINNET.support.dopplerErc20V1Impl;
const TOKEN = '0xabc0000000000000000000000000000000000abc' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/** The Solady LibClone runtime layout Doppler actually deploys. */
function cloneCode(impl: Address): Hex {
  return `0x3d3d3d3d363d3d37363d73${impl.slice(2).toLowerCase()}5af43d3d93803e602a57fd5bf3` as Hex;
}

/** A clean, renounced, zero-float Doppler clone; named methods throw like a 429 would. */
function reader(failing: readonly string[] = [], code: Hex | undefined = cloneCode(IMPL)): ChainReader {
  return {
    async getCode() {
      return code;
    },
    async readToken<T>(_addr: Address, fn: string): Promise<T> {
      if (failing.includes(fn)) throw new Error('HTTP 429 Too Many Requests');
      const map: Record<string, unknown> = {
        name: 'Randy',
        symbol: 'RANDY',
        totalSupply: 1_000_000_000n,
        owner: ZERO,
        isBalanceLimitActive: false,
        vestedTotalAmount: 0n,
      };
      if (!(fn in map)) throw new Error(`execution reverted: no ${fn}()`);
      return map[fn] as T;
    },
  };
}

/** A locker that WAS queried and reports a real two-year lock. */
const lockedTwoYears = async () => ({
  locked: true,
  locker: DOPPLER_MAINNET.support.streamableFeesLocker,
  unlockAt: NOW + 730 * DAY,
  readable: true,
});

/** Decode the flat schema columns back out of an encoded attestation payload. */
function columns(sheet: LaunchFactSheet) {
  const d = decodeAbiParameters(parseAbiParameters(FACT_SHEET_EAS_SCHEMA), encodeFactSheetData(sheet));
  return { tier: d[4] as number, liquidityUnlockAt: d[7] as bigint };
}

// ---------------------------------------------------------------------------
// 1. The live path: the wizard's FLAGSHIP vs. what the button would have written
// ---------------------------------------------------------------------------

describe('the launch-time attest path never writes an undecided tier', () => {
  it('the SAME token is flagship when the locker is read — so the collapse is not the token', async () => {
    const facts = await collectTokenFacts(reader(), TOKEN, { now: NOW, lockResolver: lockedTwoYears });
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
    expect(sheet.tier).toBe('flagship');
    expect(attestationRefusal(sheet)).toBeNull();
    // And it encodes the tier the gate actually reached.
    expect(columns(sheet).tier).toBe(TIER_CODE.flagship);
  });

  it('with NO lockResolver — exactly what onAttest does — the tier is not decided', async () => {
    const facts = await collectTokenFacts(reader(), TOKEN, { now: NOW });
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
    // The gate still closes conservatively; that part is correct and unchanged.
    expect(sheet.tier).toBe('none');
    // But it is an artefact of an unqueried locker, not a finding about the token.
    expect(sheet.tierDeterminate).toBe(false);
    expect(sheet.gateChecks.find((c) => c.id === 'lp-lock-floor')?.readable).toBe(false);
    expect(sheet.gateChecks.find((c) => c.id === 'lp-lock-12mo')?.readable).toBe(false);
  });

  it('REFUSES to encode it, rather than writing tier 0 to mainnet', async () => {
    const facts = await collectTokenFacts(reader(), TOKEN, { now: NOW });
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
    expect(attestationRefusal(sheet)).not.toBeNull();
    expect(() => encodeFactSheetData(sheet)).toThrow(AttestationRefused);
  });

  it('refuses BEFORE any client interaction — nothing is simulated, nothing is signed', async () => {
    gate.enabled = true;
    const facts = await collectTokenFacts(reader(), TOKEN, { now: NOW });
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));

    let simulated = false;
    let wrote = false;
    const publicClient = {
      simulateContract: async () => {
        simulated = true;
        return { request: {}, result: '0x' as Hex };
      },
    } as unknown as PublicClient;
    const walletClient = {
      account: { address: TOKEN },
      writeContract: async () => {
        wrote = true;
        return '0x' as Hex;
      },
    } as unknown as WalletClient;

    await expect(attestFactSheet(walletClient, publicClient, sheet)).rejects.toBeInstanceOf(AttestationRefused);
    expect(simulated).toBe(false);
    expect(wrote).toBe(false);
  });

  it('THE INVARIANT: no column that survives encoding is a fabricated zero', async () => {
    // Every shape the collector can produce on this rail, encoded or refused. The
    // assertion is not about which tier — it is that a zero in either lossy column
    // can only ever mean the thing it was READ to mean.
    const shapes: { label: string; facts: RawTokenFacts }[] = [
      { label: 'no lock resolver (the live button)', facts: await collectTokenFacts(reader(), TOKEN, { now: NOW }) },
      { label: 'locker read, real lock', facts: await collectTokenFacts(reader(), TOKEN, { now: NOW, lockResolver: lockedTwoYears }) },
      {
        label: 'locker read, genuinely unlocked',
        facts: await collectTokenFacts(reader(), TOKEN, {
          now: NOW,
          lockResolver: async () => ({ locked: false, locker: null, unlockAt: null, readable: true }),
        }),
      },
      {
        label: 'owner() 429',
        facts: await collectTokenFacts(reader(['owner']), TOKEN, { now: NOW, lockResolver: lockedTwoYears }),
      },
      {
        label: 'vestedTotalAmount() 429',
        facts: await collectTokenFacts(reader(['vestedTotalAmount']), TOKEN, { now: NOW, lockResolver: lockedTwoYears }),
      },
      {
        label: 'unrecognised template',
        facts: await collectTokenFacts(reader([], '0x6080604052' as Hex), TOKEN, { now: NOW, lockResolver: lockedTwoYears }),
      },
    ];

    for (const { label, facts } of shapes) {
      const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
      if (attestationRefusal(sheet) !== null) {
        expect(() => encodeFactSheetData(sheet), label).toThrow(AttestationRefused);
        continue;
      }
      const { tier, liquidityUnlockAt } = columns(sheet);
      // A zero tier byte is only ever a tier the gate DECIDED was none.
      if (tier === TIER_CODE.none) expect(sheet.tierDeterminate, label).not.toBe(false);
      // A zero unlock time is only ever a locker that answered.
      if (liquidityUnlockAt === 0n) expect(sheet.liquidity.readable, label).not.toBe(false);
      // And the encoded tier is always the tier the sheet states.
      expect(tier, label).toBe(TIER_CODE[sheet.tier]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. `tierDeterminate` is established by counterfactual, not by pessimism
// ---------------------------------------------------------------------------

describe('an unread input only undoes the tier when it would have CHANGED the tier', () => {
  it('a proven disqualifier still yields a decided "none" even with the locker unread', async () => {
    // Unrecognised template => every dangerous power is reported present, which is a
    // determinate listable failure. The unread locker cannot rescue it, so 'none' is
    // an answer and must stay attestable — refusing here would be the opposite bug.
    const facts = await collectTokenFacts(reader([], '0x6080604052' as Hex), TOKEN, { now: NOW });
    const { tier, tierDeterminate } = runGate({ ...facts }, defaultGateConfig(NOW));
    expect(tier).toBe('none');
    expect(tierDeterminate).toBe(true);
  });

  it('an unread owner() undoes a FLAGSHIP GRANT, not just a downgrade', async () => {
    // The fallback direction here is inverted: owner -> null -> "renounced" -> the
    // flagship admin bar PASSES on a call that never landed. A fabricated pass is the
    // same defect as a fabricated fail.
    const facts = await collectTokenFacts(reader(['owner']), TOKEN, { now: NOW, lockResolver: lockedTwoYears });
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
    expect(facts.unreadFields).toContain('owner');
    expect(sheet.tier).toBe('flagship'); // what the fallback produces
    expect(sheet.gateChecks.find((c) => c.id === 'admin-renounced-or-timelock')?.readable).toBe(false);
    expect(sheet.tierDeterminate).toBe(false);
    expect(() => encodeFactSheetData(sheet)).toThrow(AttestationRefused);
  });

  it('a fully-read clean launch is NOT refused (the fix must not gag real answers)', async () => {
    const facts = await collectTokenFacts(reader(), TOKEN, { now: NOW, lockResolver: lockedTwoYears });
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
    expect(sheet.tierDeterminate).toBeUndefined();
    expect(() => encodeFactSheetData(sheet)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. safeRead without the unread Set: a 429 must not be readable as a real zero
// ---------------------------------------------------------------------------

describe('every collector read is distinguishable from the value it falls back to', () => {
  it('a failed vestedTotalAmount() is recorded, and the 0 bps it produces is not a finding', async () => {
    const facts = await collectTokenFacts(reader(['vestedTotalAmount']), TOKEN, { now: NOW, lockResolver: lockedTwoYears });
    expect(facts.unreadFields).toContain('vestedTotalAmount');
    expect(facts.teamAllocationBps).toBe(0); // the fallback, unchanged
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
    // Both checks that read that zero say so, instead of reporting a clean float.
    expect(sheet.gateChecks.find((c) => c.id === 'team-allocation-vested')?.readable).toBe(false);
    expect(sheet.gateChecks.find((c) => c.id === 'insider-float-cap')?.readable).toBe(false);
    expect(() => encodeFactSheetData(sheet)).toThrow(AttestationRefused);
  });

  it('vestedTotalAmount() is recorded unread when the branch never runs at all', async () => {
    // Unrecognised template: the call is not merely failed, it is never attempted —
    // the same absence, and it must not look like a read zero either.
    const facts = await collectTokenFacts(reader([], '0x6080604052' as Hex), TOKEN, { now: NOW });
    expect(facts.unreadFields).toContain('vestedTotalAmount');
    expect(facts.unreadFields).toContain('isBalanceLimitActive');
  });

  it('a failed isBalanceLimitActive() makes no claim about the wallet cap', async () => {
    const facts = await collectTokenFacts(reader(['isBalanceLimitActive']), TOKEN, { now: NOW, lockResolver: lockedTwoYears });
    expect(facts.unreadFields).toContain('isBalanceLimitActive');
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
    const cap = sheet.residualPowers.find((p) => p.power === 'balance-limit')!;
    expect(cap.readable).toBe(false);
    // The invariant is the absence of an assertion, either way — not a phrasing.
    expect(cap.disclosure).not.toMatch(/no maximum wallet balance is enforced/i);
    expect(cap.disclosure).not.toMatch(/a maximum wallet balance is enforced/i);
  });

  it('the unread cap changes the ON-CHAIN digest — an unknown never hashes as a read false', async () => {
    const read = buildFactSheet(
      await collectTokenFacts(reader(), TOKEN, { now: NOW, lockResolver: lockedTwoYears }),
      defaultGateConfig(NOW),
    );
    const unread = buildFactSheet(
      await collectTokenFacts(reader(['isBalanceLimitActive']), TOKEN, { now: NOW, lockResolver: lockedTwoYears }),
      defaultGateConfig(NOW),
    );
    expect(read.residualPowers.find((p) => p.power === 'balance-limit')!.present).toBe(
      unread.residualPowers.find((p) => p.power === 'balance-limit')!.present,
    );
    // Same `present` value, different meaning — so the digest must differ.
    expect(disclosuresDigest(unread)).not.toBe(disclosuresDigest(read));
  });
});

// ---------------------------------------------------------------------------
// 4. `vesting: []` was an unknown published as a value
// ---------------------------------------------------------------------------

describe('an unenumerated vesting list is never attested as "no vesting schedules"', () => {
  it('the collector cannot enumerate schedules, and says so', async () => {
    const facts = await collectTokenFacts(reader(), TOKEN, { now: NOW, lockResolver: lockedTwoYears });
    expect(facts.vesting).toEqual([]);
    expect(facts.vestingReadable).toBe(false);
    expect(buildFactSheet(facts, defaultGateConfig(NOW)).vestingReadable).toBe(false);
  });

  it('THE INVARIANT: "none found" and "never looked" do not hash to the same 32 bytes', async () => {
    const collected = buildFactSheet(
      await collectTokenFacts(reader(), TOKEN, { now: NOW, lockResolver: lockedTwoYears }),
      defaultGateConfig(NOW),
    );
    // A caller that genuinely enumerated and found none — identical in every other way.
    const enumerated = buildFactSheet(
      { ...(await collectTokenFacts(reader(), TOKEN, { now: NOW, lockResolver: lockedTwoYears })), vestingReadable: undefined },
      defaultGateConfig(NOW),
    );
    expect(collected.vesting).toEqual(enumerated.vesting);
    expect(disclosuresDigest(collected)).not.toBe(disclosuresDigest(enumerated));
  });

  it('a caller that DID enumerate is untouched, and adds no marker to the digest input', () => {
    const facts: RawTokenFacts = {
      token: TOKEN,
      chainId: 1,
      name: 'Projected',
      symbol: 'PROJ',
      totalSupply: 1_000_000_000n,
      tokenFactory: DOPPLER_MAINNET.modules.dopplerErc20V1Factory.address,
      templateCodehash: null,
      powers: { mint: false, pause: false, blacklist: false, feeOnTransfer: false, upgrade: false, balanceLimit: false },
      owner: ZERO,
      ownerRenounced: true,
      ownerIsTimelock: false,
      liquidity: { locked: true, locker: ZERO, unlockAt: NOW + 730 * DAY },
      feeConstitution: [],
      vesting: [],
      teamAllocationBps: 0,
      teamAllocationVestedBps: 0,
      observedAt: NOW,
    };
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
    expect(sheet.vestingReadable).toBeUndefined();
    expect(sheet.tierDeterminate).toBeUndefined();
    expect(() => encodeFactSheetData(sheet)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Digest stability — the fix must not orphan an already-written attestation
// ---------------------------------------------------------------------------

describe('the third states cost nothing when everything was read', () => {
  it('an all-read sheet carries none of the new keys in its digest input', () => {
    const sheet = buildFactSheet(
      {
        token: TOKEN,
        chainId: 1,
        name: 'Randy',
        symbol: 'RANDY',
        totalSupply: 1_000_000_000n,
        tokenFactory: DOPPLER_MAINNET.modules.dopplerErc20V1Factory.address,
        templateCodehash: null,
        powers: { mint: false, pause: false, blacklist: false, feeOnTransfer: false, upgrade: false, balanceLimit: false },
        owner: ZERO,
        ownerRenounced: true,
        ownerIsTimelock: false,
        liquidity: { locked: true, locker: ZERO, unlockAt: NOW + 730 * DAY, readable: true },
        feeConstitution: [],
        vesting: [],
        teamAllocationBps: 0,
        teamAllocationVestedBps: 0,
        observedAt: NOW,
      },
      defaultGateConfig(NOW),
    );
    const json = canonicalDisclosuresJson(sheet);
    // Absent, not `true` — that is what makes the pre-existing digest reproducible.
    // (`liquidity.readable` is deliberately excluded: it predates this change and is
    // already always emitted, so it is part of the baseline, not part of the drift.)
    expect(json).not.toContain('tierDeterminate');
    expect(json).not.toContain('vestingReadable');
    expect(sheet.gateChecks.every((c) => c.readable === undefined)).toBe(true);
    expect(sheet.residualPowers.every((p) => p.readable === undefined)).toBe(true);
  });
});
