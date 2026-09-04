import { describe, it, expect } from 'vitest';
import { BUNGALOWS } from '../bungalows';
import { TOWELI_MARKET } from './market';
import {
  chartableMarkets,
  defaultMarketFor,
  findMarket,
  hasChartableMarket,
  marketKey,
  NETWORK_LABELS,
} from './markets';

// This list is what the /chart picker offers AND what the nav pill reads, so a
// drift between the two is impossible only while these hold. The mutations each
// case is aimed at are named in its comment.

describe('chartableMarkets', () => {
  it('leads with the venue\'s own pool, and that pool is the registry\'s TOWELI LP', () => {
    const first = chartableMarkets()[0];
    // Mutation: point the TOWELI entry at some other pool or chain, or drop it
    // from the head of the list, and this fails. The pool is compared against
    // TOWELI_MARKET rather than against a literal so the single source of truth
    // stays constants.ts → addresses.json.
    expect(first?.network).toBe(TOWELI_MARKET.network);
    expect(first?.pool).toBe(TOWELI_MARKET.pool);
    expect(first?.label).toBe('TOWELI');
  });

  it('offers exactly one entry per registry resident that carries a market, and none for those that do not', () => {
    const residents = BUNGALOWS.filter((b) => b.market);
    const withoutMarket = BUNGALOWS.filter((b) => !b.market);
    // Sanity: a registry with no market-bearing resident would make every other
    // assertion here vacuous.
    expect(residents.length).toBeGreaterThan(5);
    expect(withoutMarket.length).toBeGreaterThan(0);

    const list = chartableMarkets();
    // TOWELI plus one per resident with a market. Mutation: filtering on `live`
    // or on `chain` instead of on `market` changes this count.
    expect(list).toHaveLength(residents.length + 1);

    for (const b of residents) {
      const hit = list.find((m) => marketKey(m.network, m.pool) === marketKey(b.market!.network, b.market!.pool));
      expect(hit, `${b.symbol} has a market but is not chartable`).toBeDefined();
      // The resident's ticker leads the label, so the picker is a list of island
      // residents rather than a list of anonymous pair strings.
      expect(hit!.label.startsWith(`${b.symbol} · `)).toBe(true);
    }

    for (const b of withoutMarket) {
      const stray = list.find((m) => m.label.startsWith(`${b.symbol} · `));
      expect(stray, `${b.symbol} has no market and must not be offered`).toBeUndefined();
    }
  });

  it('names a network for every entry that the label table can render', () => {
    for (const m of chartableMarkets()) {
      expect(NETWORK_LABELS[m.network]).toBeTruthy();
    }
  });
});

describe('marketKey', () => {
  it('folds hex case on EVM chains, because 0xAB… and 0xab… are one pool', () => {
    // Mutation: drop the toLowerCase and the picker lists the same pool twice
    // the moment one registry entry is checksummed and another is not.
    expect(marketKey('eth', '0xABCdef0000000000000000000000000000000001')).toBe(
      marketKey('eth', '0xabcdef0000000000000000000000000000000001'),
    );
    expect(marketKey('base', '0xABC')).toBe(marketKey('base', '0xabc'));
  });

  it('PRESERVES case on Solana, because base58 is case-sensitive', () => {
    // Mutation: lowercase Solana too, and two different accounts collapse into
    // one key — one pool would be charted under another pool's name.
    expect(marketKey('solana', 'AbCdEfGhIjKlMnOpQrStUvWxYz123456789')).not.toBe(
      marketKey('solana', 'abcdefghijklmnopqrstuvwxyz123456789'),
    );
  });

  it('never lets one network\'s pool answer for another\'s', () => {
    expect(marketKey('eth', '0xabc')).not.toBe(marketKey('base', '0xabc'));
  });
});

describe('findMarket', () => {
  it('matches a registry pool through EVM hex case', () => {
    const found = findMarket('eth', TOWELI_MARKET.pool.toUpperCase().replace('0X', '0x'));
    expect(found?.pool).toBe(TOWELI_MARKET.pool);
  });

  it('does NOT match a Solana pool whose case was changed', () => {
    const solana = chartableMarkets().find((m) => m.network === 'solana');
    expect(solana, 'the registry should carry at least one Solana pool').toBeDefined();
    // Mutation: case-fold Solana in marketKey and this returns a market — a
    // deep link with a mangled mint would chart a pool it does not name.
    expect(findMarket('solana', solana!.pool.toLowerCase())).toBeNull();
    expect(findMarket('solana', solana!.pool)).not.toBeNull();
  });

  it('refuses a pool that is not in the registry, including a traversal-shaped one', () => {
    expect(findMarket('eth', '../../search/pools')).toBeNull();
    expect(findMarket('eth', '0x0000000000000000000000000000000000000000')).toBeNull();
    expect(findMarket('eth', '')).toBeNull();
    // A real registry pool asked for on the WRONG network is still a miss: the
    // network is part of the identity, not a hint.
    const solana = chartableMarkets().find((m) => m.network === 'solana')!;
    expect(findMarket('eth', solana.pool)).toBeNull();
  });
});

describe('defaultMarketFor', () => {
  it('is TOWELI on Ethereum and a pool actually on that chain elsewhere', () => {
    expect(defaultMarketFor('eth')?.pool).toBe(TOWELI_MARKET.pool);
    for (const network of ['base', 'solana'] as const) {
      const fallback = defaultMarketFor(network);
      // Mutation: fall back to a hardcoded TOWELI for every network, and a
      // ?network=solana link would chart an Ethereum pool under a Solana
      // heading.
      expect(fallback?.network).toBe(network);
    }
  });
});

describe('hasChartableMarket — the /chart nav pill', () => {
  it('is true today, because the registry names pools', () => {
    // The pill is `soon: !hasChartableMarket()`. Mutation: hardcode the pill to
    // false and navConfig stops tracking this; hardcode this to true and the
    // "self-clears when the registry empties" property below dies.
    expect(hasChartableMarket()).toBe(true);
  });

  it('is exactly "the list is not empty" — nothing else', () => {
    expect(hasChartableMarket()).toBe(chartableMarkets().length > 0);
  });
});
