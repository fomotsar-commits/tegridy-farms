// @vitest-environment node
//
// The robot's own swap legs, held to mainnet simulations the programs accepted (directLegs.fixture.ts).
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { decodeAmmConfig, decodePoolState } from '../cpswap/program';
import { AMM_V4_AUTHORITY, RAYDIUM_AMM_V4, RAYDIUM_CPMM, ammV4Leg, ammV4Out, cpLeg, decodeAmmV4, type AmmV4Pool } from './directLegs';
import { LEG_RUNS } from './directLegs.fixture';

const WALLET = new PublicKey('9WAugU3g3YECwuEuoPy3NEH5Co475fHATGdjr2dy2Fcz');
const SOL = 'So11111111111111111111111111111111111111112';
const run = (venue: string) => LEG_RUNS.find((r) => r.venue === venue)!;
const bytes = (r: { accounts: Record<string, { data: string }> }, k: string) => Buffer.from(r.accounts[k]!.data, 'base64');
const amountOf = (d: Uint8Array) => Buffer.from(d).readBigUInt64LE(64);
const shape = (keys: readonly { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) => keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);

describe('Raydium AMM v4: swap_base_in_v2, held to a mainnet simulation', () => {
  const r = run('Raydium AMM v4');
  const p = decodeAmmV4(r.pool, bytes(r, r.pool))!;
  const coin = amountOf(bytes(r, p.coinVault));
  const pc = amountOf(bytes(r, p.pcVault));

  it('pays exactly what the program paid, with the accounts and bytes it accepted', () => {
    const leg = ammV4Leg(p, coin, pc, WALLET, SOL, BigInt(r.amountIn), BigInt(r.out))!;
    expect(leg.out).toBe(BigInt(r.out));
    expect(leg.ix.programId.equals(RAYDIUM_AMM_V4)).toBe(true);
    expect(shape(leg.ix.keys)).toEqual(r.keys);
    expect(Buffer.from(leg.ix.data).toString('hex')).toBe(r.data);
    expect(leg.ix.keys[2]!.pubkey.equals(AMM_V4_AUTHORITY)).toBe(true);
  });

  const toy: AmmV4Pool = { ...p, swapFeeNumerator: 25n, swapFeeDenominator: 10_000n, needTakePnlCoin: 0n, needTakePnlPc: 0n };
  it('rounds the swap fee up, then the payout down', () => {
    // 1001 in: fee ceil(2.5025) = 3, so 998 swaps; 1_000_000 × 998 / (1_000_000 + 998) = 997.00…, paid 997.
    expect(ammV4Out(toy, 1_000_000n, 1_000_000n, true, 1001n)).toBe(997n);
  });
  it('trades against the vaults less the profit the pool still owes', () => {
    expect(ammV4Out({ ...toy, needTakePnlPc: 500_000n }, 1_000_000n, 1_000_000n, true, 1001n)).toBe(498n);
    // 500,000 × 998 ÷ (500,000 + 998)… on the coin side: 1,000,000 × 998 ÷ 500,998 = 1,992.0…
    expect(ammV4Out({ ...toy, needTakePnlCoin: 500_000n }, 1_000_000n, 1_000_000n, true, 1001n)).toBe(1992n);
  });
  it('builds nothing for a pool that does not swap, or before it opens', () => {
    expect(ammV4Leg({ ...p, status: 4n }, coin, pc, WALLET, SOL, 1_000n, 1n)).toBeNull();
    expect(ammV4Leg({ ...p, openTime: 4_000_000_000n }, coin, pc, WALLET, SOL, 1_000n, 1n, 1_800_000_000)).toBeNull();
    expect(ammV4Leg(p, coin, pc, WALLET, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1_000n, 1n)).toBeNull();
  });
});

describe('Raydium CPMM: the cp-swap program, held to a mainnet simulation', () => {
  const r = run('Raydium CPMM');
  const pool = decodePoolState(r.pool, bytes(r, r.pool))!;
  const config = decodeAmmConfig(pool.ammConfig, bytes(r, pool.ammConfig))!;
  const cp = { pool, config, vault0: amountOf(bytes(r, pool.token0Vault)), vault1: amountOf(bytes(r, pool.token1Vault)) };

  it('pays exactly what the program paid, with the accounts and bytes it accepted', () => {
    const leg = cpLeg(cp, WALLET, SOL, BigInt(r.amountIn), BigInt(r.out))!;
    expect(leg.out).toBe(BigInt(r.out));
    expect(leg.ix.programId.equals(RAYDIUM_CPMM)).toBe(true);
    expect(shape(leg.ix.keys)).toEqual(r.keys);
    expect(Buffer.from(leg.ix.data).toString('hex')).toBe(r.data);
  });
  it('prices against the vaults less the fees parked in them', () => {
    const lean = cpLeg({ ...cp, vault0: cp.vault0 + 1_000_000_000n, vault1: cp.vault1 + 1_000_000_000n }, WALLET, SOL, BigInt(r.amountIn), 1n)!;
    expect(lean.out).not.toBe(BigInt(r.out));
  });
  it('builds nothing for a coin the pool does not hold', () => {
    expect(cpLeg(cp, WALLET, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1_000n, 1n)).toBeNull();
  });
});
