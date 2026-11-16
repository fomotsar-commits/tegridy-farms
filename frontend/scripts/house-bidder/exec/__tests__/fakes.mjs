// Fakes of the two things the brain talks to but does not own, built to the shapes in
// BUILD-SPEC 2.3 (the signer's pipe protocol) and 2.4 (the data layer). The signer fake signs for
// real with a test key, so the executor's independent verification is tested against real
// EIP-712 signatures, not against a stub that always agrees.
//
// Test keys follow the spec: keccak256("house-bidder test key <n>"), never a well-known key.

import { hashStruct, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { COLLECTIONS, ITEM, OPENSEA_CONDUIT_KEY, OPENSEA_FEE, ORDER, SEAPORT_DOMAIN, SEAPORT_TYPES, SIGNED_ZONE, WETH, ZERO32 } from '../../brain/constants.mjs';
import { bpsOf } from '../../brain/util.mjs';
import { localOrderHash, orderComponentsFrom } from '../verify.mjs';

export const testKey = (n) => keccak256(toBytes(`house-bidder test key ${n}`));
export const testAccount = (n) => privateKeyToAccount(testKey(n));

export const ETH = 10n ** 18n;
export const milli = (m) => (BigInt(Math.round(m * 1000)) * ETH) / 1_000_000n; // milli(35) = 0.035 ETH

export function fakeClock(startMs = Date.parse('2026-11-16T12:00:00Z')) {
  let t = startMs;
  return { now: () => t, advance: (ms) => (t += ms), set: (ms) => (t = ms), sec: () => Math.floor(t / 1000) };
}

/** A policy as brain/config.mjs validatePolicy returns it. */
export function testPolicy(house, over = {}) {
  return {
    version: 1,
    chainId: 1,
    house,
    fundingWallet: '0x1111111111111111111111111111111111111111',
    collections: {
      junglebay: { address: COLLECTIONS.junglebay.address, enabled: true, maxUnitPriceWei: 45_000_000_000_000_000n, maxQty: 2, inventoryCap: 3, creatorFee: null },
      gnssart: { address: COLLECTIONS.gnssart.address, enabled: false, maxUnitPriceWei: 16_000_000_000_000_000n, maxQty: 1, inventoryCap: 2, creatorFee: null },
    },
    openseaFee: { ...OPENSEA_FEE },
    venueFee: null,
    maxLifetimeSec: 1800,
    maxAllowanceWei: 150_000_000_000_000_000n,
    maxWrapWei: 200_000_000_000_000_000n,
    gas: { maxFeeGwei: 20, priorityGwei: 0.05, killPriorityGwei: 2, maxGasLimit: 300_000 },
    listing: { enabled: false },
    ...over,
  };
}

/** OpenSea's build answer for a collection bid (code-map/raw/opensea-build16-junglebay.json shape). */
export function standardBuild(offerer, slug, qty) {
  return {
    zone: SIGNED_ZONE,
    zoneHash: ZERO32,
    consideration: [{ itemType: 4, token: COLLECTIONS[slug].address, identifierOrCriteria: '0', startAmount: String(qty), endAmount: String(qty), recipient: offerer }],
  };
}

/** client per BUILD-SPEC 2.4 opensea.mjs. Every call is recorded in `calls` (shared with the signer fake for ordering). */
export function fakeOpenSea({ calls = [], build = null, listings = {}, sales = {}, offers = [], items = {}, cancelResult = null, postError = null, postHash = null } = {}) {
  return {
    calls,
    async collection(slug) {
      calls.push(['opensea.collection', slug]);
      return { slug, contract: COLLECTIONS[slug].address, requiredFees: [{ ...OPENSEA_FEE }], optionalFees: [], traitOffersEnabled: slug === 'junglebay', collectionOffersEnabled: true };
    },
    async bestListings(slug, { limit } = {}) {
      calls.push(['opensea.bestListings', slug, limit]);
      if (listings.error) throw listings.error;
      return listings[slug] ?? [];
    },
    async saleEvents(slug, { afterSec, beforeSec }) {
      calls.push(['opensea.saleEvents', slug, afterSec, beforeSec]);
      return (sales[slug] ?? []).filter((s) => s.time > afterSec && s.time <= beforeSec);
    },
    async accountOffers(address) {
      calls.push(['opensea.accountOffers', address]);
      return typeof offers === 'function' ? offers() : offers;
    },
    async item(contract, tokenId) {
      calls.push(['opensea.item', contract, tokenId]);
      const v = items[tokenId];
      if (v instanceof Error) throw v;
      return v ?? { isDisabled: false, isSuspicious: false, owner: null };
    },
    async buildCollectionOffer({ offerer, slug, qty }) {
      calls.push(['opensea.build', slug, qty]);
      return build ? build({ offerer, slug, qty }) : standardBuild(offerer, slug, qty);
    },
    async postCriteriaOffer({ parameters, signature, slug }) {
      calls.push(['opensea.post', slug, parameters, signature]);
      if (postError) throw postError;
      // OpenSea hashes the order it was given, as the real API does.
      return { orderHash: postHash ?? localOrderHash(orderComponentsFrom(parameters, parameters.counter)) };
    },
    async cancelOffer({ orderHash, offererSignature }) {
      calls.push(['opensea.cancel', orderHash, offererSignature]);
      if (cancelResult instanceof Error) throw cancelResult;
      return cancelResult ?? { ok: true, lastSignatureValidUntil: null };
    },
    rateState: () => ({ readsLeft: 6, writesLeft: 20, lastHeaders: {} }),
  };
}

/** An OpenSeaError as the data layer throws it. */
export function openSeaError(kind, status, message = 'fake') {
  const e = new Error(message);
  e.name = 'OpenSeaError';
  e.kind = kind;
  e.status = status;
  return e;
}

/**
 * The signer per BUILD-SPEC 2.3, signing for real with test key `keyN`. It builds the order the
 * way the real signer must (offer, fee lines, order type, conduit key, salt, counter) so a
 * correct bot verifies it; `tamper` changes the answer after signing to test the bot's checks.
 */
export function fakeSigner({ keyN = 1, calls = [], counter = 7n, policy, refuse = {}, tamper = null, sendTxResult = null, killResult = null, signBidError = null } = {}) {
  const account = testAccount(keyN);
  const house = account.address.toLowerCase();
  let salt = 1000n;
  return {
    calls,
    house,
    async hello() {
      calls.push(['signer.hello']);
      return { ok: true, house, policySha256: 'x', version: 1, stopped: false, pinCommit: 'y' };
    },
    async signBid(req) {
      calls.push(['signer.signBid', req]);
      if (signBidError) throw signBidError;
      if (refuse.signBid) return { ok: false, id: '1', field: refuse.signBid, reason: 'refused by the fake signer' };
      const qty = BigInt(req.qty);
      const total = BigInt(req.unitPriceWei) * qty;
      const fee = (amount, recipient) => ({ itemType: ITEM.ERC20, token: WETH, identifierOrCriteria: '0', startAmount: amount.toString(), endAmount: amount.toString(), recipient });
      const consideration = [req.build.consideration[0], fee(bpsOf(total, OPENSEA_FEE.bps), OPENSEA_FEE.recipient)];
      const cf = policy?.collections?.[req.slug]?.creatorFee;
      if (cf) consideration.push(fee(bpsOf(total, cf.bps), cf.recipient));
      if (policy?.venueFee) consideration.push(fee(bpsOf(total, policy.venueFee.bps), policy.venueFee.recipient));
      const parameters = {
        offerer: house,
        zone: SIGNED_ZONE,
        offer: [{ itemType: ITEM.ERC20, token: WETH, identifierOrCriteria: '0', startAmount: total.toString(), endAmount: total.toString() }],
        consideration,
        orderType: qty > 1n ? ORDER.PARTIAL_RESTRICTED : ORDER.FULL_RESTRICTED,
        startTime: String(req.startTime),
        endTime: String(req.endTime),
        zoneHash: ZERO32,
        salt: `0x${(++salt).toString(16).padStart(64, '0')}`,
        conduitKey: OPENSEA_CONDUIT_KEY,
        totalOriginalConsiderationItems: consideration.length,
      };
      const components = orderComponentsFrom(parameters, counter);
      const signature = await account.signTypedData({ domain: SEAPORT_DOMAIN, types: SEAPORT_TYPES, primaryType: 'OrderComponents', message: components });
      const orderHash = hashStruct({ data: components, primaryType: 'OrderComponents', types: SEAPORT_TYPES });
      const answer = { ok: true, id: '1', orderHash, signature, parameters, counter: counter.toString() };
      return tamper ? await tamper(answer) : answer;
    },
    async signCancel(orderHash) {
      calls.push(['signer.signCancel', orderHash]);
      if (refuse.signCancel) return { ok: false, id: '1', field: refuse.signCancel, reason: 'refused by the fake signer' };
      return { ok: true, id: '1', signature: `0x${'ab'.repeat(65)}` };
    },
    async sendTx(kind, params) {
      calls.push(['signer.sendTx', kind, params]);
      if (refuse.sendTx?.includes(kind)) return { ok: false, id: '1', field: 'kind', reason: `${kind} refused by the fake signer` };
      return sendTxResult ?? { ok: true, id: '1', txHash: `0x${'cd'.repeat(32)}`, status: 'mined', blockNumber: 100 };
    },
    async kill() {
      calls.push(['signer.kill']);
      return killResult ?? { ok: true, id: '1', txs: [{ kind: 'revokeWeth', txHash: `0x${'01'.repeat(32)}`, status: 'mined', blockNumber: 101 }, { kind: 'incrementCounter', txHash: `0x${'02'.repeat(32)}`, status: 'mined', blockNumber: 102 }] };
    },
    async status() {
      calls.push(['signer.status']);
      return { ok: true, house, stopped: false, lastNonce: 0, counter: counter.toString(), wethBalance: '0', wethAllowance: '0' };
    },
    close() {},
  };
}

/** chain per BUILD-SPEC 2.4 chain.mjs. */
export function fakeChain({ calls = [], snapshot = null, provenance = {}, code = {}, fills = [], fillable = null } = {}) {
  const self = {
    calls,
    handlers: null,
    async snapshot() {
      calls.push(['chain.snapshot']);
      const s = typeof snapshot === 'function' ? snapshot() : snapshot;
      if (s instanceof Error) throw s;
      return s;
    },
    watch(handlers) {
      self.handlers = handlers;
    },
    async listingFillable(listings) {
      calls.push(['chain.listingFillable', listings.length]);
      return new Map(listings.map((l) => [l.orderHash, fillable ? fillable(l) : { fillable: true }]));
    },
    async tokenProvenance(slug, tokenId, opts) {
      calls.push(['chain.tokenProvenance', slug, tokenId, opts]);
      const v = provenance[tokenId];
      if (v instanceof Error) throw v;
      return v ?? [];
    },
    async code(address) {
      calls.push(['chain.code', address]);
      const v = code[String(address).toLowerCase()];
      if (v instanceof Error) throw v;
      return v ?? '0x';
    },
    async houseFills({ sinceSec }) {
      calls.push(['chain.houseFills', sinceSec]);
      return (typeof fills === 'function' ? fills() : fills).filter((f) => f.time >= sinceSec);
    },
  };
  return self;
}

/** A chain snapshot (2.4) for the house. */
export function snapshotOf({ block = 26_500_000, time = 0, weth = milli(200), allowance = 0n, counter = 7n, eth = milli(50), jbac = {}, gnss = {} } = {}) {
  return {
    block,
    time,
    house: { weth, allowance, counter, eth },
    jbac: { maxSupply: 5555n, totalSupply: 5555n, owner: '0xdc4aee24d421b2697f3e09da761b88d06f13e12e', ...jbac },
    gnss: { totalSupply: 9697n, owner: '0x209aa937ac59f60384a70b98fec5daf54ac7b967', contractLocked: false, seed: '0x0000000000000000000000000000000000000abc', ...gnss },
  };
}

/** stream per BUILD-SPEC 2.4 stream.mjs. `emit` plays an event. */
export function fakeStream({ lastMessageAt = () => Date.now() } = {}) {
  const handlers = {};
  return {
    on(type, h) {
      (handlers[type] ??= []).push(h);
    },
    emit(type, ev = {}) {
      for (const h of handlers[type] ?? []) h({ type, ...ev });
    },
    start() {},
    stop() {},
    lastMessageAt,
  };
}

/** tape.mjs / fairValue.mjs stand-ins: keep every sale, and return the fair value the test says. */
export const fakeBuildTape = (sales) => ({ kept: sales, dropped: [] });
export function fakeFairValue(fn) {
  return (args) => {
    const v = fn(args);
    return { S: null, L: null, F: null, n: 0, sellers: 0, cheapestFillable: null, floorProxy: null, reason: null, state: {}, ...v };
  };
}

/** An in-memory stand-in for the parts of node:fs the ledger and config use. */
export function memFs(files = {}) {
  const store = new Map(Object.entries(files));
  return {
    store,
    readFileSync(p, enc) {
      if (!store.has(p)) {
        const e = new Error(`ENOENT: ${p}`);
        e.code = 'ENOENT';
        throw e;
      }
      const v = store.get(p);
      return enc ? String(v) : Buffer.from(String(v));
    },
    existsSync: (p) => store.has(p),
    appendFileSync(p, text) {
      store.set(p, (store.has(p) ? String(store.get(p)) : '') + text);
    },
    writeFileSync(p, text) {
      store.set(p, String(text));
    },
    renameSync(a, b) {
      store.set(b, store.get(a));
      store.delete(a);
    },
  };
}
