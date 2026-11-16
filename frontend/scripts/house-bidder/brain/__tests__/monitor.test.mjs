// @vitest-environment node
//
// The fill monitor (BUILD-SPEC 3.5 step 5): who sold into the house bid, who held the token in
// the last 90 days, whether the seller is an EIP-7702 delegate, and OpenSea's flags.
import { describe, it, expect } from 'vitest';
import { checkFill, counterpartySets } from '../monitor.mjs';
import { BUILT_IN_INSIDERS, VENUE_CONTRACTS } from '../constants.mjs';
import { fakeChain, fakeOpenSea, milli } from '../../exec/__tests__/fakes.mjs';

const NOW = 1_794_800_000;
const DAY = 86_400;
const HOUSE = '0x2222222222222222222222222222222222222222';
const INSIDER = '0x5555555555555555555555555555555555555555';
const STRANGER = '0x3333333333333333333333333333333333333333';
const FUNDING = '0x1111111111111111111111111111111111111111';
const TX = `0x${'aa'.repeat(32)}`;

const sets = counterpartySets({ insiders: { wallets: [{ address: INSIDER, who: 'team' }], contracts: [] }, house: HOUSE, fundingWallet: FUNDING });
const fill = (over = {}) => ({ txHash: TX, block: 1, time: NOW, orderHash: `0x${'01'.repeat(32)}`, slug: 'junglebay', tokenId: '1797', unitPriceWei: milli(35), seller: STRANGER, fulfiller: STRANGER, ...over });
const run = (f, { chain = fakeChain(), opensea = fakeOpenSea(), skip = [] } = {}) => checkFill(f, { sets, chain, opensea, nowSec: NOW, skip });

describe('who sold into the house bid', () => {
  it('passes an ordinary seller', async () => {
    const r = await run(fill());
    expect(r.verdict).toBe('ok');
    expect(r.integrity).toEqual([]);
    expect(r.passed.sort()).toEqual(['code', 'item', 'provenance']);
  });

  it('halts on an insider seller, and on an insider who only sent the transaction', async () => {
    expect((await run(fill({ seller: INSIDER }))).integrity.map((i) => i.reason)).toContain('insider-fill');
    const viaFulfiller = await run(fill({ fulfiller: INSIDER }));
    expect(viaFulfiller.verdict).toBe('halt');
    expect(viaFulfiller.integrity.map((i) => i.reason)).toEqual(['insider-fill']);
  });

  it('halts on a built-in insider even when insiders.json does not list them', async () => {
    const r = await checkFill(fill({ seller: BUILT_IN_INSIDERS[1] }), { sets: counterpartySets({ insiders: { wallets: [], contracts: [] }, house: HOUSE }), chain: fakeChain(), opensea: fakeOpenSea(), nowSec: NOW });
    expect(r.integrity.map((i) => i.reason)).toEqual(['insider-fill']);
  });

  it('halts on the funding wallet, a venue contract and a house wallet', async () => {
    expect((await run(fill({ seller: FUNDING }))).integrity.map((i) => i.reason)).toEqual(['insider-fill']);
    expect((await run(fill({ seller: VENUE_CONTRACTS[1] }))).integrity.map((i) => i.reason)).toEqual(['venue-contract-fill']);
    expect((await run(fill({ seller: HOUSE }))).integrity.map((i) => i.reason)).toEqual(['house-fill']);
  });
});

describe('the token’s last 90 days', () => {
  it('halts when an insider held or passed the token within 90 days', async () => {
    const chain = fakeChain({ provenance: { 1797: [{ from: INSIDER, to: STRANGER, txHash: `0x${'bb'.repeat(32)}`, time: NOW - 10 * DAY }] } });
    const r = await run(fill(), { chain });
    expect(r.verdict).toBe('halt');
    expect(r.integrity.map((i) => i.reason)).toEqual(['insider-provenance']);
  });

  it('looks only at the token’s past up to the fill: the house later returning it to the funding wallet is not an insider', async () => {
    const chain = fakeChain({ provenance: { 1797: [{ from: STRANGER, to: HOUSE, txHash: TX, time: NOW }, { from: HOUSE, to: FUNDING, txHash: `0x${'cc'.repeat(32)}`, time: NOW + 3600 }] } });
    expect((await run(fill(), { chain })).verdict).toBe('ok');
  });

  it('ignores an insider older than 90 days', async () => {
    const chain = fakeChain({ provenance: { 1797: [{ from: INSIDER, to: STRANGER, txHash: `0x${'bb'.repeat(32)}`, time: NOW - 91 * DAY }] } });
    expect((await run(fill(), { chain })).verdict).toBe('ok');
  });

  it('notes a venue contract in the history for a person, without halting (staking and loans hold holders’ tokens)', async () => {
    const chain = fakeChain({ provenance: { 1797: [{ from: VENUE_CONTRACTS[3], to: STRANGER, txHash: `0x${'bb'.repeat(32)}`, time: NOW - DAY }] } });
    const r = await run(fill(), { chain });
    expect(r.verdict).toBe('review');
    expect(r.findings.map((f) => f.code)).toEqual(['venue-contract-provenance']);
  });

  it('retries when the history cannot be read, and never takes that as a pass', async () => {
    const chain = fakeChain({ provenance: { 1797: new Error('rpc down') } });
    const r = await run(fill(), { chain });
    expect(r.pending).toEqual(['provenance']);
    expect(r.passed).not.toContain('provenance');
  });
});

describe('the seller’s code and OpenSea’s flags', () => {
  it('notes an EIP-7702 delegation for review, without halting', async () => {
    const chain = fakeChain({ code: { [STRANGER]: `0xef0100${'12'.repeat(20)}` } });
    const r = await run(fill(), { chain });
    expect(r.verdict).toBe('review');
    expect(r.findings[0].code).toBe('seller-7702');
  });

  it('halts and quarantines an item OpenSea flags, disabled or suspicious', async () => {
    for (const flag of [{ isDisabled: true, isSuspicious: false }, { isDisabled: false, isSuspicious: true }]) {
      const r = await run(fill(), { opensea: fakeOpenSea({ items: { 1797: { ...flag, owner: HOUSE } } }) });
      expect(r.verdict).toBe('halt');
      expect(r.stolen).toBe(true);
      expect(r.integrity.map((i) => i.reason)).toEqual(['flagged-item']);
    }
  });

  it('retries an item check that fails, and skips checks already passed', async () => {
    const r = await run(fill(), { opensea: fakeOpenSea({ items: { 1797: new Error('429') } }) });
    expect(r.pending).toEqual(['item']);
    expect(r.verdict).toBe('ok');
    const calls = [];
    await run(fill(), { chain: fakeChain({ calls }), skip: ['provenance', 'code'] });
    expect(calls.map((c) => c[0])).toEqual([]);
  });
});
