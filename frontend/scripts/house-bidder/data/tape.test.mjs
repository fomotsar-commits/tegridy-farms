// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildTape, dropCounts, saleKind } from './tape.mjs';
import { BLUR_POOL, NATIVE, WETH } from './constants.mjs';

const ETH = 10n ** 18n;
const DAY = 86_400;
const NOW = 1_800_000_000;
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const HOUSE = addr(0xa0);
const INSIDER = addr(0xb0);
const VENUE_CONTRACT = addr(0xb1);
let tx = 0;
/** A sale `daysAgo` before NOW at `eth` (a decimal string of ETH), paid in WETH unless told otherwise. */
function sale({ daysAgo = 1, eth = '1', seller = addr(1), buyer = addr(2), token = String(++tx), pay = WETH, at } = {}) {
  const [whole, frac = ''] = eth.split('.');
  const priceWei = BigInt(whole) * ETH + BigInt((frac + '0'.repeat(18)).slice(0, 18));
  return { txHash: `0x${(++tx).toString(16).padStart(64, '0')}`, time: at ?? NOW - Math.round(daysAgo * DAY), tokenId: token, priceWei, paymentToken: pay, seller, buyer, orderHash: null };
}
/** Five ordinary sales at 1 ETH over the 10 days before `daysAgo`, from five sellers: a market to judge against. */
const market = (daysAgo = 0) => [1, 2, 3, 4, 5].map((k) => sale({ daysAgo: daysAgo + k * 2, eth: '1', seller: addr(100 + k), buyer: addr(200 + k) }));
const reasonOf = (tape, s) => tape.dropped.find((d) => d.sale.txHash === s.txHash)?.reason ?? (tape.kept.some((k) => k.txHash === s.txHash) ? 'kept' : 'missing');

describe('buildTape: identity and wash filters', () => {
  it('drops a self-trade (seller is the buyer)', () => {
    const wash = sale({ seller: addr(9), buyer: addr(9) });
    const tape = buildTape([...market(), wash], { now: NOW });
    expect(reasonOf(tape, wash)).toBe('self-trade');
  });

  it('drops both legs of an A -> B -> A round trip of one token within 30 days', () => {
    const a = addr(11);
    const b = addr(12);
    const out = sale({ daysAgo: 20, seller: a, buyer: b, token: '777' });
    const back = sale({ daysAgo: 5, seller: b, buyer: a, token: '777' });
    const tape = buildTape([...market(), out, back], { now: NOW });
    expect(reasonOf(tape, out)).toBe('round-trip-30d');
    expect(reasonOf(tape, back)).toBe('round-trip-30d');
  });

  it('keeps a token that comes back after more than 30 days, and a chain A -> B -> C', () => {
    const a = addr(21);
    const b = addr(22);
    const out = sale({ daysAgo: 40, seller: a, buyer: b, token: '888' });
    const back = sale({ daysAgo: 8, seller: b, buyer: a, token: '888' });
    const c1 = sale({ daysAgo: 6, seller: addr(31), buyer: addr(32), token: '999' });
    const c2 = sale({ daysAgo: 3, seller: addr(32), buyer: addr(33), token: '999' });
    const tape = buildTape([...market(), out, back, c1, c2], { now: NOW });
    for (const s of [out, back, c1, c2]) expect(reasonOf(tape, s)).toBe('kept');
  });

  it('drops a sale where the house is the buyer or the seller', () => {
    const bought = sale({ buyer: HOUSE });
    const sold = sale({ seller: HOUSE.toUpperCase().replace('0X', '0x') });
    const tape = buildTape([...market(), bought, sold], { houseWallets: [HOUSE], now: NOW });
    expect(reasonOf(tape, bought)).toBe('house');
    expect(reasonOf(tape, sold)).toBe('house');
  });

  it('drops a sale touching an insider wallet or a venue contract, read from insiders.json itself', () => {
    const insiders = { version: 1, wallets: [{ address: INSIDER, who: 'a team wallet' }], contracts: [VENUE_CONTRACT] };
    const byInsider = sale({ seller: INSIDER });
    const byContract = sale({ buyer: VENUE_CONTRACT });
    const tape = buildTape([...market(), byInsider, byContract], { insiderWallets: insiders, now: NOW });
    expect(reasonOf(tape, byInsider)).toBe('insider');
    expect(reasonOf(tape, byContract)).toBe('insider');
  });

  it('reports an identity reason first and lists every rule a sale broke', () => {
    const s = sale({ seller: HOUSE, buyer: HOUSE });
    const tape = buildTape([s], { houseWallets: [HOUSE], now: NOW });
    expect(tape.dropped[0].reason).toBe('house');
    expect(tape.dropped[0].reasons).toEqual(['house', 'self-trade']);
  });

  it('refuses a malformed insider entry instead of skipping it', () => {
    expect(() => buildTape([], { insiderWallets: ['0x1234'], now: NOW })).toThrow(TypeError);
  });

  it('drops a sale paid in a token whose amounts are not ETH wei', () => {
    const usdc = sale({ pay: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' });
    const tape = buildTape([...market(), usdc], { now: NOW });
    expect(reasonOf(tape, usdc)).toBe('currency');
  });
});

describe('buildTape: tails against the 14-day median before each sale', () => {
  it('drops a sale under 0.67x the median and keeps one just above it', () => {
    const low = sale({ daysAgo: 0.5, eth: '0.66' });
    const ok = sale({ daysAgo: 0.4, eth: '0.68' });
    const tape = buildTape([...market(1), low, ok], { now: NOW });
    expect(reasonOf(tape, low)).toBe('tail-low');
    expect(reasonOf(tape, ok)).toBe('kept');
  });

  it('drops a sale over 1.5x the median and keeps one just under it', () => {
    const high = sale({ daysAgo: 0.5, eth: '1.51' });
    const ok = sale({ daysAgo: 0.4, eth: '1.49' });
    const tape = buildTape([...market(1), high, ok], { now: NOW });
    expect(reasonOf(tape, high)).toBe('tail-high');
    expect(reasonOf(tape, ok)).toBe('kept');
  });

  it('judges a sale only by sales strictly before it: a batch dumped in one block cannot vouch for itself', () => {
    const prior = [1, 2, 3].map((k) => sale({ daysAgo: k, eth: '1', seller: addr(300 + k) }));
    const at = NOW - 3_600;
    const dump = [0, 1, 2, 3, 4].map((k) => sale({ at, eth: '0.5', seller: addr(400), buyer: addr(500 + k) }));
    const tape = buildTape([...prior, ...dump], { now: NOW });
    for (const s of dump) expect(reasonOf(tape, s)).toBe('tail-low');
  });

  it('only counts the 14 days before the sale', () => {
    const old = [15, 16, 17, 18].map((k) => sale({ daysAgo: k + 1, eth: '1' }));
    const s = sale({ daysAgo: 1, eth: '0.3' });
    const tape = buildTape([...old, s], { now: NOW });
    // The 1 ETH sales are 15+ days before it: no median, so it stands.
    expect(reasonOf(tape, s)).toBe('kept');
  });

  it('needs 3 earlier sales before it judges a tail', () => {
    const two = [2, 3].map((k) => sale({ daysAgo: k, eth: '1' }));
    const s = sale({ daysAgo: 1, eth: '5' });
    const tape = buildTape([...two, s], { now: NOW });
    expect(reasonOf(tape, s)).toBe('kept');
  });

  it('leaves washed and insider sales out of the median', () => {
    // Five wash prints at 3 ETH would lift the median to 2 ETH and make an honest 0.9 ETH sale look
    // like a crash print. They are dropped first, so the median stays 1 ETH and the sale stands.
    const washes = [1, 2, 3, 4, 5].map((k) => sale({ daysAgo: 1 + k / 10, eth: '3', seller: addr(600), buyer: addr(600) }));
    const s = sale({ daysAgo: 0.5, eth: '0.9' });
    const tape = buildTape([...market(1), ...washes, s], { now: NOW });
    expect(reasonOf(tape, s)).toBe('kept');
    expect(tape.dropped.filter((d) => d.reason === 'self-trade')).toHaveLength(5);
  });
});

describe('buildTape: kind, time and shape', () => {
  it('marks WETH and BETH sales as bids and ETH sales as listings', () => {
    expect(saleKind(WETH)).toBe('bid');
    expect(saleKind(BLUR_POOL)).toBe('bid');
    expect(saleKind(NATIVE)).toBe('listing');
    const tape = buildTape([sale({ pay: NATIVE }), sale({ pay: WETH })], { now: NOW });
    expect(tape.kept.map((s) => s.kind).sort()).toEqual(['bid', 'listing']);
  });

  it('ignores sales after now (a backtest must not see the future) and returns oldest first', () => {
    const future = sale({ at: NOW + 10 });
    const a = sale({ daysAgo: 2 });
    const b = sale({ daysAgo: 3 });
    const tape = buildTape([future, a, b], { now: NOW * 1000 });
    expect(tape.kept.map((s) => s.txHash)).toEqual([b.txHash, a.txHash]);
    expect(tape.dropped).toHaveLength(0);
  });

  it('refuses a sale without seller and buyer addresses', () => {
    expect(() => buildTape([{ ...sale(), seller: 'nobody' }], { now: NOW })).toThrow(TypeError);
  });

  it('counts drops by first reason', () => {
    const tape = buildTape([sale({ seller: addr(5), buyer: addr(5) }), sale({ buyer: HOUSE })], { houseWallets: [HOUSE], now: NOW });
    expect(dropCounts(tape)).toMatchObject({ 'self-trade': 1, house: 1, insider: 0 });
  });
});
