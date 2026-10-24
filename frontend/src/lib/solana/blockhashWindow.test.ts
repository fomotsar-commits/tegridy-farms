// Can a transaction still land? Read from its own blockhash (2026-10-14). A server that never
// saw the blockhash also says "not valid", so a "gone" counts only from a server at or past
// the confirmed slot where it was seen valid.
import { describe, it, expect, vi } from 'vitest';
import { blockhashGone, blockhashSeen, recentBlockhashOf } from './blockhashWindow';

const HASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const rpcAnswering = (answer: unknown) => ({ isBlockhashValid: vi.fn(async () => answer) }) as never;

describe('blockhashSeen', () => {
  it('valid at a confirmed slot: kept with that slot', async () => {
    const rpc = rpcAnswering({ context: { slot: 77 }, value: true });
    expect(await blockhashSeen(rpc, HASH)).toEqual({ hash: HASH, validAt: 77 });
  });

  it('not valid, unread, or not a blockhash: nothing is kept', async () => {
    expect(await blockhashSeen(rpcAnswering({ context: { slot: 77 }, value: false }), HASH)).toBeNull();
    expect(await blockhashSeen({ isBlockhashValid: async () => { throw new Error('503'); } } as never, HASH)).toBeNull();
    expect(await blockhashSeen(rpcAnswering({ context: { slot: 77 }, value: true }), 'not a hash')).toBeNull();
    expect(await blockhashSeen({} as never, HASH)).toBeNull();
  });
});

describe('blockhashGone', () => {
  const bh = { hash: HASH, validAt: 100 };

  it('asks a server at or past the slot it was seen valid at', async () => {
    const rpc = { isBlockhashValid: vi.fn(async () => ({ context: { slot: 150 }, value: false })) };
    expect(await blockhashGone(rpc as never, bh)).toEqual({ gone: 150 });
    expect(rpc.isBlockhashValid).toHaveBeenCalledWith(HASH, { commitment: 'confirmed', minContextSlot: 100 });
  });

  it('still valid is "live"', async () => {
    expect(await blockhashGone(rpcAnswering({ context: { slot: 150 }, value: true }), bh)).toBe('live');
  });

  it('"not valid" from a server behind that slot proves nothing', async () => {
    expect(await blockhashGone(rpcAnswering({ context: { slot: 99 }, value: false }), bh)).toBeNull();
    expect(await blockhashGone(rpcAnswering({ value: false }), bh)).toBeNull();
  });

  it('a read that throws is unread, never gone', async () => {
    expect(await blockhashGone({ isBlockhashValid: async () => { throw new Error('Minimum context slot has not been reached'); } } as never, bh)).toBeNull();
  });
});

describe('recentBlockhashOf', () => {
  it('reads the built transaction’s blockhash, or null', () => {
    expect(recentBlockhashOf({ message: { recentBlockhash: HASH } })).toBe(HASH);
    expect(recentBlockhashOf({})).toBeNull();
    expect(recentBlockhashOf(null)).toBeNull();
  });
});
