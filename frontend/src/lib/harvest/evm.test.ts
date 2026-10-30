// Harvest on Ethereum and Base: what one pool's reads come to. The rules are the pool
// card's (EvmLadderPoolLive): an unread amount is never a zero, a pool that does not
// stake its room's coin is not that coin's, and a claim the vault cannot pay is not sent.
import { describe, it, expect } from 'vitest';
import { BUNGALOWS } from '../bungalows';
import { evmHarvestRooms, planEvmPool, type EvmHarvestRoom } from './evm';

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
