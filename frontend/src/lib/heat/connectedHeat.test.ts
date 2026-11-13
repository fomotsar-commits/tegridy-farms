// One hand can hold two wallets (the owner's phone, 2026-11-11): which connected wallet the card
// and Bayla's line speak from, every row, and that a page asks once however many ask at a time.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HeatReading } from './heatOracle';

const h = vi.hoisted(() => ({ fetchHeat: vi.fn() }));
vi.mock('./heatClient', () => ({ fetchHeat: (...args: unknown[]) => h.fetchHeat(...args) }));

import { warmestConnected, warmestOf } from './connectedHeat';

const SOL = '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw';
const EVM = '0x71be63f3384f5fb98995898a86b02fb2426c5788';

function reading(address: string, degrees: number): HeatReading {
  return {
    address,
    degrees,
    tier: degrees >= 800 ? 'Elder' : degrees >= 80 ? 'Resident' : degrees >= 30 ? 'Observer' : 'Drifter',
    isCold: degrees === 0,
    heldSinceUnix: degrees === 0 ? null : 1_642_281_378,
    asOfUnix: degrees === 0 ? null : 1_762_000_000,
    tokenCount: degrees === 0 ? 0 : 3,
    breakdown: [],
    observedAt: 1_762_000_000,
    xHandle: null,
    daysToNextTier: null,
    daysToPlant: null,
  };
}
const answers = (table: Record<string, number | Error>) => async (address: string) => {
  const a = table[address];
  if (a instanceof Error) throw a;
  return reading(address, a ?? 0);
};
const down = new Error('The instrument is unreachable.');

describe('warmestOf: the connected wallet the venue speaks from', () => {
  it.each([
    ['the owner’s phone: a Solana wallet at Elder, an Ethereum account that holds nothing', { [SOL]: 1862.42, [EVM]: 0 }, SOL],
    ['the other way round: the coins are on the Ethereum account', { [SOL]: 0, [EVM]: 412.5 }, EVM],
    ['both warm: the warmer', { [SOL]: 81, [EVM]: 300 }, EVM],
    ['both warm and level: the first asked', { [SOL]: 95, [EVM]: 95 }, SOL],
    ['both cold: the first asked', { [SOL]: 0, [EVM]: 0 }, SOL],
    ['one could not be asked, the other is warm: the warm one', { [SOL]: down, [EVM]: 95 }, EVM],
    ['one could not be asked, the other is cold: the one not asked, never the cold one', { [SOL]: down, [EVM]: 0 }, SOL],
    ['the same, the other way round', { [SOL]: 0, [EVM]: down }, EVM],
    ['neither could be asked: the first', { [SOL]: down, [EVM]: down }, SOL],
  ] as const)('%s', async (_name, table, speaks) => {
    expect(await warmestOf([SOL, EVM], answers(table))).toBe(speaks);
  });

  it('a reading marked cold counts as zero whatever degrees ride on it', async () => {
    const read = async (address: string) => ({ ...reading(address, address === SOL ? 12 : 5), isCold: address === SOL });
    expect(await warmestOf([SOL, EVM], read)).toBe(EVM);
  });

  it('one wallet is itself, read or not', async () => {
    expect(await warmestOf([EVM], answers({ [EVM]: 0 }))).toBe(EVM);
    expect(await warmestOf([EVM], answers({ [EVM]: down }))).toBe(EVM);
  });
});

describe('warmestConnected: asked once while it is in flight', () => {
  beforeEach(() => h.fetchHeat.mockReset());

  it('two askers at once share one read of each wallet, and a later asker reads again', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    h.fetchHeat.mockImplementation(async (address: string) => {
      await held;
      return reading(address, address === SOL ? 1862.42 : 0);
    });
    const card = warmestConnected([SOL, EVM]);
    const line = warmestConnected([SOL, EVM]);
    expect(h.fetchHeat).toHaveBeenCalledTimes(2);
    release();
    expect(await card).toBe(SOL);
    expect(await line).toBe(SOL);
    await warmestConnected([SOL, EVM]);
    expect(h.fetchHeat).toHaveBeenCalledTimes(4);
  });
});
