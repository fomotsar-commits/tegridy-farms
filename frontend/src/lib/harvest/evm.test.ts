// Harvest on Ethereum and Base: what one pool's reads come to. The rules are the pool
// card's (EvmLadderPoolLive): an unread amount is never a zero, a pool that does not
// stake its room's coin is not that coin's, and a claim the vault cannot pay is not sent.
import { describe, it, expect, vi } from 'vitest';
import { BUNGALOWS } from '../bungalows';
import { evmHarvestRooms, planEvmPool, receiptResult, sendCallsTogether, type EvmClaim, type EvmHarvestRoom } from './evm';
import type { ClaimResult } from './types';

const rooms = evmHarvestRooms();
const pepe = rooms.find((b) => b.id === 'pepe')!;
const qr = rooms.find((b) => b.id === 'qr')!;
const ok = (room: EvmHarvestRoom, over: Partial<Parameters<typeof planEvmPool>[1]> = {}) =>
  planEvmPool(room, { earnedRaw: 5n * 10n ** 18n, stakingToken: room.address, rewardsToken: room.address, surplusRaw: 10n ** 24n, decimals: 18, ...over });

describe('which pools Harvest reads on Ethereum and Base', () => {
  it('every live Ethereum and Base room with a pool, and no other', () => {
    const want = BUNGALOWS.filter((b) => b.live && (b.chain === 'ethereum' || b.chain === 'base') && b.stakePool && b.address).map((b) => b.id);
    expect(rooms.map((b) => b.id)).toEqual(want);
    expect(rooms.length).toBeGreaterThan(0);
    // TOWELI's classic farm has no stakePool: its claim can extend a lock, so it is not swept up here.
    expect(rooms.some((b) => b.id === 'toweli')).toBe(false);
  });
});

describe('planEvmPool', () => {
  it('a read amount above zero is one claim on that pool, on its own chain', () => {
    const p = ok(qr);
    expect(p.claims).toHaveLength(1);
    expect(p.claims[0]).toMatchObject({ chain: 'base', chainId: 8453, pool: qr.stakePool, symbol: 'QR', amountRaw: 5n * 10n ** 18n, caution: null });
    expect(ok(pepe).claims[0]).toMatchObject({ chain: 'ethereum', chainId: 1 });
  });

  it('an unread amount is a pool not read, never nothing to claim', () => {
    const p = ok(pepe, { earnedRaw: null });
    expect(p.claims).toEqual([]);
    expect(p.unread).toHaveLength(1);
    expect(p.unread[0]!.what).toContain('PEPE');
  });

  it('zero earned is nothing at all', () => {
    expect(ok(pepe, { earnedRaw: 0n })).toEqual({ claims: [], held: [], unread: [] });
  });

  it('an empty reward vault is held, not sent: getReward would pay nothing and cost gas', () => {
    const p = ok(pepe, { surplusRaw: 0n });
    expect(p.claims).toEqual([]);
    expect(p.held[0]).toMatchObject({ amountRaw: 5n * 10n ** 18n });
    expect(p.held[0]!.reason).toMatch(/stays owed/);
  });

  it('a vault short of the amount is still sent, and says what it pays', () => {
    const p = ok(pepe, { surplusRaw: 2n * 10n ** 18n });
    expect(p.claims).toHaveLength(1);
    expect(p.claims[0]!.caution).toMatch(/holds 2 PEPE now/);
  });

  it('an unread vault is not a gate', () => {
    expect(ok(pepe, { surplusRaw: null }).claims[0]!.caution).toBeNull();
  });

  it('a plain pool, which has no rewardSurplus, claims on earned alone', () => {
    expect(planEvmPool(pepe, { earnedRaw: 1n, stakingToken: null, rewardsToken: null, decimals: 18 }).claims).toHaveLength(1);
  });

  it('a pool that stakes another coin is left alone, with no amount named in this coin', () => {
    const p = ok(pepe, { stakingToken: '0x000000000000000000000000000000000000dEaD' });
    expect(p.claims).toEqual([]);
    expect(p.held[0]!.amountRaw).toBeNull();
  });

  it('a pool that pays another coin is left alone', () => {
    const p = ok(pepe, { rewardsToken: '0x000000000000000000000000000000000000dEaD' });
    expect(p.claims).toEqual([]);
    expect(p.held[0]!.reason).toMatch(/another coin/);
  });

  it('addresses compare without case', () => {
    expect(ok(pepe, { stakingToken: pepe.address.toUpperCase().replace('0X', '0x'), rewardsToken: pepe.address.toLowerCase() }).claims).toHaveLength(1);
  });
});

describe('sendCallsTogether: one chain’s claims as one wallet_sendCalls', () => {
  const H1 = `0x${'1'.repeat(64)}` as const;
  const H2 = `0x${'2'.repeat(64)}` as const;
  const GET_REWARD = '0x3d18b912';
  const claimOf = (n: number): EvmClaim => ({
    key: `evm:${n}`, chain: 'base', chainId: 8453, pool: `0x${String(n).repeat(40)}` as `0x${string}`, roomId: `r${n}`, symbol: 'QR',
    where: 'lighthouse pool', detail: null, amountRaw: 1n, decimals: 18, caution: null,
  });

  /** The wallet: its answer to wallet_sendCalls, then each wallet_getCallsStatus in turn (the last repeats). */
  function walletOf(sent: () => unknown, statuses: unknown[]) {
    const asked: { method: string; params?: unknown[] }[] = [];
    let polls = 0;
    const provider = {
      request: vi.fn(async (a: { method: string; params?: unknown[] }) => {
        asked.push(a);
        if (a.method === 'wallet_sendCalls') return sent();
        if (a.method === 'wallet_getCallsStatus') {
          const s = statuses[Math.min(polls++, statuses.length - 1)];
          if (s instanceof Error) throw s;
          return s;
        }
        throw new Error(`unexpected ${a.method}`);
      }),
    };
    return { provider, asked };
  }
  /** Our own receipt reads: what the chain says, whatever the wallet said. */
  const clientOf = (receipts: Record<string, 'success' | 'reverted' | Error>) => ({
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: `0x${string}` }) => {
      const r = receipts[hash];
      if (r instanceof Error || r === undefined) throw r ?? new Error('not found');
      return { status: r, transactionHash: hash };
    }),
  });
  const settled = (status: unknown) => ({ status: 200, receipts: status });
  async function run(provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }, client: ReturnType<typeof clientOf>, claims = [claimOf(1), claimOf(2)]) {
    const got = new Map<string, ClaimResult>();
    const sleep = vi.fn(async () => {});
    const how = await sendCallsTogether({ provider, from: '0x00000000000000000000000000000000000000aa', client, sleep }, 8453)(claims, (k, r) => got.set(k, r));
    return { got, how, sleep };
  }

  it('one wallet_sendCalls, one getReward() per pool, no atomicRequired; each claim settled from its OWN receipt', async () => {
    const w = walletOf(() => ({ id: '0xbatch' }), [{ status: 100 }, settled([{ status: '0x1', transactionHash: H1 }, { status: '0x1', transactionHash: H2 }])]);
    const client = clientOf({ [H1]: 'success', [H2]: 'reverted' });
    const { got, how, sleep } = await run(w.provider, client);
    expect(how).toBe('done');
    const call = w.asked.filter((a) => a.method === 'wallet_sendCalls');
    expect(call).toHaveLength(1);
    expect(call[0]!.params![0]).toMatchObject({
      chainId: '0x2105', atomicRequired: false,
      calls: [{ to: claimOf(1).pool, data: GET_REWARD }, { to: claimOf(2).pool, data: GET_REWARD }],
    });
    expect(w.asked.filter((a) => a.method === 'wallet_getCallsStatus').map((a) => a.params)).toEqual([['0xbatch'], ['0xbatch']]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(got.get('evm:1')).toEqual({ kind: 'claimed', tx: H1 });
    // The wallet said success; the chain's receipt says reverted, and the receipt is what is told.
    expect(got.get('evm:2')).toEqual({ kind: 'reverted', reason: 'Refused on chain: nothing was claimed, and only the network fee was spent.', tx: H2 });
  });

  it('a wallet that ran them as one transaction: its receipt is read once, and they share its fate', async () => {
    const w = walletOf(() => '0xbatch', [settled([{ status: '0x0', transactionHash: H1 }])]);
    const client = clientOf({ [H1]: 'reverted' });
    const { got } = await run(w.provider, client);
    expect(client.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(got.get('evm:1')).toMatchObject({ kind: 'reverted', tx: H1 });
    expect(got.get('evm:2')).toMatchObject({ kind: 'reverted', tx: H1 });
  });

  it('a cancel in the wallet: every claim cancelled, and its status is never asked', async () => {
    const w = walletOf(() => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }, []);
    const { got, how } = await run(w.provider, clientOf({}));
    expect(how).toBe('done');
    expect([...got.values()]).toEqual([{ kind: 'declined' }, { kind: 'declined' }]);
    expect(w.asked.map((a) => a.method)).toEqual(['wallet_sendCalls']);
  });

  it('a wallet that will not take a batch sent nothing: each claim then goes on its own prompt', async () => {
    for (const code of [4200, 5700, 5710, 5740, 5750, 5760]) {
      const w = walletOf(() => { throw Object.assign(new Error('no'), { code }); }, []);
      const { got, how } = await run(w.provider, clientOf({}));
      expect(how).toBe('one-by-one');
      expect(got.size).toBe(0);
    }
    // Wrapped, as a connector may wrap it.
    const w = walletOf(() => { throw new Error('outer', { cause: { code: 4200 } }); }, []);
    expect((await run(w.provider, clientOf({}))).how).toBe('one-by-one');
  });

  it('any other wallet error may have sent them: not confirmed, and the run stops', async () => {
    const w = walletOf(() => { throw new Error('request timed out'); }, []);
    const { got } = await run(w.provider, clientOf({}));
    expect(got.get('evm:1')).toMatchObject({ kind: 'unconfirmed', stop: true, reason: expect.stringMatching(/did not send them \(request timed out\)/) });
  });

  it('the wallet says none of them ran: nothing claimed, and the run goes on', async () => {
    const w = walletOf(() => ({ id: '0xbatch' }), [{ status: 400 }]);
    const { got } = await run(w.provider, clientOf({}));
    expect(got.get('evm:1')).toEqual({ kind: 'unconfirmed', reason: 'Your wallet says it sent none of them, so nothing was claimed.' });
  });

  it('a status it cannot read, a status call that fails, or a batch still pending after two minutes: unknown, and the run stops', async () => {
    const unknown = { kind: 'unconfirmed', reason: 'Your wallet took them, but did not say how they ended. Check your wallet before claiming again.', stop: true };
    for (const statuses of [[{ status: 200, receipts: [{ status: '0x1', transactionHash: H1 }, { status: '0x1', transactionHash: H2 }, { status: '0x1', transactionHash: H2 }] }], [new Error('wallet_getCallsStatus is not supported')]]) {
      const w = walletOf(() => ({ id: '0xbatch' }), statuses);
      const { got } = await run(w.provider, clientOf({}));
      expect([...got.values()]).toEqual([unknown, unknown]);
    }
    const w = walletOf(() => ({ id: '0xbatch' }), [{ status: 100 }]);
    const { got, sleep } = await run(w.provider, clientOf({}));
    expect(sleep).toHaveBeenCalledTimes(40);
    expect([...got.values()]).toEqual([unknown, unknown]);
  });

  it('a call with no transaction, or a receipt it cannot read, is unknown and stops; the other claim still says what it came to', async () => {
    const w = walletOf(() => ({ id: '0xbatch' }), [settled([{ status: '0x1', transactionHash: H1 }, { status: '0x1' }])]);
    const { got } = await run(w.provider, clientOf({ [H1]: new Error('rpc down') }));
    expect(got.get('evm:1')).toMatchObject({ kind: 'unconfirmed', tx: H1, stop: true, reason: expect.stringMatching(/receipt could not be read/) });
    expect(got.get('evm:2')).toMatchObject({ kind: 'unconfirmed', stop: true });

    const ok2 = walletOf(() => ({ id: '0xbatch' }), [settled([{ status: '0x1', transactionHash: H1 }, { status: '0x1', transactionHash: H2 }])]);
    const r2 = await run(ok2.provider, clientOf({ [H1]: 'success', [H2]: new Error('rpc down') }));
    expect(r2.got.get('evm:1')).toEqual({ kind: 'claimed', tx: H1 });
    expect(r2.got.get('evm:2')).toMatchObject({ kind: 'unconfirmed', tx: H2, stop: true });
  });
});

describe('receiptResult', () => {
  const H = `0x${'a'.repeat(64)}` as const;
  const R = `0x${'b'.repeat(64)}` as const;
  it('a speed-up is claimed under its own hash; another call in its place did not claim', () => {
    expect(receiptResult({ kind: 'success', receipt: {}, replacement: { hash: R, reason: 'repriced' } }, H)).toEqual({ kind: 'claimed', tx: R });
    expect(receiptResult({ kind: 'replaced', receipt: {}, replacement: { hash: R, reason: 'cancelled' } }, H)).toMatchObject({ kind: 'unconfirmed', tx: H, stop: true });
    expect(receiptResult({ kind: 'unreadable', error: null }, H)).toMatchObject({ kind: 'unconfirmed', tx: H, stop: true });
  });
});
