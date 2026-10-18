// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BUNGALOWS } from './bungalows';
import { EVM_BASKET, SOL_BASKET, acceptUsd, evmBasketFor, minOut, splitEvenly, usdToBaseUnits } from './islandBasket';

const lower = (a: string) => a.toLowerCase();
const rooms = BUNGALOWS.filter((b) => b.chain !== 'tbd');

describe('the island order lists every room’s coin on its own chain', () => {
  it.each([
    ['solana', SOL_BASKET.map((c) => ({ room: c.room, address: c.mint, bridged: false }))],
    ['base', EVM_BASKET.base.map((c) => ({ room: c.room, address: c.token, bridged: Boolean(c.bridged) }))],
    ['ethereum', EVM_BASKET.ethereum.map((c) => ({ room: c.room, address: c.token, bridged: Boolean(c.bridged) }))],
  ] as const)('%s: each room once, at the address the room itself names', (chain, coins) => {
    const home = rooms.filter((b) => b.chain === chain);
    const own = coins.filter((c) => !c.bridged);
    expect(own.map((c) => c.room).sort()).toEqual(home.map((b) => b.id).sort());
    for (const c of own) {
      const room = home.find((b) => b.id === c.room)!;
      // Solana mints are case-significant; EVM addresses are not.
      expect(chain === 'solana' ? c.address : lower(c.address)).toBe(chain === 'solana' ? room.address : lower(room.address!));
    }
  });

  it('a coin carried over a bridge is listed only on Base, from its room’s home chain, at the address Wormhole names', () => {
    const bridged = [...EVM_BASKET.ethereum, ...EVM_BASKET.base, ...SOL_BASKET.map((c) => ({ ...c, bridged: undefined }))].filter((c) => c.bridged);
    expect(bridged.map((c) => `${c.room}:${lower((c as { token: string }).token)}:${c.bridged!.from}`).sort()).toEqual([
      // Wormhole's token bridge on Base, wrappedAsset(2, TOWELI) and wrappedAsset(1, RIZZ), read 2026-10-18.
      'rizz:0x58d6e314755c2668f3d7358cc7a7a06c4314b238:solana',
      'toweli:0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca:ethereum',
    ]);
    for (const c of bridged) expect(rooms.find((b) => b.id === c.room)?.chain).toBe(c.bridged!.from);
  });

  it('lists no namesake: BOBO on Ethereum or Base is another coin, and the PEPE and $mfer copies on Solana have no market', () => {
    const evm = [...EVM_BASKET.ethereum, ...EVM_BASKET.base].map((c) => lower(c.token));
    expect(evm).not.toContain('0xb90b2a35c65dbc466b04240097ca756ad2005295');
    expect(evm).not.toContain('0x570b1533f6daa82814b25b62b5c7c4c55eb83947');
    const sol = SOL_BASKET.map((c) => c.mint);
    expect(sol).not.toContain('AqKa2CkGjDsShAzam52nEUc6PUc38MkXg7xBhCEjv5U8');
    expect(sol).not.toContain('CBLZBiNYYFytKvDLYiVwqbQamUAFk423st4fFmaXbJNg');
  });

  it('every coin has at least one pool, and no pool is listed twice', () => {
    const pools = [
      ...[...EVM_BASKET.ethereum, ...EVM_BASKET.base].flatMap((c) => {
        expect(c.pools.length).toBeGreaterThan(0);
        return c.pools.map((p) => lower(p.address));
      }),
      ...SOL_BASKET.map((c) => c.pool.address),
    ];
    expect(new Set(pools).size).toBe(pools.length);
  });

  it('Solana coins go through the PumpSwap pools their launch curves migrated to, and RIZZ through Raydium', () => {
    expect(SOL_BASKET.map((c) => [c.symbol, c.pool.dex, c.pool.jupiterLabel, c.pool.address])).toEqual([
      ['BAYLA', 'pumpswap', 'Pump.fun Amm', '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n'],
      ['BOBO', 'pumpswap', 'Pump.fun Amm', '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX'],
      ['SOY', 'pumpswap', 'Pump.fun Amm', 'H8yiDq5XaNkiT6J3QXDeBVfsFHNaVwTRNicbWZnibexi'],
      ['BRAINLET', 'pumpswap', 'Pump.fun Amm', '3whYbw26asxFG5Qh9emHA6Mi6uizvduYg1cVKLQ1eetq'],
      ['RIZZ', 'raydium-amm-v4', 'Raydium', 'dgaDYLCP67MqAzt28WAYtE6pYCHUbRMHtWYLniH1DaL'],
    ]);
  });

  it('serves Ethereum and Base only', () => {
    expect(evmBasketFor(1)).toBe(EVM_BASKET.ethereum);
    expect(evmBasketFor(8453)).toBe(EVM_BASKET.base);
    expect(evmBasketFor(4663)).toBeNull();
    expect(evmBasketFor(undefined)).toBeNull();
  });
});

describe('splitEvenly', () => {
  it('adds up to exactly the total, every share within one unit of the others', () => {
    for (const [total, n] of [[10n, 3], [1_000_000_007n, 7], [5n, 5], [4_166_666_666_666_667n, 7]] as const) {
      const s = splitEvenly(total, n)!;
      expect(s).toHaveLength(n);
      expect(s.reduce((a, b) => a + b, 0n)).toBe(total);
      expect(s[0]! - s[s.length - 1]!).toBeLessThanOrEqual(1n);
    }
  });

  it('refuses nothing to split, no shares, or a total smaller than the count', () => {
    expect(splitEvenly(0n, 5)).toBeNull();
    expect(splitEvenly(-1n, 5)).toBeNull();
    expect(splitEvenly(10n, 0)).toBeNull();
    expect(splitEvenly(10n, 1.5)).toBeNull();
    expect(splitEvenly(4n, 5)).toBeNull();
  });
});

describe('usdToBaseUnits', () => {
  it('turns dollars into the paid coin’s base units at its price, rounding down', () => {
    // $10 at $2,400 an ETH = 0.004166 ETH (six decimals kept).
    expect(usdToBaseUnits('10', 2400, 18)).toBe(4_166_000_000_000_000n);
    // $10 at $105 a SOL = 0.095238 SOL.
    expect(usdToBaseUnits('10', 105, 9)).toBe(95_238_000n);
    expect(usdToBaseUnits('2.5', 1, 6)).toBe(2_500_000n);
  });

  it('never guesses: no amount, a bad amount or no price is null', () => {
    for (const usd of ['', '0', '-1', 'abc', '1e3', '1.2.3', ' ']) expect(usdToBaseUnits(usd, 2400, 18)).toBeNull();
    for (const price of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) expect(usdToBaseUnits('10', price, 18)).toBeNull();
  });
});

describe('minOut', () => {
  it('takes the slippage off, rounding down', () => {
    expect(minOut(10_000n, 100)).toBe(9_900n);
    expect(minOut(10_001n, 50)).toBe(9_951n);
    expect(minOut(10_000n, 0)).toBe(10_000n);
  });

  it('is null, never 0, for a quote or slippage that makes no sense', () => {
    expect(minOut(0n, 100)).toBeNull();
    expect(minOut(-5n, 100)).toBeNull();
    expect(minOut(10_000n, 10_000)).toBeNull();
    expect(minOut(10_000n, -1)).toBeNull();
    expect(minOut(10_000n, 1.5)).toBeNull();
  });
});

describe('acceptUsd', () => {
  it('lets through dollars with up to two decimals and nothing else', () => {
    const seen: string[] = [];
    for (const v of ['10', '$25', '7.5', '0.01', '', '1.234', 'abc', '1e5', '-3', '12345678']) acceptUsd(v, (s) => seen.push(s));
    expect(seen).toEqual(['10', '25', '7.5', '0.01', '']);
  });
});
