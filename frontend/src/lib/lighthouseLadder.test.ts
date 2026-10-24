// The ladder card's honesty math. Every rule below exists because rendering
// the naive number would lie — and three of them are lessons paid for once
// already on the plain-pool card shipped hours earlier.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isC1UnsafeLadder,
  C1_UNSAFE_LADDER_POOLS,
  deriveLadder,
  boostBpsFor,
  boostLabel,
  projectedRawPerSec,
  penaltyOn,
  penaltyPct,
  penaltyShare,
  lockRemaining,
  MAX_LOCK_SECS,
  MIN_LOCK_SECS,
  MIN_STAKE_RAW,
  MAX_PENALTY_BPS,
  LIVE_LADDER_EXIT_BPS,
  LIVE_LADDER_EXIT_SCHEDULE,
  type LadderReads,
} from './lighthouseLadder';

const NOW = 1_756_600_000n;
const E18 = 10n ** 18n;

function reads(over: Partial<LadderReads> = {}): LadderReads {
  return {
    totalStakedRaw: 200n * E18,
    totalBoostedRaw: 500n * E18, // someone locked long
    surplusRaw: 60n * E18,
    rewardRateRaw: 1_000n,
    periodFinishSecs: NOW + 86_400n * 30n,
    rewardsDurationSecs: 86_400n * 60n,
    ...over,
  };
}

describe('the ladder', () => {
  it("is TOWELI's ladder exactly: 0.40x at seven days, 4.00x at four years", () => {
    expect(boostLabel(MIN_LOCK_SECS)).toBe('0.40x');
    expect(boostLabel(MAX_LOCK_SECS)).toBe('4.00x');
    expect(boostLabel(MAX_LOCK_SECS * 3n)).toBe('4.00x'); // clamped
    expect(boostLabel(0n)).toBe('0.40x'); // below the floor reads as the floor
  });

  it('matches the contract at the exact rungs the deploy script asserts', () => {
    expect(boostBpsFor(MIN_LOCK_SECS)).toBe(4_000n);
    expect(boostBpsFor(MAX_LOCK_SECS)).toBe(40_000n);
    // A ten-fold spread — the incentive that a no-lock rung would flatten.
    expect(boostBpsFor(MAX_LOCK_SECS) / boostBpsFor(MIN_LOCK_SECS)).toBe(10n);
  });
});

describe('deriveLadder', () => {
  it('reads the vault from the contract instead of re-deriving it', () => {
    // rewardSurplus() IS balanceOf - totalSupply on-chain; the UI must not
    // compute a second, drifting version of the number that decides payouts.
    expect(deriveLadder(reads(), NOW).vaultRaw).toBe(60n * E18);
  });

  it('separates NEVER FUNDED from "the period ended"', () => {
    // The plain-pool card collapsed these and then asserted a "last notify"
    // that had never happened. A fresh pool is fresh, not expired.
    const fresh = deriveLadder(reads({ periodFinishSecs: 0n, rewardRateRaw: 0n }), NOW);
    expect(fresh.everFunded).toBe(false);
    expect(fresh.periodActive).toBe(false);
    expect(fresh.payingNowRawPerSec).toBe(0n);

    const ended = deriveLadder(reads({ periodFinishSecs: NOW - 1n }), NOW);
    expect(ended.everFunded).toBe(true);
    expect(ended.periodActive).toBe(false);
    expect(ended.payingNowRawPerSec).toBe(0n); // a real, labeled zero
    expect(ended.configuredRawPerSec).toBe(1_000n); // still stated as configuration
  });

  it('an unreadable figure is an outage — every derived number goes null, never 0', () => {
    const v = deriveLadder(reads({ surplusRaw: null }), NOW);
    expect(v.coreKnown).toBe(false);
    expect(v.vaultRaw).toBeNull();
    const v2 = deriveLadder(reads({ periodFinishSecs: null }), NOW);
    expect(v2.payingNowRawPerSec).toBeNull();
    expect(v2.runwaySecs).toBeNull();
  });

  it('runway is exact seconds to periodFinish, and 0 once past', () => {
    expect(deriveLadder(reads(), NOW).runwaySecs).toBe(86_400n * 30n);
    expect(deriveLadder(reads({ periodFinishSecs: NOW - 5n }), NOW).runwaySecs).toBe(0n);
  });
});

describe('what a staker would actually earn', () => {
  it('dilutes the projection by the weight the staker themself adds', () => {
    // The honest trap: quoting `rate * myShare / existingTotal` overstates,
    // because staking CHANGES the denominator. The projection must include
    // the new weight in the total it divides by.
    const v = deriveLadder(reads({ totalBoostedRaw: 0n }), NOW);
    const solo = projectedRawPerSec(v, 0n, 100n * E18);
    expect(solo).toBe(1_000n); // sole staker takes the whole rate

    const half = projectedRawPerSec(v, 100n * E18, 100n * E18);
    expect(half).toBe(500n); // equal weight, half the rate — not the whole of it
  });

  it('projects nothing when the pool is not paying, and null when unreadable', () => {
    const ended = deriveLadder(reads({ periodFinishSecs: NOW - 1n }), NOW);
    expect(projectedRawPerSec(ended, 100n * E18, 100n * E18)).toBe(0n);
    const outage = deriveLadder(reads({ periodFinishSecs: null }), NOW);
    expect(projectedRawPerSec(outage, 100n * E18, 100n * E18)).toBeNull();
  });

  it('a longer lock earns strictly more of the same pool — but boost is RELATIVE, not a multiplier on your own yield', () => {
    const v = deriveLadder(reads({ totalBoostedRaw: 0n }), NOW);
    const amount = 100n * E18;
    const existing = 300n * E18;
    const shortest = projectedRawPerSec(v, existing, (amount * boostBpsFor(MIN_LOCK_SECS)) / 10_000n)!;
    const locked = projectedRawPerSec(v, existing, (amount * boostBpsFor(MAX_LOCK_SECS)) / 10_000n)!;
    expect(locked > shortest).toBe(true);
    // And NOT 4x: 4.00x weight against a pool that already holds 300e18 of
    // weight yields far less than ten times the income, because the staker's
    // own weight enters the denominator too. A UI that promised "10x rewards"
    // would be lying; what the ladder buys is ten times the SHARE.
    expect(locked < shortest * 10n).toBe(true);
  });

  it('a SOLO staker earns the whole rate whatever they locked — boost only sorts stakers against each other', () => {
    const v = deriveLadder(reads({ totalBoostedRaw: 0n }), NOW);
    const amount = 100n * E18;
    const soloShortest = projectedRawPerSec(v, 0n, (amount * boostBpsFor(MIN_LOCK_SECS)) / 10_000n);
    const soloMaxLock = projectedRawPerSec(v, 0n, (amount * boostBpsFor(MAX_LOCK_SECS)) / 10_000n);
    expect(soloShortest).toBe(1_000n);
    expect(soloMaxLock).toBe(1_000n);
    // The honest consequence for today: every island pool is empty, so the
    // FIRST staker gains nothing from locking. The card must not imply
    // otherwise while it is the only position in the pool.
  });
});

describe('the dust floor', () => {
  // A DRIFT GUARD, not arithmetic. This constant is a copy of the contract's
  // `MIN_STAKE` (LighthouseLadder.sol), and a copy that silently disagrees with
  // its original is worse than no copy at all: the panel would enable the stake
  // button for an amount the chain then refuses, charging the user gas to learn
  // it. If MIN_STAKE ever moves in Solidity, this is what should red.
  it('mirrors the contract constant exactly', () => {
    expect(MIN_STAKE_RAW).toBe(100n * 10n ** 18n);
  });

  // RAW units, deliberately not scaled by the pool's own decimals — the
  // contract's floor is a plain constant, which is why the deploy script
  // refuses any staking token that is not 18-decimal.
  it('is a raw-unit quantity, so it reads as 100 whole tokens at 18 decimals', () => {
    expect(MIN_STAKE_RAW / E18).toBe(100n);
  });

  // Three wei is the amount that took every empty interval on the pre-fix
  // contract: `3 * 4_000 / 10_000` rounds to a boost weight of exactly 1, and
  // 1 as the accumulator's divisor pays the whole emission. Pinned here so the
  // panel can never again present it as a stakeable amount.
  it('refuses the three wei that used to capture the whole emission', () => {
    expect(3n < MIN_STAKE_RAW).toBe(true);
  });
});

describe('the exit costs', () => {
  // Owner, 2026-10-18: the room ladders keep the ladder's law (the time left over four
  // years, capped at 75%). The card never computes that: it reads each position's quote
  // from the pool. penaltyOn is for the six FLAT ladders live today, which answer a rate.
  it('prices a flat exit at the rate the pool answers (the live six: 25%)', () => {
    expect(penaltyOn(1_000n * E18, 2_500n)).toBe(250n * E18);
    expect(penaltyOn(1_000n * E18, 7_500n)).toBe(750n * E18);
  });

  it('says a quoted penalty as a share of the position, floored, never rounded up', () => {
    expect(penaltyShare(250n * E18, 1_000n * E18)).toBe('25%');
    // A seven-day lock left at once under the ladder's law: 7/1460 of principal.
    expect(penaltyShare((1_000n * E18 * 7n) / 1460n, 1_000n * E18)).toBe('0.47%');
    expect(penaltyShare(0n, 1_000n * E18)).toBe('0%');
    expect(penaltyShare(1n, 0n)).toBe('0%');
  });

  it('says the penalty as a plain percentage, no trailing zeros', () => {
    expect(penaltyPct(7_500n)).toBe('75%');
    expect(penaltyPct(2_500n)).toBe('25%');
    expect(penaltyPct(1_250n)).toBe('12.5%');
    expect(penaltyPct(0n)).toBe('0%');
  });

  it('is the cap LighthouseLadder.sol declares: the same schedule as the Solana ladder', () => {
    // Both ladders charge veYFI's time-left schedule capped at 75% since 2026-10-18 (the
    // ladder's law). Read from the Solidity so the cap here cannot drift from the build.
    const here = dirname(fileURLToPath(import.meta.url));
    const sol = readFileSync(join(here, '..', '..', '..', 'contracts', 'src', 'LighthouseLadder.sol'), 'utf8');
    const m = /uint256 public constant MAX_EARLY_EXIT_PENALTY_BPS = ([\d_]+);/.exec(sol);
    expect(m, 'MAX_EARLY_EXIT_PENALTY_BPS not found in LighthouseLadder.sol — re-anchor this test').not.toBeNull();
    expect(MAX_PENALTY_BPS).toBe(BigInt(m![1]!.replace(/_/g, '')));
    expect(sol).not.toMatch(/constant EARLY_EXIT_PENALTY_BPS/);
    expect(sol).toContain('function penaltyFor(uint256 amount, uint64 lockEnd) public view returns (uint256)');
  });

  it('the live switch is one of the two shapes that ever shipped, and the card never uses it', () => {
    // Flat 2_500n until the owner redeploys (docs/LADDER_EXIT_75_REDEPLOY.md), then the
    // time-left schedule capped at MAX_PENALTY_BPS. One switch, two fields, no third shape.
    expect(['flat', 'time-left']).toContain(LIVE_LADDER_EXIT_SCHEDULE);
    if (LIVE_LADDER_EXIT_SCHEDULE === 'flat') expect(LIVE_LADDER_EXIT_BPS).toBe(2_500n);
    else expect(LIVE_LADDER_EXIT_BPS).toBe(MAX_PENALTY_BPS);
    const here = dirname(fileURLToPath(import.meta.url));
    const card = readFileSync(join(here, '..', 'components', 'bungalow', 'EvmLadderPoolLive.tsx'), 'utf8');
    expect(card).not.toContain('LIVE_LADDER_EXIT');
    expect(card).toContain("functionName: 'EARLY_EXIT_PENALTY_BPS'");
    expect(card).toContain("functionName: 'MAX_EARLY_EXIT_PENALTY_BPS'");
    expect(card).toContain("functionName: 'penaltyFor'");
  });

  it('counts down a lock and stops at zero rather than going negative', () => {
    expect(lockRemaining(NOW + 100n, NOW)).toBe(100n);
    expect(lockRemaining(NOW - 100n, NOW)).toBe(0n);
  });
});

// ─── C1: the deposit freeze ─────────────────────────────────────────────────
//
// A pool on C1_UNSAFE_LADDER_POOLS takes no deposit. The list is empty, so these
// pin the mechanism: an address added later must still close the gate.
describe('the C1 deposit freeze', () => {
  it('stores every entry lowercase, and matches it in any checksum casing', () => {
    // The registry and wagmi return checksummed addresses: a case-sensitive
    // compare would fail open at every real call site.
    for (const entry of C1_UNSAFE_LADDER_POOLS) {
      expect(entry, 'entries must be stored lowercase').toBe(entry.toLowerCase());
      expect(isC1UnsafeLadder(entry)).toBe(true);
      expect(isC1UnsafeLadder(entry.toUpperCase().replace('0X', '0x'))).toBe(true);
    }
  });

  // With the list empty, a test that iterates it passes even if the gate is
  // deleted. This one pushes a temporary entry into the list the shipped
  // function reads, drives the real function, and restores the list.
  it('closes the gate for an address on the list, in any casing the chain returns', () => {
    // Checksummed as addresses.json and wagmi return it, not as the list stores it.
    const CHECKSUMMED = '0xAbC0000000000000000000000000000000000123';
    const mutable = C1_UNSAFE_LADDER_POOLS as string[];

    expect(isC1UnsafeLadder(CHECKSUMMED), 'unlisted address must not be frozen').toBe(false);

    mutable.push(CHECKSUMMED.toLowerCase());
    try {
      expect(isC1UnsafeLadder(CHECKSUMMED.toLowerCase()), 'listed, lowercase').toBe(true);
      expect(isC1UnsafeLadder(CHECKSUMMED), 'listed, checksummed — the real call site').toBe(true);
      expect(isC1UnsafeLadder(CHECKSUMMED.toUpperCase().replace('0X', '0x')), 'listed, upper').toBe(
        true,
      );
      // Still a list lookup: freezing every pool once one is listed is its own outage.
      expect(isC1UnsafeLadder('0x000000000000000000000000000000000000dEaD')).toBe(false);
    } finally {
      mutable.pop();
    }

    expect(isC1UnsafeLadder(CHECKSUMMED), 'the list must be left as it was found').toBe(false);
  });

  it('never freezes an address that is not listed, and tolerates absent input', () => {
    expect(isC1UnsafeLadder('0x000000000000000000000000000000000000dEaD')).toBe(false);
    expect(isC1UnsafeLadder(null)).toBe(false);
    expect(isC1UnsafeLadder(undefined)).toBe(false);
    expect(isC1UnsafeLadder('')).toBe(false);
  });

  // A frozen address the registry no longer serves can never lift: drop it.
  // Served means a live ladder-* row in addresses.json. A retired row keeps a
  // dead pool's address on record; it does not serve it.
  it('freezes only pools the registry actually serves', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const registry = JSON.parse(
      readFileSync(join(here, '..', '..', 'scripts', 'addresses.json'), 'utf8'),
    );
    const served = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === 'object') {
        const o = node as Record<string, unknown>;
        const live = o.status === 'live';
        if (typeof o.id === 'string' && o.id.startsWith('ladder-') && live && typeof o.address === 'string') {
          served.add(o.address.toLowerCase());
        }
        Object.values(o).forEach(walk);
      }
    };
    walk(registry);

    const orphaned = C1_UNSAFE_LADDER_POOLS.filter((a) => !served.has(a));
    expect(
      orphaned,
      'these are frozen but the registry no longer serves them — drop them, the freeze is dead weight',
    ).toEqual([]);
  });
});
