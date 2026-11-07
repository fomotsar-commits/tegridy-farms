// @vitest-environment node
//
// The robot's own swap legs, held to mainnet simulations the programs accepted (directLegs.fixture.ts).
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { decodeAmmConfig, decodePoolState } from '../cpswap/program';
import { PUMP_BUYBACK_RECIPIENTS, PUMP_GLOBAL_CONFIG, ammV4Leg, ammV4Out, cpLeg, decodeAmmV4, decodePumpPool, pumpBuyLeg, pumpPoolV2, pumpSellLeg, type AmmV4Pool, type PumpFees } from './directLegs';
import { LEG_RUNS } from './directLegs.fixture';

// Raydium's ids live in scripts/lib/raydium-programs.mjs (src/ may not name them; a test may).
const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const AMM_V4_AUTHORITY = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
const AMM_V4 = { program: RAYDIUM_AMM_V4, authority: AMM_V4_AUTHORITY };
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
    const leg = ammV4Leg(p, coin, pc, WALLET, SOL, BigInt(r.amountIn), BigInt(r.out), AMM_V4)!;
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
    expect(ammV4Leg({ ...p, status: 4n }, coin, pc, WALLET, SOL, 1_000n, 1n, AMM_V4)).toBeNull();
    expect(ammV4Leg({ ...p, openTime: 4_000_000_000n }, coin, pc, WALLET, SOL, 1_000n, 1n, AMM_V4, 1_800_000_000)).toBeNull();
    expect(ammV4Leg(p, coin, pc, WALLET, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1_000n, 1n, AMM_V4)).toBeNull();
  });
});

describe('Raydium CPMM: the cp-swap program, held to a mainnet simulation', () => {
  const r = run('Raydium CPMM');
  const pool = decodePoolState(r.pool, bytes(r, r.pool))!;
  const config = decodeAmmConfig(pool.ammConfig, bytes(r, pool.ammConfig))!;
  const cp = { pool, config, vault0: amountOf(bytes(r, pool.token0Vault)), vault1: amountOf(bytes(r, pool.token1Vault)) };

  it('pays exactly what the program paid, with the accounts and bytes it accepted', () => {
    const leg = cpLeg(cp, WALLET, SOL, BigInt(r.amountIn), BigInt(r.out), RAYDIUM_CPMM)!;
    expect(leg.out).toBe(BigInt(r.out));
    expect(leg.ix.programId.equals(RAYDIUM_CPMM)).toBe(true);
    expect(shape(leg.ix.keys)).toEqual(r.keys);
    expect(Buffer.from(leg.ix.data).toString('hex')).toBe(r.data);
  });
  it('prices against the vaults less the fees parked in them', () => {
    const lean = cpLeg({ ...cp, vault0: cp.vault0 + 1_000_000_000n, vault1: cp.vault1 + 1_000_000_000n }, WALLET, SOL, BigInt(r.amountIn), 1n, RAYDIUM_CPMM)!;
    expect(lean.out).not.toBe(BigInt(r.out));
  });
  it('builds nothing for a coin the pool does not hold', () => {
    expect(cpLeg(cp, WALLET, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1_000n, 1n, RAYDIUM_CPMM)).toBeNull();
  });
});

describe('PumpSwap: buy and sell, held to mainnet simulations (2026-11-07)', () => {
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const pumpRuns = LEG_RUNS.filter((r) => r.venue === 'PumpSwap');
  const setUp = (r: (typeof pumpRuns)[number]) => {
    const p = decodePumpPool(r.pool, bytes(r, r.pool))!;
    const mintOwner = (r.accounts as Record<string, { owner: string }>)[p.baseMint]!.owner;
    const ctx = {
      protocolFeeRecipient: new PublicKey(bytes(r, PUMP_GLOBAL_CONFIG.toBase58()).subarray(57, 89)),
      buybackRecipient: new PublicKey(PUMP_BUYBACK_RECIPIENTS[0]!),
      baseProgram: new PublicKey(mintOwner),
      quoteProgram: new PublicKey(TOKEN),
    };
    const f = (r as { fees?: Record<string, string> }).fees!;
    const fees: PumpFees = { lpBps: BigInt(f.lpBps!), protocolBps: BigInt(f.protocolBps!), creatorBps: BigInt(f.creatorBps!) };
    const base = amountOf(bytes(r, p.baseVault));
    const quote = amountOf(bytes(r, p.quoteVault)) + p.quoteExtra;
    return { p, ctx, fees, base, quote };
  };

  it('has two pools on record, both buys the program accepted', () => {
    expect(pumpRuns.map((r) => r.pool)).toEqual(['8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n', 'GiV7bAkQ6dipyPd5rFuoQeLLBJCNrRwP57dETVe6ourc']);
  });
  for (const r of pumpRuns) {
    it(`buys exactly what the program paid in ${r.pool}, with the 26 accounts it accepted`, () => {
      const { p, ctx, fees, base, quote } = setUp(r);
      const leg = pumpBuyLeg(p, fees, base, quote, WALLET, ctx, BigInt(r.amountIn), 1n)!;
      expect(leg.out).toBe(BigInt(r.out));
      expect(shape(leg.ix.keys)).toEqual(r.keys);
      expect(Buffer.from(leg.ix.data).toString('hex')).toBe(r.data);
    });
  }
  it('names the pool-v2 address, a buyback recipient and its wrapped-SOL account last, as every trade must since 2026-11 (6062 InvalidPoolV2 without)', () => {
    const { p, ctx, fees, base, quote } = setUp(pumpRuns[0]!);
    const keys = pumpBuyLeg(p, fees, base, quote, WALLET, ctx, 10_000_000n, 1n)!.ix.keys;
    const tail = shape(keys.slice(-3));
    expect(tail).toEqual([
      [pumpPoolV2(p.baseMint).toBase58(), false, false],
      [PUMP_BUYBACK_RECIPIENTS[0], false, false],
      [getAssociatedTokenAddressSync(new PublicKey(SOL), new PublicKey(PUMP_BUYBACK_RECIPIENTS[0]!), true).toBase58(), false, true],
    ]);
  });
  it('derives pool-v2 as a live mainnet trade named it (BOBO, 2026-11-07)', () => {
    expect(pumpPoolV2('4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump').toBase58()).toBe('8UBw7wPkT2ZzQrXLdvJaGpcw8YepBHmSwk75xGpxmWTb');
  });
  it('sells with 24 accounts: no volume accounts, then the fee accounts, then the same three', () => {
    const { p, ctx, fees, base, quote } = setUp(pumpRuns[0]!);
    const buy = pumpBuyLeg(p, fees, base, quote, WALLET, ctx, 10_000_000n, 1n)!;
    const sell = pumpSellLeg(p, fees, base, quote, WALLET, ctx, 1_000_000n, 1n)!;
    expect(sell.ix.keys).toHaveLength(24);
    expect(buy.ix.keys).toHaveLength(26);
    // The buy's two volume accounts sit between the shared head and the fee accounts.
    expect(shape(sell.ix.keys)).toEqual(shape([...buy.ix.keys.slice(0, 19), ...buy.ix.keys.slice(21)]));
    expect(Buffer.from(sell.ix.data).subarray(0, 8)).toEqual(Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]));
  });
});
