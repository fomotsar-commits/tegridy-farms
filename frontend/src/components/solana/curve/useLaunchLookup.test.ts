// The read-only "Look up a launch". What it costs to open a launch depends on the
// mint (the treasury's token account for THAT mint may or may not exist), so one
// mint's cost must never sit beside another mint's facts, even for the moment the
// second cost read is still in flight.
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import type { CreateLaunchCost, LaunchState, MintFacts, Read } from '../../../lib/launcher/solana/curve';
import { useLaunchLookup, type LaunchLookupReaders } from './useLaunchLookup';

const A = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
const B = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
const RECIPIENT = new PublicKey(new Uint8Array(32).fill(3));

const stateFor = (mint: string) =>
  ({ phase: { kind: 'pre-launch' }, paused: false, ammConfigured: true, global: { feeRecipient: RECIPIENT }, curve: null, mint }) as unknown as LaunchState;
const facts: Read<MintFacts> = {
  kind: 'ok',
  value: { supply: 0n, decimals: 9, mintAuthority: 'creator', freezeAuthority: null, isLegacySplToken: true },
};
const costOf = (treasuryToken: bigint): Read<CreateLaunchCost> => ({
  kind: 'ok',
  value: { curve: 1n, vault: 1n, treasuryToken, treasuryTokenExists: treasuryToken === 0n, total: 2n + treasuryToken },
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('useLaunchLookup', () => {
  it("clears the last mint's cost as soon as a new lookup starts, and shows the new one when it arrives", async () => {
    const pendingCost = new Map<string, ReturnType<typeof deferred<Read<CreateLaunchCost>>>>();
    const readers: LaunchLookupReaders = {
      launch: async (k) => stateFor(k.toBase58()),
      mint: async () => facts,
      cost: (k) => {
        const d = deferred<Read<CreateLaunchCost>>();
        pendingCost.set(k.toBase58(), d);
        return d.promise;
      },
    };
    const { result } = renderHook(() => useLaunchLookup(readers));

    let first!: Promise<void>;
    act(() => {
      first = result.current.lookUp(A);
    });
    await waitFor(() => expect(pendingCost.has(A)).toBe(true));
    await act(async () => {
      pendingCost.get(A)?.resolve(costOf(0n));
      await first;
    });
    expect(result.current.createCost).toEqual(costOf(0n));

    // Mint B: its facts arrive, its cost read is still open.
    let second!: Promise<void>;
    act(() => {
      second = result.current.lookUp(B);
    });
    await waitFor(() => expect(pendingCost.has(B)).toBe(true));
    expect((result.current.snapshot as unknown as { mint: string }).mint).toBe(B);
    // Never A's figure beside B's facts.
    expect(result.current.createCost).toBeNull();

    await act(async () => {
      pendingCost.get(B)?.resolve(costOf(1_488_440n));
      await second;
    });
    expect(result.current.createCost).toEqual(costOf(1_488_440n));
    expect(result.current.loading).toBe(false);
  });

  it('an older lookup that answers late does not overwrite the newer one', async () => {
    const slowA = deferred<LaunchState>();
    const readers: LaunchLookupReaders = {
      launch: (k) => (k.toBase58() === A ? slowA.promise : Promise.resolve(stateFor(B))),
      mint: async () => facts,
      cost: async (k) => costOf(k.toBase58() === A ? 0n : 7n),
    };
    const { result } = renderHook(() => useLaunchLookup(readers));
    let a!: Promise<void>;
    act(() => {
      a = result.current.lookUp(A);
    });
    await act(async () => {
      await result.current.lookUp(B);
    });
    await act(async () => {
      slowA.resolve(stateFor(A));
      await a;
    });
    expect((result.current.snapshot as unknown as { mint: string }).mint).toBe(B);
    expect(result.current.createCost).toEqual(costOf(7n));
    expect(result.current.loading).toBe(false);
  });
});
