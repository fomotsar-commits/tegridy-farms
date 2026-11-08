// Island answer twenty-five, screen 3: the receipt's figures are what the signature paid. Pinned
// to the venue's own mainnet history: the BAYLA/SOL pool's first three swaps and its deposits.
import { describe, expect, it } from 'vitest';
import rows from './lp/__fixtures__/mainnet-history/pool.baylaSol.2026-10-10.transactions.json';
import { amountText, eventsOf, feeReceived, ownerDelta, poolFeeSplit, swapFee } from './receiptRead';

type Row = { signature: string; tx: { meta: { logMessages: string[]; fee: number; err: unknown; preTokenBalances: never[]; postTokenBalances: never[] } } };
const history = rows as unknown as Row[];
const POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';
const WSOL = 'So11111111111111111111111111111111111111112';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const SOL = { mint: WSOL, symbol: 'SOL', decimals: 9 };

const swaps = history.flatMap((r) => eventsOf(r.tx.meta.logMessages).swaps);
const deposits = history.flatMap((r) => eventsOf(r.tx.meta.logMessages).lp);

describe('the pool program’s own events', () => {
  it('reads the pool’s three swaps: SOL in, BAYLA out, a 1% trade fee on what was paid', () => {
    expect(swaps.map((s) => s.inputAmount).sort((a, b) => Number(a - b))).toEqual([10_000_000n, 122_000_000n, 369_000_000n]);
    for (const s of swaps) {
      expect(s.pool).toBe(POOL);
      expect(s.inputMint).toBe(WSOL);
      expect(s.outputMint).toBe(BAYLA);
      expect(s.tradeFee).toBe((s.inputAmount + 99n) / 100n);
      expect(s.creatorFee).toBe(0n);
    }
    // The third swap, as decoded by hand: 0.122 SOL for 25,623.836131 BAYLA.
    expect(swaps.find((s) => s.inputAmount === 122_000_000n)!.outputAmount).toBe(25_623_836_131n);
  });

  it('splits each fee as the program does, and the venue’s parts add up to the cut the chain holds: 801,600 lamports', () => {
    // The README's read of the pool on 2026-10-10: 801,600 lamports of the SOL vault are the venue's uncollected cut.
    for (const rates of [{ protocolFeeRate: 160_000n, fundFeeRate: 0n }, { protocolFeeRate: 104_000n, fundFeeRate: 56_000n }]) {
      const splits = swaps.map((s) => poolFeeSplit(s, rates)!);
      expect(splits.reduce((sum, x) => sum + x.venue, 0n)).toBe(801_600n);
      for (const [i, x] of splits.entries()) expect(x.lps + x.venue).toBe(swaps[i]!.tradeFee);
    }
  });

  it('reads a deposit’s two amounts, each exactly what its vault gained', () => {
    expect(deposits).toHaveLength(30);
    expect(deposits.every((d) => d.pool === POOL && d.deposit)).toBe(true);
    expect(deposits).toContainEqual({ pool: POOL, amount0: 514_851_486n, amount1: 108_697_908_234n, deposit: true });
  });

  it('reads nothing from logs with no event, a cut-short line or a foreign program’s data', () => {
    expect(eventsOf(null)).toEqual({ swaps: [], lp: [] });
    expect(eventsOf(['Program log: Instruction: Swap', 'Program data: QMbN6CYI', 'Program data: !!!'])).toEqual({ swaps: [], lp: [] });
  });
});

describe('the receipt’s fee rows', () => {
  const third = history.find((r) => eventsOf(r.tx.meta.logMessages).swaps.some((s) => s.inputAmount === 122_000_000n))!;
  it('our pool: the fee, the LPs’ part and the venue’s part, from the swap’s own event', () => {
    expect(swapFee(third.tx.meta, { kind: 'pool', pool: POOL, rates: { protocolFeeRate: 104_000n, fundFeeRate: 56_000n } }, SOL)).toEqual({
      kind: 'pool',
      unit: 'SOL',
      fee: '0.00122 SOL',
      lps: '0.0010248 SOL',
      venue: '0.0001952 SOL',
      creator: null,
    });
  });
  it('a pool the transaction did not trade in is unread, never a guess', () => {
    expect(swapFee(third.tx.meta, { kind: 'pool', pool: 'Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV', rates: { protocolFeeRate: 104_000n, fundFeeRate: 56_000n } }, SOL)).toEqual({ kind: 'unread' });
  });
  it('Jupiter’s route: what the venue’s fee wallet received in this transaction, or nothing', () => {
    const FEE = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
    const meta = {
      err: null,
      fee: 5000,
      preTokenBalances: [{ accountIndex: 3, mint: WSOL, owner: FEE, uiTokenAmount: { amount: '7000', decimals: 9 } }],
      postTokenBalances: [{ accountIndex: 3, mint: WSOL, owner: FEE, uiTokenAmount: { amount: '1007000', decimals: 9 } }],
    };
    expect(feeReceived(meta, FEE)).toEqual([{ mint: WSOL, amount: 1_000_000n, decimals: 9 }]);
    expect(swapFee(meta, { kind: 'site', feeOwner: FEE }, SOL)).toEqual({ kind: 'site', venue: '0.001 SOL' });
    expect(swapFee(meta, { kind: 'site', feeOwner: 'someone else' }, SOL)).toEqual({ kind: 'site', venue: null });
    expect(swapFee(meta, { kind: 'site', feeOwner: null }, SOL)).toEqual({ kind: 'site', venue: null });
    expect(ownerDelta(meta, FEE, WSOL)).toBe(1_000_000n);
  });
});

describe('amounts as the card writes them', () => {
  it.each([
    [1_220_000n, 9, '0.00122'],
    [100_000_000n, 9, '0.1'],
    [13_371_123_456n, 6, '13,371'],
    [6_685_500_000n, 6, '6,685'],
    [1_500_000n, 6, '1.5'],
    [25_623_836_131n, 6, '25,623'],
    [1_234_567n, 6, '1.2345'],
  ] as const)('%s at %s decimals reads %s', (base, decimals, text) => {
    expect(amountText(base, decimals)).toBe(text);
  });
});
