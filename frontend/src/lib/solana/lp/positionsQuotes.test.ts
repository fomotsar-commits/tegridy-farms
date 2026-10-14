// @vitest-environment node
//
// "Your positions" with pools paired with different coins: each share is valued in its
// own pool's coin, and amounts of different coins are never weighed against each other.
import { describe, it, expect } from 'vitest';
import { readPositions, positionQuoteValue } from './positions';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from './quotes';
import { TOKEN_PROGRAM } from './tokenSafety';
import { CLOCK, LAUNCH, PROGRAM, buildPool, clockAccount, fakeIndex, fakeRpc, key, keyStartingWith, tokenAccountBytes, type FakeAccount } from './testkit.fixture';

const opts = (fetchImpl: typeof fetch) => ({ programId: PROGRAM, launchProgramId: LAUNCH, fetchImpl });

describe('readPositions: shares in pools paired with SOL, USDC and BAYLA', () => {
  it('lists them by coin (SOL, USDC, BAYLA), the most of that coin first, whatever the raw numbers', async () => {
    const wallet = key();
    // [coin, quote reserve, the wallet's shares out of 1,000,000]. The USDC and BAYLA
    // shares pay out far more BASE UNITS than the SOL ones; they still come after SOL.
    const specs: Array<[QuoteCoin, bigint, bigint]> = [
      [BAYLA_QUOTE, 10n ** 15n, 500_000n],
      [USDC_QUOTE, 10n ** 14n, 100_000n],
      [SOL_QUOTE, 10n ** 9n, 100_000n],
      [USDC_QUOTE, 10n ** 14n, 900_000n],
      [SOL_QUOTE, 10n ** 9n, 400_000n],
      [BAYLA_QUOTE, 10n ** 15n, 100_000n],
    ];
    const accounts: Record<string, FakeAccount> = { [CLOCK]: clockAccount(5n) };
    const index: Record<string, string[]> = {};
    for (const [quote, quoteReserve, held] of specs) {
      const p = buildPool({ mint: key(), quote, address: key(), quoteReserve, tokenReserve: 10n ** 9n, lpSupply: 1_000_000n });
      Object.assign(accounts, p.accounts, { [key().toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, held) } });
      index[`lpMint:${p.lpMint.toBase58()}`] = [p.address.toBase58()];
    }
    const r = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex(index)));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.positions.map((p) => p.pool?.kind === 'pool' && [p.pool.view.quote.symbol, positionQuoteValue(p)])).toEqual([
      ['SOL', 4n * 10n ** 8n],
      ['SOL', 10n ** 8n],
      ['USDC', 9n * 10n ** 13n],
      ['USDC', 10n ** 13n],
      ['BAYLA', 5n * 10n ** 14n],
      ['BAYLA', 10n ** 14n],
    ]);
  });

  it('a share in a USDC pool is valued on the USDC side, whichever side of the pool that is', async () => {
    const wallet = key();
    const seen = new Set<boolean>();
    // One token that sorts below USDC's mint and one that sorts above it, made on purpose.
    for (const mint of [keyStartingWith(1), keyStartingWith(250)]) {
      const p = buildPool({ mint, quote: USDC_QUOTE, address: key(), quoteReserve: 800n, tokenReserve: 50n, lpSupply: 100n });
      const accounts: Record<string, FakeAccount> = {
        ...p.accounts,
        [CLOCK]: clockAccount(5n),
        [key().toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(p.lpMint, wallet, 25n) },
      };
      const r = await readPositions(fakeRpc(accounts), wallet, opts(fakeIndex({ [`lpMint:${p.lpMint.toBase58()}`]: [p.address.toBase58()] })));
      const pos = r.kind === 'ok' ? r.positions[0] : undefined;
      expect(pos?.pool?.kind).toBe('pool');
      if (pos?.pool?.kind !== 'pool') return;
      expect(pos.pool.view.quote).toBe(USDC_QUOTE);
      // A quarter of the pool: 200 of the 800 USDC units, and 12 of the 50 token units (floor).
      expect(positionQuoteValue(pos)).toBe(200n);
      expect(pos.pool.view.quoteIsToken0 ? pos.value?.token1 : pos.value?.token0).toBe(12n);
      seen.add(pos.pool.view.quoteIsToken0);
    }
    expect(seen.size).toBe(2);
  });
});
