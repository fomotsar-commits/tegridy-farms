import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { publishFieldPools, resetField, setFieldHot, setFieldView, useFieldHot, useFieldPools, useFieldView, type FieldPool } from './fieldStore';
import { fieldPoolsOf } from './fieldPools';
import { buildPool, key, viewOf } from './testkit.fixture';
import { BAYLA_MINT, WSOL_MINT } from './tokenSafety';

const pool = (address: string, usd: number | null): FieldPool => ({ address, tokenMint: `${address}-mint`, name: 'BAYLA/SOL', usd });

beforeEach(() => resetField());

describe('the pool store: what All pools read, handed to the drawing without a second read', () => {
  it('holds nothing until a list lands: the drawing keeps to the registry, dry', () => {
    const { result } = renderHook(() => useFieldPools());
    expect(result.current).toBeNull();
  });

  it('hands every subscriber the list as it lands, and nothing again for the same list', () => {
    const { result } = renderHook(() => useFieldPools());
    const first = [pool('A', 14_524), pool('B', null)];
    act(() => publishFieldPools(first));
    expect(result.current).toEqual(first);
    const same = result.current;
    act(() => publishFieldPools([pool('A', 14_524), pool('B', null)]));
    expect(result.current).toBe(same);
    act(() => publishFieldPools([pool('A', 14_600), pool('B', null)]));
    expect(result.current![0]!.usd).toBe(14_600);
    act(() => publishFieldPools(null));
    expect(result.current).toBeNull();
  });

  it('says which pool a pointer is on, and none when it leaves', () => {
    const { result } = renderHook(() => useFieldHot());
    act(() => setFieldHot('A'));
    expect(result.current).toBe('A');
    act(() => setFieldHot(null));
    expect(result.current).toBeNull();
  });

  it("keeps a row's View until its own undo, and an old undo leaves a newer View standing", () => {
    const { result } = renderHook(() => useFieldView());
    const one = vi.fn();
    const two = vi.fn();
    let undoOne = () => {};
    let undoTwo = () => {};
    act(() => { undoOne = setFieldView(one); });
    expect(result.current).toBe(one);
    act(() => { undoTwo = setFieldView(two); });
    act(() => undoOne());
    expect(result.current).toBe(two);
    act(() => undoTwo());
    expect(result.current).toBeNull();
  });
});

describe("the list's pools as the drawing names and fills them", () => {
  const bayla = viewOf(buildPool({ plain: true, mint: new PublicKey(BAYLA_MINT), configIndex: 1, quoteReserve: 30n * 10n ** 9n, tokenReserve: 1_000n * 10n ** 6n }), { sol: 30n * 10n ** 9n, tok: 1_000n * 10n ** 6n });
  const corn = viewOf(buildPool({ plain: true, mint: key(), configIndex: 1, quoteReserve: 10n * 10n ** 9n, tokenReserve: 1_000n * 10n ** 6n }), { sol: 10n * 10n ** 9n, tok: 1_000n * 10n ** 6n });

  it('gives no dollars at all when the prices were not read', () => {
    const drawn = fieldPoolsOf([bayla, corn], null, new Map());
    expect(drawn.map((p) => p.usd)).toEqual([null, null]);
    expect(drawn.map((p) => p.address)).toEqual([bayla.address, corn.address]);
  });

  it('gives a pool its dollars only when both its coins were priced', () => {
    const usd = new Map([[WSOL_MINT, 150], [BAYLA_MINT, 2]]);
    const [b, c] = fieldPoolsOf([bayla, corn], usd, new Map());
    expect(b!.usd).toBeCloseTo(30 * 150 + 1_000 * 2, 6);
    expect(c!.usd).toBeNull();
  });

  it('names each pair as its row does: our coin by its symbol, any other by its short address', () => {
    const [b, c] = fieldPoolsOf([bayla, corn], null, new Map());
    expect(b!.name).toBe('BAYLA/SOL');
    expect(c!.name).toBe(`${corn.tokenMint.slice(0, 4)}…${corn.tokenMint.slice(-4)}/SOL`);
  });
});
