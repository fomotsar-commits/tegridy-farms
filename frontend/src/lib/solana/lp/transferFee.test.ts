// @vitest-environment node
//
// The transfer-fee maths. `calculate_fee` and `get_epoch_fee` are held to
// @solana/spl-token's own `calculateFee` and `getEpochFee`; the two functions it has no
// copy of (`calculate_pre_fee_amount`, `calculate_inverse_fee`) are held to the vectors
// in spl-token-2022 8.0.1's own tests (extension/transfer_fee/mod.rs), copied here. The
// pool program's deposit wrapper is then held to what a deposit must do: exactly the
// pool's cost arrives, or the program refuses it.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { calculateFee, getEpochFee } from '@solana/spl-token';
import {
  MAX_FEE_BASIS_POINTS,
  afterFee,
  epochFee,
  feeNow,
  feeOf,
  feeRateText,
  inverseFeeOf,
  poolFee,
  poolInverseFee,
  preFeeAmountOf,
  type TransferFee,
  type TransferFeeConfig,
} from './transferFee';

const U64_MAX = (1n << 64n) - 1n;
const ONE = 10_000n;
const fee = (basisPoints: number, maximumFee: bigint, epoch = 0n): TransferFee => ({ epoch, maximumFee, basisPoints });
const lib = (f: TransferFee) => ({ epoch: f.epoch, maximumFee: f.maximumFee, transferFeeBasisPoints: f.basisPoints });

/** A small seeded generator, so a failure names the case it failed on. */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const big = (max: bigint) => {
    // Spread over magnitudes: dust, everyday amounts, and near u64::MAX.
    const digits = Math.floor(next() * 20);
    const v = BigInt(Math.floor(next() * 10 ** Math.min(digits, 15))) * 10n ** BigInt(Math.max(0, digits - 15));
    return v > max ? max : v;
  };
  return { next, big };
}

const FEES: TransferFee[] = [
  fee(0, U64_MAX),
  fee(1, 5_000n),
  fee(25, U64_MAX),
  fee(100, 10n),
  fee(500, U64_MAX),
  fee(500, 1_000_000n),
  fee(3_333, U64_MAX),
  fee(9_999, U64_MAX),
  fee(MAX_FEE_BASIS_POINTS, 5_000n),
  fee(MAX_FEE_BASIS_POINTS, 0n),
];

describe('feeOf and epochFee are spl-token’s own', () => {
  it('feeOf equals calculateFee for every setting, across dust, everyday and huge amounts', () => {
    const r = rng(7);
    for (const f of FEES) {
      for (let i = 0; i < 400; i++) {
        const pre = r.big(U64_MAX);
        expect(feeOf(f, pre), `${f.basisPoints}/${f.maximumFee} on ${pre}`).toBe(calculateFee(lib(f), pre));
      }
      expect(feeOf(f, U64_MAX)).toBe(calculateFee(lib(f), U64_MAX));
      expect(feeOf(f, 0n)).toBe(0n);
    }
  });

  it('epochFee picks the setting getEpochFee picks, on both sides of the change', () => {
    const c: TransferFeeConfig = { configAuthority: null, withdrawAuthority: null, withheldAmount: 0n, older: fee(100, 10n, 1n), newer: fee(1, 5_000n, 100n) };
    const libConfig = {
      transferFeeConfigAuthority: PublicKey.default,
      withdrawWithheldAuthority: PublicKey.default,
      withheldAmount: 0n,
      olderTransferFee: lib(c.older),
      newerTransferFee: lib(c.newer),
    };
    for (const epoch of [0n, 1n, 2n, 99n, 100n, 101n, U64_MAX]) {
      expect(epochFee(c, epoch).epoch, String(epoch)).toBe(getEpochFee(libConfig, epoch).epoch);
    }
  });
});

describe('spl-token-2022 8.0.1’s own vectors (extension/transfer_fee/mod.rs tests)', () => {
  const f = fee(1, 5_000n);
  it('calculate_fee_max and calculate_fee_min', () => {
    expect(feeOf(f, U64_MAX)).toBe(5_000n);
    expect(feeOf(f, 5_000n * ONE)).toBe(5_000n);
    expect(feeOf(f, 5_000n * ONE + 1n)).toBe(5_000n);
    expect(feeOf(f, 5_000n * ONE - 1n)).toBe(5_000n);
    expect(feeOf(f, 1n)).toBe(1n);
    expect(feeOf(f, 2n)).toBe(1n);
    expect(feeOf(f, ONE)).toBe(1n);
    expect(feeOf(f, ONE + 1n)).toBe(2n);
    expect(feeOf(f, 0n)).toBe(0n);
  });

  it('calculate_fee_zero', () => {
    for (const z of [fee(0, U64_MAX), fee(MAX_FEE_BASIS_POINTS, 0n)]) {
      for (const v of [0n, U64_MAX, 1n, ONE]) expect(feeOf(z, v)).toBe(0n);
    }
  });

  it('calculate_fee_exact_out_max and calculate_fee_exact_out_min', () => {
    expect(inverseFeeOf(f, U64_MAX - 5_000n)).toBe(5_000n);
    expect(inverseFeeOf(f, 5_000n * ONE - 5_000n)).toBe(5_000n);
    expect(inverseFeeOf(f, 5_000n * ONE - 5_000n + 1n)).toBe(5_000n);
    expect(inverseFeeOf(f, 5_000n * ONE - 5_000n - 1n)).toBe(5_000n);
    expect(inverseFeeOf(f, 1n)).toBe(1n);
    expect(inverseFeeOf(f, 2n)).toBe(1n);
    expect(inverseFeeOf(f, ONE - 1n)).toBe(1n);
    expect(inverseFeeOf(f, ONE)).toBe(2n);
    expect(inverseFeeOf(f, 0n)).toBe(0n);
  });

  it('calculate_pre_fee_amount_edge_cases', () => {
    const all = fee(MAX_FEE_BASIS_POINTS, 5_000n);
    expect(preFeeAmountOf(all, 0n)).toBe(0n);
    expect(preFeeAmountOf(all, 1n)).toBe(5_001n);
    expect(preFeeAmountOf(fee(0, 5_000n), 1n)).toBe(1n);
  });

  it('the inverse relationship the crate states: calculate_fee(x) ≥ calculate_inverse_fee(x − calculate_fee(x))', () => {
    const r = rng(11);
    for (const g of FEES) {
      for (let i = 0; i < 400; i++) {
        const pre = r.big(U64_MAX);
        const post = pre - feeOf(g, pre);
        const inv = inverseFeeOf(g, post);
        expect(inv === null || inv <= feeOf(g, pre), `${g.basisPoints}/${g.maximumFee} on ${pre}`).toBe(true);
      }
    }
  });
});

describe('the pool program’s two wrappers (cp-swap utils/token.rs)', () => {
  it('poolInverseFee: a deposit that is not refused delivers EXACTLY what the pool takes', () => {
    const r = rng(23);
    let mismatched = 0;
    let tried = 0;
    for (const g of FEES) {
      for (let i = 0; i < 400; i++) {
        const post = 1n + r.big(U64_MAX / 2n);
        const pre = preFeeAmountOf(g, post);
        const inv = poolInverseFee(g, post);
        // Past u64 is the program's own overflow, refused there too: not a case here.
        if (g.basisPoints !== MAX_FEE_BASIS_POINTS && (pre === null || pre > U64_MAX)) {
          expect(inv).toBeNull();
          continue;
        }
        tried++;
        if (inv === null) {
          mismatched++;
          continue;
        }
        // The token program takes its fee of the whole transfer; the vault gets the rest.
        expect(post + inv - feeOf(g, post + inv), `${g.basisPoints}/${g.maximumFee} for ${post}`).toBe(post);
      }
    }
    // TransferFeeCalculateNotMatch: kept because the program has it, but a brute-force search
    // (every 7th rate, caps 1 to 399, amounts 1 to 2,999; 2026-10-29) found no amount it
    // refuses, and neither does this run. The fee on top always checks out.
    expect(tried).toBeGreaterThan(3_000);
    expect(mismatched).toBe(0);
  });

  it('poolInverseFee: no fee is 0, a side of 0 is refused, 100% is the maximum fee unchecked', () => {
    expect(poolInverseFee(null, 0n)).toBe(0n);
    expect(poolInverseFee(null, 123n)).toBe(0n);
    expect(poolInverseFee(fee(500, U64_MAX), 0n)).toBeNull();
    expect(poolInverseFee(fee(MAX_FEE_BASIS_POINTS, 5_000n), 7n)).toBe(5_000n);
    // Past u64 is the program's overflow: refused.
    expect(poolInverseFee(fee(500, U64_MAX), U64_MAX - 1n)).toBeNull();
  });

  it('poolFee and afterFee: a withdrawal or swap loses the fee of the payout', () => {
    expect(poolFee(null, 1_000n)).toBe(0n);
    expect(poolFee(fee(500, U64_MAX), 1_000n)).toBe(50n);
    expect(afterFee(fee(500, U64_MAX), 1_000n)).toBe(950n);
    expect(afterFee(fee(500, 10n), 1_000n)).toBe(990n);
    // Any fee above 0 takes at least one unit: one unit out reaches the wallet as none.
    expect(afterFee(fee(1, U64_MAX), 1n)).toBe(0n);
    expect(afterFee(null, 1n)).toBe(1n);
  });
});

describe('feeNow: the fee a transfer pays now', () => {
  const c = (older: TransferFee, newer: TransferFee): TransferFeeConfig => ({ configAuthority: null, withdrawAuthority: null, withheldAmount: 0n, older, newer });
  it('with the epoch, exactly the token program’s choice', () => {
    const pending = c(fee(100, U64_MAX, 1n), fee(900, U64_MAX, 500n));
    expect(feeNow(pending, 499n)?.basisPoints).toBe(100);
    expect(feeNow(pending, 500n)?.basisPoints).toBe(900);
  });
  it('without it, the setting both agree on, else the larger of the two', () => {
    expect(feeNow(c(fee(300, 9n, 1n), fee(300, 9n, 7n)), null)?.basisPoints).toBe(300);
    expect(feeNow(c(fee(100, U64_MAX, 1n), fee(900, U64_MAX, 500n)), null)?.basisPoints).toBe(900);
    expect(feeNow(c(fee(900, U64_MAX, 1n), fee(100, U64_MAX, 500n)), null)?.basisPoints).toBe(900);
    expect(feeNow(null, 5n)).toBeNull();
  });
  it('a rate in words', () => {
    expect([fee(500, 0n), fee(25, 0n), fee(1, 0n), fee(10_000, 0n), fee(1_050, 0n)].map(feeRateText)).toEqual(['5%', '0.25%', '0.01%', '100%', '10.5%']);
  });
});
