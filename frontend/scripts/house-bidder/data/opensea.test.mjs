// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OpenSeaError, createOpenSeaClient, normalizeAccountOffer, normalizeBuild, normalizeCollection, normalizeItem, normalizeListing, normalizeSale, toWireParameters,
} from './opensea.mjs';
import { OPENSEA_CONDUIT_KEY, SEAPORT_16, SIGNED_ZONE, WETH } from './constants.mjs';

const fx = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), 'utf8'));
const KEY = 'test-only-opensea-key-0123456789';
const JBAC = '0xd37264c71e9af940e49795f0d3a8336afaafdda9';
const HOUSE = '0xbd00483ccb69c4fcc2f9f28e87fc29eeb308effa';
const HASH = `0x${'ab'.repeat(32)}`;
const SIG = `0x${'11'.repeat(65)}`;

/**
 * A client on a fake fetch and a fake clock. `route(url, init, n)` answers each request with
 * { status, body, headers } or throws. `sleep` moves the clock, so waiting is instant and exact.
 */
function harness({ route, budget = { readsPerMinute: 6, writesPerHour: 20 }, maxWaitMs = 0, minSpacingMs = 0 } = {}) {
  let clock = 1_800_000_000_000;
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, at: clock });
    const r = await route(url, init, calls.length);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  const client = createOpenSeaClient({
    apiKey: KEY, fetchImpl, budget, maxWaitMs, minSpacingMs, now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { client, calls, sleeps, advance: (ms) => (clock += ms), now: () => clock };
}
const itemRoute = () => ({ body: fx('opensea-item-junglebay.json') });
const errorOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
};

describe('normalizers on real OpenSea answers', () => {
  it('reads a collection: contract, fee lines in basis points, offer switches', () => {
    const j = normalizeCollection(fx('opensea-collection-junglebay.json'), 'junglebay');
    expect(j).toMatchObject({
      slug: 'junglebay', contract: JBAC, traitOffersEnabled: true, collectionOffersEnabled: true, isDisabled: false,
      requiredFees: [{ recipient: '0x0000a26b00c1f0df003000390027140000faa719', bps: 100 }],
      optionalFees: [{ recipient: '0xa3cc58eaa3800dc163726e031a2da49a9bb64eb3', bps: 700 }],
    });
    const g = normalizeCollection(fx('opensea-collection-gnssart.json'), 'gnssart');
    expect(g).toMatchObject({ traitOffersEnabled: false, optionalFees: [{ recipient: '0x209aa937ac59f60384a70b98fec5daf54ac7b967', bps: 500 }] });
  });

  it('refuses a collection answer about another slug, or a fee that is not whole basis points', () => {
    expect(() => normalizeCollection(fx('opensea-collection-junglebay.json'), 'gnssart')).toThrow(OpenSeaError);
    const odd = fx('opensea-collection-junglebay.json');
    odd.fees[0].fee = 1.234;
    expect(() => normalizeCollection(odd, 'junglebay')).toThrow(/basis points/);
  });

  it('reads a best listing: price a buyer pays, maker, times, zone, no taker', () => {
    const l = normalizeListing(fx('opensea-listings-junglebay.json').listings[0], 'fixture');
    expect(l).toMatchObject({
      orderHash: '0x376c285ea918fa858232cdf87b538a91541b8ffbc9f12ff117c82894458f371c', tokenId: '3033', priceWei: 49976000000000000n,
      maker: '0x1ff5d7d5fabcc6c7acfafc0372423651efb5a689', startTime: 1794777750, endTime: 1794778400, createdAt: 1794777751,
      protocol: SEAPORT_16, orderType: 2, zone: SIGNED_ZONE, taker: null, contract: JBAC, conduitKey: OPENSEA_CONDUIT_KEY, currency: 'ETH',
    });
  });

  it('names the buyer of a private listing', () => {
    const raw = structuredClone(fx('opensea-listings-junglebay.json').listings[0]);
    const buyer = '0x00000000000000000000000000000000000000b1';
    raw.protocol_data.parameters.consideration.push({ itemType: 2, token: JBAC, identifierOrCriteria: '3033', startAmount: '1', endAmount: '1', recipient: buyer });
    expect(normalizeListing(raw, 'fixture').taker).toBe(buyer);
  });

  it('refuses a listing without an order hash', () => {
    const raw = structuredClone(fx('opensea-listings-junglebay.json').listings[0]);
    delete raw.order_hash;
    const e = (() => {
      try {
        normalizeListing(raw, '/x');
      } catch (err) {
        return err;
      }
    })();
    expect(e).toBeInstanceOf(OpenSeaError);
    expect(e.kind).toBe('schema');
  });

  it('reads sales: per-unit wei, payment token, an order hash only when Seaport carried it', () => {
    const events = fx('opensea-sales-junglebay.json').asset_events;
    const first = normalizeSale(events[0], 'fixture');
    expect(first).toMatchObject({ txHash: '0xbf915f29b6bc837f7baba6517e4ac3cb0201c6a32484334224a4fb6ce5b7ee19', time: 1794728927, tokenId: '1797', priceWei: 37600000000000000n, paymentToken: WETH, seller: '0xe45f094ea6c763158f581a8d2f7fe190710c9f40', buyer: '0x101bb8d14cc1632a6973eca68f97ec4c5fc8c421', contract: JBAC });
    const noSeaport = events.find((e) => !e.order_hash);
    expect(normalizeSale(noSeaport, 'fixture').orderHash).toBe(null);
  });

  it('reads the build answer in wire format, addresses lowercased', () => {
    const b = normalizeBuild(fx('opensea-build16.json').junglebay.json);
    expect(b).toEqual({
      zone: SIGNED_ZONE, zoneHash: `0x${'0'.repeat(64)}`,
      consideration: [{ itemType: 4, token: JBAC, identifierOrCriteria: '0', startAmount: '1', endAmount: '1', recipient: '0x000000000000000000000000000000000000dead' }],
    });
  });

  it('reads an offer for 2: per-unit price, original quantity, what is left', () => {
    const o = normalizeAccountOffer(fx('opensea-offers-junglebay.json').offers[0], 'fixture');
    expect(o).toMatchObject({ slug: 'junglebay', priceWei: 34400000000000000n, totalWei: 68800000000000000n, qty: 2, remainingQty: 2 });
  });

  it('reads an NFT: OpenSea flags and its one owner', () => {
    expect(normalizeItem(fx('opensea-item-junglebay.json'), 'fixture')).toEqual({ isDisabled: false, isSuspicious: false, owner: '0x1ff5d7d5fabcc6c7acfafc0372423651efb5a689' });
    const flagged = fx('opensea-item-junglebay.json');
    flagged.nft.is_disabled = true;
    flagged.nft.owners = [];
    expect(normalizeItem(flagged, 'fixture')).toEqual({ isDisabled: true, isSuspicious: false, owner: null });
  });
});

describe('client: requests', () => {
  it('sends the key as a header only and never calls offers/collection or our proxy', async () => {
    const { client, calls } = harness({
      budget: { readsPerMinute: 100, writesPerHour: 100 },
      route: (url) => {
        if (url.includes('/collections/')) return { body: fx('opensea-collection-junglebay.json') };
        if (url.includes('/listings/')) return { body: fx('opensea-listings-junglebay.json') };
        if (url.includes('/events/')) return { body: { asset_events: [], next: null } };
        if (url.includes('/account/')) return { body: fx('opensea-account-offers.json') };
        if (url.includes('/orders/chain/') && url.endsWith('/cancel')) return { body: { last_signature_issued_valid_until: '0' } };
        if (url.endsWith(fx('opensea-get-order.json').order.order_hash)) return { body: fx('opensea-get-order.json') };
        if (url.includes('/nfts/')) return itemRoute();
        if (url.endsWith('/offers/build')) return { body: fx('opensea-build16.json').junglebay.json };
        if (url.endsWith('/offers')) return { body: { order_hash: HASH } };
        return { status: 404, body: {} };
      },
    });
    await client.collection('junglebay');
    await client.bestListings('junglebay');
    await client.saleEvents('junglebay', { afterSec: 1_700_000_000 });
    await client.accountOffers(HOUSE);
    await client.item(JBAC, '3033');
    await client.buildCollectionOffer({ offerer: HOUSE, slug: 'junglebay', qty: 1 });
    await client.cancelOffer({ orderHash: HASH, offererSignature: SIG });
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const c of calls) {
      expect(c.url.startsWith('https://api.opensea.io/api/v2/')).toBe(true);
      expect(c.url).not.toContain('/offers/collection/');
      expect(c.url).not.toContain(KEY);
      expect(c.init.headers['x-api-key']).toBe(KEY);
    }
  });

  it('builds a collection offer on Seaport 1.6 with offer protection, as OpenSea requires', async () => {
    const { client, calls } = harness({ route: () => ({ body: fx('opensea-build16.json').junglebay.json }) });
    await client.buildCollectionOffer({ offerer: HOUSE, slug: 'junglebay', qty: 2 });
    expect(calls[0].url).toBe('https://api.opensea.io/api/v2/offers/build');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      offerer: HOUSE, quantity: 2, criteria: { collection: { slug: 'junglebay' } },
      protocol_address: '0x0000000000000068F116a894984e2DB1123eB395', offer_protection_enabled: true,
    });
  });

  it('follows sale pages and stops once a page reaches afterSec, returning oldest first', async () => {
    const all = fx('opensea-sales-junglebay.json').asset_events; // newest first, as OpenSea sends them
    const pagesOf = [all.slice(0, 50), all.slice(50, 100), all.slice(100, 150), all.slice(150)];
    const afterSec = all[75].event_timestamp;
    const { client, calls } = harness({
      budget: { readsPerMinute: 100, writesPerHour: 100 },
      route: (url, _i, n) => ({ body: { asset_events: pagesOf[n - 1], next: n < 4 ? `cursor-${n + 1}` : null } }),
    });
    const sales = await client.saleEvents('junglebay', { afterSec, beforeSec: all[0].event_timestamp });
    expect(calls).toHaveLength(2);
    const q1 = new URL(calls[0].url).searchParams;
    expect(Object.fromEntries(q1)).toEqual({ event_type: 'sale', after: String(afterSec - 1), before: String(all[0].event_timestamp + 1), limit: '50' });
    expect(new URL(calls[1].url).searchParams.get('next')).toBe('cursor-2');
    const want = all.filter((e) => e.event_timestamp >= afterSec);
    expect(sales).toHaveLength(want.length);
    expect(sales[0].time).toBe(Math.min(...want.map((e) => e.event_timestamp)));
    expect(sales.every((s, i) => i === 0 || s.time >= sales[i - 1].time)).toBe(true);
  });

  it('leaves out a sale paid in a token that is not ETH, WETH or BETH', async () => {
    const ev = structuredClone(fx('opensea-sales-junglebay.json').asset_events.slice(0, 2));
    ev[0].payment = { quantity: '50000000', token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, symbol: 'USDC' };
    const { client } = harness({ route: () => ({ body: { asset_events: ev, next: null } }) });
    const sales = await client.saleEvents('junglebay', { afterSec: 1 });
    expect(sales).toHaveLength(1);
    expect(sales[0].txHash).toBe(ev[1].transaction);
  });

  it('completes account offers from the order route, since the list leaves the order out', async () => {
    const order = fx('opensea-get-order.json');
    const { client, calls } = harness({
      budget: { readsPerMinute: 100, writesPerHour: 100 },
      route: (url) => {
        if (url.includes('/account/')) return { body: fx('opensea-account-offers.json') };
        if (url.includes(order.order.order_hash)) return { body: order };
        return { status: 404, body: { errors: ['not found'] } };
      },
    });
    const offers = await client.accountOffers('0x3068e30a4ae02825ed5a51b0c070f04332642702');
    expect(new URL(calls[0].url).searchParams.get('chains')).toBe('ethereum');
    expect(calls[1].url).toBe(`https://api.opensea.io/api/v2/orders/chain/ethereum/protocol/${SEAPORT_16}/${order.order.order_hash}`);
    // The second listed offer is gone (404) and is left out.
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ orderHash: order.order.order_hash, slug: 'junglebay', priceWei: 26900000000000000n, totalWei: 80700000000000000n, qty: 3, remainingQty: 3, endTime: 1794792364 });
  });

  it('refuses an order answer that describes a different order than the one asked for', async () => {
    const { client } = harness({
      budget: { readsPerMinute: 100, writesPerHour: 100 },
      route: (url) => (url.includes('/account/') ? { body: fx('opensea-account-offers.json') } : { body: fx('opensea-get-order.json') }),
    });
    // The second listed offer is answered with the first one's order: that must not be believed.
    expect(await errorOf(client.accountOffers(HOUSE))).toMatchObject({ kind: 'schema' });
  });

  it('posts a criteria offer with the counter inside parameters and every number as a string', async () => {
    const { client, calls } = harness({ route: () => ({ body: { order_hash: HASH.toUpperCase().replace('0X', '0x') } }) });
    const parameters = {
      offerer: HOUSE, zone: SIGNED_ZONE, zoneHash: `0x${'0'.repeat(64)}`, conduitKey: OPENSEA_CONDUIT_KEY, orderType: 3,
      offer: [{ itemType: 1, token: WETH, identifierOrCriteria: 0n, startAmount: 70_000_000_000_000_000n, endAmount: 70_000_000_000_000_000n }],
      consideration: [
        { itemType: 4, token: JBAC, identifierOrCriteria: 0n, startAmount: 2n, endAmount: 2n, recipient: HOUSE },
        { itemType: 1, token: WETH, identifierOrCriteria: 0n, startAmount: 700_000_000_000_000n, endAmount: 700_000_000_000_000n, recipient: '0x0000a26b00c1f0df003000390027140000faa719' },
      ],
      startTime: 1_800_000_000n, endTime: 1_800_001_800n, salt: 12345n, totalOriginalConsiderationItems: 2,
    };
    const r = await client.postCriteriaOffer({ parameters, signature: SIG, slug: 'junglebay', counter: 7n });
    expect(r).toEqual({ orderHash: HASH });
    expect(calls[0].url).toBe('https://api.opensea.io/api/v2/offers');
    const body = JSON.parse(calls[0].init.body);
    expect(body.criteria).toEqual({ collection: { slug: 'junglebay' } });
    expect(body.protocol_address).toBe('0x0000000000000068F116a894984e2DB1123eB395');
    expect(body.protocol_data.signature).toBe(SIG);
    expect(body.protocol_data.parameters).toMatchObject({ counter: '7', startTime: '1800000000', endTime: '1800001800', salt: '12345', orderType: 3, totalOriginalConsiderationItems: 2 });
    expect(body.protocol_data.parameters.offer[0]).toEqual({ itemType: 1, token: WETH, identifierOrCriteria: '0', startAmount: '70000000000000000', endAmount: '70000000000000000' });
  });

  it('will not post without a counter, or with a consideration count that does not match', () => {
    const p = { offerer: HOUSE, zone: SIGNED_ZONE, zoneHash: `0x${'0'.repeat(64)}`, conduitKey: OPENSEA_CONDUIT_KEY, orderType: 2, offer: [{ itemType: 1, token: WETH, identifierOrCriteria: 0, startAmount: 1, endAmount: 1 }], consideration: [{ itemType: 4, token: JBAC, identifierOrCriteria: 0, startAmount: 1, endAmount: 1, recipient: HOUSE }], startTime: 1, endTime: 2, salt: 3, totalOriginalConsiderationItems: 1 };
    expect(() => toWireParameters(p)).toThrow(/counter/);
    expect(() => toWireParameters({ ...p, totalOriginalConsiderationItems: 2 }, 0n)).toThrow(/totalOriginalConsiderationItems/);
    expect(toWireParameters({ ...p, counter: 5 }).counter).toBe('5');
  });

  it('turns a gasless cancel answer into the time the last fill signature dies', async () => {
    const answers = [
      { body: { last_signature_issued_valid_until: '2026-11-16T01:05:00Z' } },
      { body: { last_signature_issued_valid_until: '0' } },
      { status: 400, body: { errors: ['Orders created recently must be cancelled onchain'] } },
      { status: 502, body: 'bad gateway' },
    ];
    const { client, calls } = harness({ budget: { readsPerMinute: 6, writesPerHour: 100 }, route: (_u, _i, n) => answers[n - 1] });
    expect(await client.cancelOffer({ orderHash: HASH, offererSignature: SIG })).toEqual({ ok: true, lastSignatureValidUntil: Date.parse('2026-11-16T01:05:00Z') });
    expect(calls[0].url).toBe(`https://api.opensea.io/api/v2/orders/chain/ethereum/protocol/${SEAPORT_16}/${HASH}/cancel`);
    expect(JSON.parse(calls[0].init.body)).toEqual({ offererSignature: SIG });
    expect(await client.cancelOffer({ orderHash: HASH, offererSignature: SIG })).toEqual({ ok: true, lastSignatureValidUntil: null });
    expect(await client.cancelOffer({ orderHash: HASH, offererSignature: SIG })).toEqual({ ok: false, reason: 'Orders created recently must be cancelled onchain', status: 400 });
    const e = await errorOf(client.cancelOffer({ orderHash: HASH, offererSignature: SIG }));
    expect(e).toMatchObject({ name: 'OpenSeaError', kind: 'http', status: 502 });
  });
});

describe('client: budget and back-off (fake fetch, fake clock)', () => {
  it('spends 6 reads a minute, then says how long to wait', async () => {
    const h = harness({ route: itemRoute });
    for (let i = 0; i < 6; i++) await h.client.item(JBAC, '3033');
    const e = await errorOf(h.client.item(JBAC, '3033'));
    expect(e).toMatchObject({ kind: 'rate', status: 0, retryAfterMs: 10_000 });
    expect(h.calls).toHaveLength(6);
    h.advance(10_000);
    await h.client.item(JBAC, '3033');
    expect(h.calls).toHaveLength(7);
  });

  it('waits for a token when the wait is short, instead of failing', async () => {
    const h = harness({ route: itemRoute, maxWaitMs: 20_000 });
    for (let i = 0; i < 7; i++) await h.client.item(JBAC, '3033');
    expect(h.sleeps).toEqual([10_000]);
    expect(h.calls).toHaveLength(7);
  });

  it('keeps calls at least minSpacingMs apart', async () => {
    const h = harness({ route: itemRoute, maxWaitMs: 5_000, minSpacingMs: 1_500 });
    await h.client.item(JBAC, '3033');
    await h.client.item(JBAC, '3033');
    expect(h.sleeps).toEqual([1_500]);
    expect(h.calls[1].at - h.calls[0].at).toBe(1_500);
  });

  it('slows to half rate while OpenSea says under half its limit is left, and back when it recovers', async () => {
    let remaining = '50';
    const h = harness({ route: () => ({ body: fx('opensea-item-junglebay.json'), headers: { 'x-ratelimit-limit': '120', 'x-ratelimit-remaining': remaining } }) });
    for (let i = 0; i < 6; i++) await h.client.item(JBAC, '3033');
    expect(h.client.rateState().slow).toBe(true);
    expect(await errorOf(h.client.item(JBAC, '3033'))).toMatchObject({ kind: 'rate', retryAfterMs: 20_000 });
    h.advance(20_000);
    remaining = '119';
    await h.client.item(JBAC, '3033');
    expect(h.client.rateState().slow).toBe(false);
    expect(await errorOf(h.client.item(JBAC, '3033'))).toMatchObject({ kind: 'rate', retryAfterMs: 10_000 });
  });

  it('honours Retry-After on a 429: no call reaches OpenSea until it has passed', async () => {
    const h = harness({ route: (_u, _i, n) => (n === 1 ? { status: 429, body: {}, headers: { 'retry-after': '30' } } : itemRoute()) });
    expect(await errorOf(h.client.item(JBAC, '3033'))).toMatchObject({ kind: 'rate', status: 429, retryAfterMs: 30_000 });
    expect(await errorOf(h.client.item(JBAC, '3033'))).toMatchObject({ kind: 'rate', status: 429, retryAfterMs: 30_000 });
    expect(h.calls).toHaveLength(1);
    h.advance(30_000);
    await h.client.item(JBAC, '3033');
    expect(h.calls).toHaveLength(2);
  });

  it('pauses a minute after a 429 that gives no Retry-After', async () => {
    const h = harness({ route: () => ({ status: 429, body: {} }) });
    expect(await errorOf(h.client.item(JBAC, '3033'))).toMatchObject({ status: 429, retryAfterMs: 60_000 });
  });

  it('spends writes from their own hourly budget, but a cancel still goes through', async () => {
    const h = harness({
      budget: { readsPerMinute: 6, writesPerHour: 2 },
      route: (url) => (url.endsWith('/cancel') ? { body: { last_signature_issued_valid_until: '0' } } : { body: fx('opensea-build16.json').junglebay.json }),
    });
    await h.client.buildCollectionOffer({ offerer: HOUSE, slug: 'junglebay', qty: 1 });
    await h.client.buildCollectionOffer({ offerer: HOUSE, slug: 'junglebay', qty: 1 });
    expect(await errorOf(h.client.buildCollectionOffer({ offerer: HOUSE, slug: 'junglebay', qty: 1 }))).toMatchObject({ kind: 'rate', retryAfterMs: 1_800_000 });
    expect((await h.client.cancelOffer({ orderHash: HASH, offererSignature: SIG })).ok).toBe(true);
    expect(h.calls).toHaveLength(3);
  });

  it('reports network failures, HTTP errors and bad bodies by kind, without the key', async () => {
    const boom = harness({
      route: () => {
        throw new Error(`socket hang up near ${KEY}`);
      },
    });
    const e1 = await errorOf(boom.client.item(JBAC, '3033'));
    expect(e1).toMatchObject({ kind: 'network', status: 0 });
    expect(e1.message).not.toContain(KEY);
    const five = harness({ route: () => ({ status: 500, body: { detail: 'down' } }) });
    expect(await errorOf(five.client.item(JBAC, '3033'))).toMatchObject({ kind: 'http', status: 500 });
    const html = harness({ route: () => ({ status: 200, body: '<html>maintenance</html>' }) });
    expect(await errorOf(html.client.item(JBAC, '3033'))).toMatchObject({ kind: 'schema' });
  });

  it('refuses bad arguments before spending budget', async () => {
    const h = harness({ route: itemRoute });
    await expect(h.client.bestListings('Jungle Bay')).rejects.toThrow(TypeError);
    await expect(h.client.item('0x1234', '1')).rejects.toThrow(TypeError);
    await expect(h.client.buildCollectionOffer({ offerer: HOUSE, slug: 'junglebay', qty: 0 })).rejects.toThrow(TypeError);
    await expect(h.client.cancelOffer({ orderHash: HASH, offererSignature: '0x12' })).rejects.toThrow(TypeError);
    expect(h.calls).toHaveLength(0);
    expect(h.client.rateState()).toMatchObject({ readsLeft: 6, writesLeft: 20 });
  });
});
