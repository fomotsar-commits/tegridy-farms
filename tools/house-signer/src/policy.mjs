// The firewall. Pure functions only: no files, no network, no clock, no randomness. Each
// takes the request (or the exact struct about to be signed) plus the facts it needs, and
// answers { ok: true, ... } or { ok: false, field, reason }. A refusal's `field` is the id
// of the pin that refused (the protocol's "which pin"), so a log line points at one check.
// The ids are listed in README.md.
//
// Every check ends its line with a `// PIN:<id>` marker. test/mutate.mjs deletes each
// marked line in turn and proves at least one test (one whose title names that pin) fails,
// so no check here can be removed, or quietly stop working, without the suite going red.
// Keep each check on one line, `if (bad) return no(...);`, so the mutation removes exactly it.
//
// Why so much checking of things the signer built itself: the signer constructs every
// field of an order, but this file re-reads the finished order from scratch, against the
// pins alone, before it is hashed. A bug in the builder, or a poisoned value that slipped
// through it, has to get past both, written separately on purpose.

import {
  BPS_DENOMINATOR, CHAIN_ID, ITEM, KNOWN_COLLECTIONS, MAX_CANCEL_ORDERS, NORMAL_FEE_SHARE_DEN,
  NORMAL_FEE_SHARE_NUM, OPENSEA_CONDUIT, OPENSEA_CONDUIT_KEY, OPENSEA_FEE_BPS, OPENSEA_FEE_RECIPIENT,
  ORDER_TYPE, PRICE_TICK_WEI, SEAPORT, SEAPORT_NAME, SEAPORT_VERSION, SIGNED_ZONE, START_TIME_SKEW_SEC,
  VENUE_FEE_BPS, VENUE_SAFE, WETH, ZERO_ADDRESS, ZERO_BYTES32,
} from './constants.mjs';
import { addressAt, argsOf, SELECTORS, wordAt } from './abi.mjs';
import { checksumOk } from './keccak.mjs';
import {
  eqAddr, gweiToWei, hasExactKeys, isAddress, isBytes32, isHexData, isPlainObject, parseSafeInt,
  parseUint, parseWeiString, UINT256_MAX,
} from './hex.mjs';

function no(field, reason) {
  return { ok: false, field, reason };
}

const lc = (a) => a.toLowerCase();

// ---------------------------------------------------------------------------------------
// policy.json
// ---------------------------------------------------------------------------------------

const POLICY_KEYS = ['version', 'chainId', 'house', 'fundingWallet', 'collections', 'openseaFee', 'venueFee', 'maxLifetimeSec', 'maxAllowanceWei', 'maxWrapWei', 'gas', 'listing'];
const COLLECTION_KEYS = ['address', 'enabled', 'maxUnitPriceWei', 'maxQty', 'inventoryCap', 'creatorFee'];
const FEE_KEYS = ['recipient', 'bps'];
const GAS_KEYS = ['maxFeeGwei', 'priorityGwei', 'killPriorityGwei', 'maxGasLimit'];
const LISTING_KEYS = ['enabled', 'maxLifetimeSec', 'minUnitPriceWei'];
const MAX_BID_LIFETIME_SEC = 7 * 24 * 3600;
const MAX_FEE_CAP_WEI = 1000n * 1_000_000_000n;

const PINNED_CONTRACTS = [WETH, SEAPORT, SIGNED_ZONE, OPENSEA_CONDUIT, ...Object.values(KNOWN_COLLECTIONS).map((c) => c.address)];

/** Validate policy.json (parsed) into the normalized policy every other check reads. */
export function validatePolicy(raw) {
  if (!hasExactKeys(raw, POLICY_KEYS)) return no('F.shape', `policy.json must have exactly these keys: ${POLICY_KEYS.join(', ')}`); // PIN:F.shape
  if (raw.version !== 1) return no('F.version', 'policy.json version must be 1'); // PIN:F.version
  if (raw.chainId !== 1) return no('F.chainId', 'the house only trades on Ethereum mainnet (chainId 1)'); // PIN:F.chainId
  if (!isAddress(raw.house) || !checksumOk(raw.house) || eqAddr(raw.house, ZERO_ADDRESS)) return no('F.house', 'policy.house is not a valid address'); // PIN:F.house
  if (!isAddress(raw.fundingWallet) || !checksumOk(raw.fundingWallet) || eqAddr(raw.fundingWallet, ZERO_ADDRESS)) return no('F.funding', 'policy.fundingWallet is not a valid address'); // PIN:F.funding
  if (eqAddr(raw.fundingWallet, raw.house)) return no('F.fundingHouse', 'the funding wallet cannot be the house itself'); // PIN:F.fundingHouse
  if (PINNED_CONTRACTS.some((a) => eqAddr(a, raw.fundingWallet))) return no('F.fundingContract', 'the funding wallet cannot be a token, Seaport, the conduit or a collection contract'); // PIN:F.fundingContract
  if (!isPlainObject(raw.collections) || Object.keys(raw.collections).length === 0) return no('F.collections', 'policy.collections must name at least one collection'); // PIN:F.collections

  const collections = {};
  for (const [slug, c] of Object.entries(raw.collections)) {
    const known = KNOWN_COLLECTIONS[slug];
    if (!known) return no('F.slug', `${slug} is not a collection this signer knows; adding one is a code change`); // PIN:F.slug
    if (!hasExactKeys(c, COLLECTION_KEYS)) return no('F.cshape', `${slug} must have exactly: ${COLLECTION_KEYS.join(', ')}`); // PIN:F.cshape
    if (!eqAddr(c.address, known.address)) return no('F.caddress', `${slug}.address is not the ${known.ticker} contract`); // PIN:F.caddress
    if (typeof c.enabled !== 'boolean') return no('F.enabled', `${slug}.enabled must be true or false`); // PIN:F.enabled
    const maxUnitPriceWei = parseWeiString(c.maxUnitPriceWei);
    if (maxUnitPriceWei === null || maxUnitPriceWei === 0n) return no('F.maxUnit', `${slug}.maxUnitPriceWei must be a positive decimal string of wei`); // PIN:F.maxUnit
    const maxQty = parseSafeInt(c.maxQty);
    if (typeof c.maxQty !== 'number' || maxQty === null || maxQty < 1 || maxQty > 100) return no('F.maxQty', `${slug}.maxQty must be a whole number from 1 to 100`); // PIN:F.maxQty
    if (typeof c.inventoryCap !== 'number' || parseSafeInt(c.inventoryCap) === null || c.inventoryCap > 1000) return no('F.inventoryCap', `${slug}.inventoryCap must be a whole number from 0 to 1000`); // PIN:F.inventoryCap
    let creatorFee = null;
    if (c.creatorFee !== null) {
      if (!hasExactKeys(c.creatorFee, FEE_KEYS)) return no('F.creatorShape', `${slug}.creatorFee must be null or { recipient, bps }`); // PIN:F.creatorShape
      if (!eqAddr(c.creatorFee.recipient, known.creatorRecipient)) return no('F.creatorRecipient', `${slug}.creatorFee.recipient is not ${known.ticker}'s creator fee recipient`); // PIN:F.creatorRecipient
      const bps = parseSafeInt(c.creatorFee.bps);
      if (typeof c.creatorFee.bps !== 'number' || bps === null || bps < 1 || BigInt(bps) > known.creatorMaxBps) return no('F.creatorBps', `${slug}.creatorFee.bps must be 1 to ${known.creatorMaxBps}`); // PIN:F.creatorBps
      creatorFee = { recipient: lc(c.creatorFee.recipient), bps: BigInt(bps) };
    }
    collections[slug] = { slug, address: known.address, enabled: c.enabled, maxUnitPriceWei, maxQty, inventoryCap: c.inventoryCap, creatorFee };
  }

  if (!hasExactKeys(raw.openseaFee, FEE_KEYS)) return no('F.osShape', 'policy.openseaFee must be { recipient, bps }'); // PIN:F.osShape
  if (!eqAddr(raw.openseaFee.recipient, OPENSEA_FEE_RECIPIENT)) return no('F.osRecipient', "policy.openseaFee.recipient is not OpenSea's fee address"); // PIN:F.osRecipient
  if (raw.openseaFee.bps !== Number(OPENSEA_FEE_BPS)) return no('F.osBps', "policy.openseaFee.bps must be OpenSea's required 100 (1%)"); // PIN:F.osBps

  let venueFee = null;
  if (raw.venueFee !== null) {
    if (!hasExactKeys(raw.venueFee, FEE_KEYS)) return no('F.venueShape', 'policy.venueFee must be null or { recipient, bps }'); // PIN:F.venueShape
    if (!eqAddr(raw.venueFee.recipient, VENUE_SAFE)) return no('F.venueRecipient', 'a venue fee is only ever paid to the venue fee Safe'); // PIN:F.venueRecipient
    if (raw.venueFee.bps !== Number(VENUE_FEE_BPS)) return no('F.venueBps', 'the venue fee is 50 bps (0.5%)'); // PIN:F.venueBps
    venueFee = { recipient: VENUE_SAFE, bps: VENUE_FEE_BPS };
  }

  const maxLifetimeSec = parseSafeInt(raw.maxLifetimeSec);
  if (typeof raw.maxLifetimeSec !== 'number' || maxLifetimeSec === null || maxLifetimeSec < 60 || maxLifetimeSec > MAX_BID_LIFETIME_SEC) return no('F.lifetime', 'maxLifetimeSec must be a whole number of seconds from 60 to 7 days'); // PIN:F.lifetime
  const maxAllowanceWei = parseWeiString(raw.maxAllowanceWei);
  if (maxAllowanceWei === null) return no('F.allowance', 'maxAllowanceWei must be a decimal string of wei'); // PIN:F.allowance
  const maxWrapWei = parseWeiString(raw.maxWrapWei);
  if (maxWrapWei === null) return no('F.wrap', 'maxWrapWei must be a decimal string of wei'); // PIN:F.wrap

  if (!hasExactKeys(raw.gas, GAS_KEYS)) return no('F.gasShape', `policy.gas must have exactly: ${GAS_KEYS.join(', ')}`); // PIN:F.gasShape
  const maxFeeWei = gweiToWei(raw.gas.maxFeeGwei);
  const priorityWei = gweiToWei(raw.gas.priorityGwei);
  const killPriorityWei = gweiToWei(raw.gas.killPriorityGwei);
  if (maxFeeWei === null || maxFeeWei === 0n || maxFeeWei > MAX_FEE_CAP_WEI) return no('F.maxFee', 'gas.maxFeeGwei must be more than 0 and at most 1000'); // PIN:F.maxFee
  if (priorityWei === null || priorityWei * NORMAL_FEE_SHARE_DEN > maxFeeWei * NORMAL_FEE_SHARE_NUM) return no('F.priority', 'gas.priorityGwei must fit inside the share of the fee cap normal transactions use'); // PIN:F.priority
  if (killPriorityWei === null || killPriorityWei > maxFeeWei || killPriorityWei * 10n < priorityWei * 11n || killPriorityWei === 0n) return no('F.killPriority', 'gas.killPriorityGwei must be at least 10% above priorityGwei (so a kill can replace a pending transaction) and at most maxFeeGwei'); // PIN:F.killPriority
  const maxGasLimit = parseSafeInt(raw.gas.maxGasLimit);
  if (typeof raw.gas.maxGasLimit !== 'number' || maxGasLimit === null || maxGasLimit < 21_000 || maxGasLimit > 1_000_000) return no('F.gasLimit', 'gas.maxGasLimit must be from 21000 to 1000000'); // PIN:F.gasLimit

  if (!hasExactKeys(raw.listing, LISTING_KEYS)) return no('F.listingShape', `policy.listing must have exactly: ${LISTING_KEYS.join(', ')}`); // PIN:F.listingShape
  if (raw.listing.enabled !== false) return no('F.listingOff', 'listings are not supported in this version; listing.enabled must be false'); // PIN:F.listingOff

  return {
    ok: true,
    policy: Object.freeze({
      version: 1,
      chainId: 1,
      house: lc(raw.house),
      fundingWallet: lc(raw.fundingWallet),
      collections: Object.freeze(collections),
      openseaFee: Object.freeze({ recipient: OPENSEA_FEE_RECIPIENT, bps: OPENSEA_FEE_BPS }),
      venueFee: venueFee && Object.freeze(venueFee),
      maxLifetimeSec,
      maxAllowanceWei,
      maxWrapWei,
      gas: Object.freeze({ maxFeeWei, priorityWei, killPriorityWei, maxGasLimit: BigInt(maxGasLimit) }),
      listing: Object.freeze({ enabled: false }),
    }),
  };
}

/** The most a normal (not kill) transaction may offer per gas: a share of the cap. */
export function normalFeeCap(policy) {
  return (policy.gas.maxFeeWei * NORMAL_FEE_SHARE_NUM) / NORMAL_FEE_SHARE_DEN;
}

// ---------------------------------------------------------------------------------------
// signBid
// ---------------------------------------------------------------------------------------

/**
 * OpenSea's SDK creates every collection offer with restrictedByZone: true and
 * allowPartialFills: true (OrdersManager.createCollectionOffer), which seaport-js maps to
 * PARTIAL_RESTRICTED for every quantity, 1 included. The signer does the same, so a house
 * bid is shaped like every other collection offer on OpenSea.
 */
export function orderTypeForBid(qty) {
  return qty >= 1 ? ORDER_TYPE.PARTIAL_RESTRICTED : -1;
}

const BID_REQUEST_KEYS = ['id', 'op', 'slug', 'qty', 'unitPriceWei', 'startTime', 'endTime', 'build'];
const BUILD_KEYS = ['zone', 'zoneHash', 'consideration'];
const ITEM_KEYS = ['itemType', 'token', 'identifierOrCriteria', 'startAmount', 'endAmount', 'recipient'];

/** One consideration line exactly as OpenSea's build returns it -> bigints, or null. */
export function readBuildLine(raw) {
  if (!hasExactKeys(raw, ITEM_KEYS)) return null;
  const itemType = parseSafeInt(raw.itemType);
  const identifierOrCriteria = parseUint(raw.identifierOrCriteria);
  const startAmount = parseUint(raw.startAmount);
  const endAmount = parseUint(raw.endAmount);
  if (itemType === null || identifierOrCriteria === null || startAmount === null || endAmount === null) return null;
  if (!isAddress(raw.token) || !isAddress(raw.recipient)) return null;
  return { itemType, token: lc(raw.token), identifierOrCriteria, startAmount, endAmount, recipient: lc(raw.recipient) };
}

/** Checks on the bot's request, before the signer reads the chain or builds anything. */
export function checkBidRequest(req, { policy, nowSec, stopped }) {
  if (stopped) return no('P15', 'a STOP file is in the keys folder, so nothing new is signed'); // PIN:P15
  if (!hasExactKeys(req, BID_REQUEST_KEYS)) return no('P0.shape', `a signBid request has exactly: ${BID_REQUEST_KEYS.join(', ')} (types, domain, salt, counter and fee lines are the signer's own)`); // PIN:P0.shape
  const c = typeof req.slug === 'string' && Object.hasOwn(policy.collections, req.slug) ? policy.collections[req.slug] : null;
  if (!c) return no('P8.slug', 'that collection is not in the policy'); // PIN:P8.slug
  if (!c.enabled) return no('P8.enabled', `${req.slug} is switched off in the policy`); // PIN:P8.enabled
  const qty = parseSafeInt(req.qty);
  if (qty === null) return no('P8.int', 'qty must be a whole number'); // PIN:P8.int
  if (qty < 1) return no('P8.min', 'qty must be at least 1'); // PIN:P8.min
  if (qty > c.maxQty) return no('P8.max', `qty is above the policy's ${c.maxQty} for ${req.slug}`); // PIN:P8.max
  const unit = parseWeiString(req.unitPriceWei);
  if (unit === null) return no('P7.format', 'unitPriceWei must be a decimal string of wei'); // PIN:P7.format
  if (unit === 0n) return no('P7.positive', 'the unit price must be more than zero'); // PIN:P7.positive
  if (unit % PRICE_TICK_WEI !== 0n) return no('P7.tick', 'the unit price must be a whole number of 0.00001 ETH (10^13 wei)'); // PIN:P7.tick
  if (unit > c.maxUnitPriceWei) return no('P7.max', `the unit price is above the policy ceiling for ${req.slug}`); // PIN:P7.max
  const startTime = parseSafeInt(req.startTime);
  const endTime = parseSafeInt(req.endTime);
  if (startTime === null || endTime === null) return no('P12.int', 'startTime and endTime must be whole unix seconds'); // PIN:P12.int
  if (Math.abs(startTime - nowSec) > START_TIME_SKEW_SEC) return no('P12.start', `startTime is more than ${START_TIME_SKEW_SEC} s from the signer's clock`); // PIN:P12.start
  if (endTime <= startTime) return no('P12.order', 'endTime must be after startTime'); // PIN:P12.order
  if (endTime - startTime > policy.maxLifetimeSec) return no('P12.lifetime', `a bid may live at most ${policy.maxLifetimeSec} s`); // PIN:P12.lifetime
  const b = req.build;
  if (!hasExactKeys(b, BUILD_KEYS)) return no('P3.shape', `build must have exactly: ${BUILD_KEYS.join(', ')}`); // PIN:P3.shape
  if (!eqAddr(b.zone, SIGNED_ZONE)) return no('P3.zone', "the build's zone is not OpenSea's SignedZone"); // PIN:P3.zone
  if (!isBytes32(b.zoneHash) || lc(b.zoneHash) !== ZERO_BYTES32) return no('P3.zoneHash', "the build's zoneHash is not zero"); // PIN:P3.zoneHash
  if (!Array.isArray(b.consideration) || b.consideration.length !== 1) return no('P9.count', 'the build must return exactly one line: the NFT the house buys'); // PIN:P9.count
  const nft = readBuildLine(b.consideration[0]);
  if (!nft) return no('P9.shape', "the build's NFT line is not a well-formed consideration item"); // PIN:P9.shape
  if (nft.itemType !== ITEM.ERC721_WITH_CRITERIA) return no('P9.itemType', 'the NFT line must be itemType 4 (any NFT of a collection)'); // PIN:P9.itemType
  if (!eqAddr(nft.token, c.address)) return no('P9.token', `the NFT line is not for the ${req.slug} contract`); // PIN:P9.token
  if (nft.identifierOrCriteria !== 0n) return no('P9.criteria', 'the NFT line must have criteria 0 (trait bids are refused in this version)'); // PIN:P9.criteria
  if (nft.startAmount !== BigInt(qty)) return no('P9.start', 'the NFT line startAmount must equal qty'); // PIN:P9.start
  if (nft.endAmount !== BigInt(qty)) return no('P9.end', 'the NFT line endAmount must equal qty'); // PIN:P9.end
  if (!eqAddr(nft.recipient, policy.house)) return no('P9.recipient', 'the NFT line must deliver to the house'); // PIN:P9.recipient
  return { ok: true, slug: req.slug, qty, unitPriceWei: unit, startTime, endTime, nftLine: nft };
}

function sameItem(a, b) {
  return a.itemType === b.itemType
    && eqAddr(a.token, b.token)
    && a.identifierOrCriteria === b.identifierOrCriteria
    && a.startAmount === b.startAmount
    && a.endAmount === b.endAmount
    && (a.recipient === undefined ? b.recipient === undefined : eqAddr(a.recipient, b.recipient));
}

/**
 * The fee lines a bid of `offerTotal` must carry, computed straight from the pins (not by
 * the builder's code): OpenSea's 1%, then the creator's line only if the policy sets one,
 * then the venue's line only if the policy sets one.
 */
function expectedFeeLines(policy, slug, offerTotal) {
  const line = (recipient, bps) => ({ itemType: ITEM.ERC20, token: WETH, identifierOrCriteria: 0n, startAmount: (offerTotal * bps) / BPS_DENOMINATOR, endAmount: (offerTotal * bps) / BPS_DENOMINATOR, recipient });
  const out = [line(OPENSEA_FEE_RECIPIENT, OPENSEA_FEE_BPS)];
  const creator = policy.collections[slug].creatorFee;
  if (creator) out.push(line(KNOWN_COLLECTIONS[slug].creatorRecipient, creator.bps));
  if (policy.venueFee) out.push(line(VENUE_SAFE, VENUE_FEE_BPS));
  return out;
}

/**
 * The final check, over the exact OrderComponents (bigints) about to be hashed and signed.
 * ctx: { policy, house (the key's address), domain, slug, nftLine (from the checked build),
 *        salt (generated by the signer), counter (read by the signer), nowSec }
 */
export function checkBidOrder(order, ctx) {
  const { policy, house, domain, slug, nftLine, salt, counter, nowSec } = ctx;
  if (policy.chainId !== 1 || domain.chainId !== CHAIN_ID) return no('P1.chainId', 'the order is not for Ethereum mainnet'); // PIN:P1.chainId
  if (domain.name !== SEAPORT_NAME) return no('P1.name', 'the EIP-712 domain name is not Seaport'); // PIN:P1.name
  if (domain.version !== SEAPORT_VERSION) return no('P1.version', 'the EIP-712 domain version is not 1.6'); // PIN:P1.version
  if (!eqAddr(domain.verifyingContract, SEAPORT)) return no('P1.contract', 'the EIP-712 domain is not the Seaport 1.6 contract'); // PIN:P1.contract
  if (!eqAddr(order.offerer, house)) return no('P2.key', "the offerer is not the house key's address"); // PIN:P2.key
  if (!eqAddr(order.offerer, policy.house)) return no('P2.policy', 'the offerer is not policy.house'); // PIN:P2.policy
  if (!eqAddr(order.zone, SIGNED_ZONE)) return no('P3.orderZone', "the order's zone is not OpenSea's SignedZone"); // PIN:P3.orderZone
  if (order.zoneHash !== ZERO_BYTES32) return no('P3.orderZoneHash', "the order's zoneHash is not zero"); // PIN:P3.orderZoneHash
  const c = Object.hasOwn(policy.collections, slug) ? policy.collections[slug] : null;
  if (!c || !c.enabled) return no('P8.orderEnabled', 'the order is for a collection the policy does not enable'); // PIN:P8.orderEnabled
  if (!Array.isArray(order.offer) || !Array.isArray(order.consideration) || order.consideration.length < 2) return no('P11.minLines', 'the order must carry the NFT line and at least the OpenSea fee line'); // PIN:P11.minLines
  const nft = order.consideration[0];
  const qty = nft.startAmount;
  if (qty < 1n || qty > BigInt(c.maxQty)) return no('P8.orderQty', 'the order quantity is outside the policy'); // PIN:P8.orderQty
  if (order.orderType !== orderTypeForBid(Number(qty))) return no('P4', 'the order type is not PARTIAL_RESTRICTED (3), the type OpenSea gives collection offers'); // PIN:P4
  if (order.conduitKey !== OPENSEA_CONDUIT_KEY) return no('P5', "the conduit key is not OpenSea's"); // PIN:P5
  if (order.offer.length !== 1) return no('P6.count', 'the order must offer exactly one item'); // PIN:P6.count
  const o = order.offer[0];
  if (o.itemType !== ITEM.ERC20) return no('P6.itemType', 'the offer must be an ERC-20 (itemType 1)'); // PIN:P6.itemType
  if (!eqAddr(o.token, WETH)) return no('P6.token', 'the offer must be WETH'); // PIN:P6.token
  if (o.identifierOrCriteria !== 0n) return no('P6.id', 'the offer identifier must be 0'); // PIN:P6.id
  if (o.startAmount !== o.endAmount) return no('P6.flat', 'the offer must not change price over time'); // PIN:P6.flat
  if (o.startAmount % qty !== 0n) return no('P11.offerDivisible', 'the offer total must divide exactly by the quantity'); // PIN:P11.offerDivisible
  const unit = o.startAmount / qty;
  if (unit === 0n) return no('P7.orderPositive', 'the unit price must be more than zero'); // PIN:P7.orderPositive
  if (unit % PRICE_TICK_WEI !== 0n) return no('P7.orderTick', 'the unit price is not on the 10^13 wei tick'); // PIN:P7.orderTick
  if (unit > c.maxUnitPriceWei) return no('P7.orderMax', 'the unit price is above the policy ceiling'); // PIN:P7.orderMax
  if (nft.itemType !== ITEM.ERC721_WITH_CRITERIA) return no('P9.orderItemType', 'the NFT line must be itemType 4'); // PIN:P9.orderItemType
  if (!eqAddr(nft.token, c.address)) return no('P9.orderToken', 'the NFT line is for the wrong contract'); // PIN:P9.orderToken
  if (nft.identifierOrCriteria !== 0n) return no('P9.orderCriteria', 'the NFT line criteria must be 0'); // PIN:P9.orderCriteria
  if (nft.endAmount !== qty) return no('P9.orderFlat', 'the NFT line must not change quantity over time'); // PIN:P9.orderFlat
  if (!eqAddr(nft.recipient, house)) return no('P9.orderRecipient', 'the NFT line must deliver to the house'); // PIN:P9.orderRecipient
  if (!sameItem(nft, nftLine)) return no('P9.build', 'the NFT line is not the one the build returned'); // PIN:P9.build
  const fees = expectedFeeLines(policy, slug, o.startAmount);
  if (order.consideration.length !== 1 + fees.length) return no('P11.count', 'the order carries a line the policy does not allow, or lacks one it requires'); // PIN:P11.count
  // These two hold for any order that matches the fee lines below (the price tick makes
  // every fee divide by the quantity); they come first so they stand on their own if the
  // tick or the fee arithmetic ever changes.
  if (order.consideration.some((i) => i.startAmount % qty !== 0n || i.endAmount % qty !== 0n)) return no('P11.divisible', 'every line must divide exactly by the quantity, or a partial fill reverts'); // PIN:P11.divisible
  if (order.consideration.slice(1).some((i) => i.startAmount === 0n || i.endAmount === 0n)) return no('P11.nonZero', 'a fee line of zero would make Seaport refuse every fill'); // PIN:P11.nonZero
  if (!sameItem(order.consideration[1], fees[0])) return no('P10', "line 2 must be OpenSea's 1% fee in WETH, exact"); // PIN:P10
  if (fees.length > 1 && !sameItem(order.consideration[2], fees[1])) return no('P11.second', 'line 3 must be the policy fee line (creator, else venue), exact'); // PIN:P11.second
  if (fees.length > 2 && !sameItem(order.consideration[3], fees[2])) return no('P11.third', 'line 4 must be the venue fee line, exact'); // PIN:P11.third
  if (typeof order.startTime !== 'bigint' || typeof order.endTime !== 'bigint') return no('P12.orderInt', 'order times must be whole numbers'); // PIN:P12.orderInt
  if (order.startTime > BigInt(nowSec + START_TIME_SKEW_SEC) || order.startTime < BigInt(nowSec - START_TIME_SKEW_SEC)) return no('P12.orderStart', "the order's startTime is not within 300 s of the signer's clock"); // PIN:P12.orderStart
  if (order.endTime <= order.startTime) return no('P12.orderOrder', "the order's endTime is not after its startTime"); // PIN:P12.orderOrder
  if (order.endTime - order.startTime > BigInt(policy.maxLifetimeSec)) return no('P12.orderLifetime', 'the order lives longer than the policy allows'); // PIN:P12.orderLifetime
  if (order.salt !== salt) return no('P13.salt', 'the salt is not the one the signer generated'); // PIN:P13.salt
  if (order.counter !== counter) return no('P13.counter', 'the counter is not the one the signer read on chain'); // PIN:P13.counter
  if (order.totalOriginalConsiderationItems !== order.consideration.length) return no('P14', 'totalOriginalConsiderationItems must equal the number of consideration lines'); // PIN:P14
  return { ok: true, qty, unit };
}

// ---------------------------------------------------------------------------------------
// signCancel
// ---------------------------------------------------------------------------------------

export function checkCancelRequest(req, { knownOrders }) {
  if (!hasExactKeys(req, ['id', 'op', 'orderHash'])) return no('C.shape', 'a signCancel request has exactly: id, op, orderHash'); // PIN:C.shape
  if (!isBytes32(req.orderHash)) return no('C.format', 'orderHash must be 0x + 64 hex'); // PIN:C.format
  if (!knownOrders.has(lc(req.orderHash))) return no('C.known', 'the signer only cancels orders it signed itself, and this one is not in signer-orders.jsonl'); // PIN:C.known
  return { ok: true, orderHash: lc(req.orderHash) };
}

// ---------------------------------------------------------------------------------------
// sendTx
// ---------------------------------------------------------------------------------------

export const TX_KINDS = Object.freeze({
  approveWeth: ['amountWei'],
  revokeWeth: [],
  wrap: ['amountWei'],
  unwrap: ['amountWei'],
  returnWethToFunding: ['amountWei'],
  incrementCounter: [],
  cancelOnChain: ['orderHashes'],
  setNftApproval: ['slug', 'approved'],
  returnNftToFunding: ['slug', 'tokenId'],
});

const SELECTOR_BY_KIND = Object.freeze({
  approveWeth: SELECTORS.approve,
  revokeWeth: SELECTORS.approve,
  wrap: SELECTORS.deposit,
  unwrap: SELECTORS.withdraw,
  returnWethToFunding: SELECTORS.transfer,
  incrementCounter: SELECTORS.incrementCounter,
  cancelOnChain: SELECTORS.cancel,
  setNftApproval: SELECTORS.setApprovalForAll,
  returnNftToFunding: SELECTORS.safeTransferFrom,
});

/**
 * Kinds that only shrink what the house can lose. They still work when STOP exists, and
 * the NFT ones work for a collection the policy has switched off (otherwise a disabled
 * collection's NFTs could not be sent home without switching bidding back on).
 */
export function reducesRisk(plan) {
  switch (plan.kind) {
    case 'revokeWeth':
    case 'unwrap':
    case 'returnWethToFunding':
    case 'incrementCounter':
    case 'cancelOnChain':
    case 'returnNftToFunding':
      return true;
    case 'setNftApproval':
      return plan.approved === false;
    default:
      return false;
  }
}

/**
 * Checks on a sendTx request. ctx: { policy, stopped, knownOrders }.
 * Returns { ok: true, plan } where plan holds the parsed, checked arguments.
 */
export function checkTxRequest(req, { policy, stopped, knownOrders }) {
  if (!hasExactKeys(req, ['id', 'op', 'kind', 'params'])) return no('T.shape', 'a sendTx request has exactly: id, op, kind, params'); // PIN:T.shape
  if (typeof req.kind !== 'string' || !Object.hasOwn(TX_KINDS, req.kind)) return no('T.kind', `kind must be one of: ${Object.keys(TX_KINDS).join(', ')}`); // PIN:T.kind
  if (!hasExactKeys(req.params, TX_KINDS[req.kind])) return no('T.params', `${req.kind} takes exactly: ${TX_KINDS[req.kind].join(', ') || 'no parameters'}`); // PIN:T.params
  const plan = { kind: req.kind };
  const p = req.params;
  if (['approveWeth', 'wrap', 'unwrap', 'returnWethToFunding'].includes(req.kind)) {
    plan.amount = parseWeiString(p.amountWei);
    if (plan.amount === null || plan.amount === 0n) return no('T.amount', 'amountWei must be a positive decimal string of wei'); // PIN:T.amount
  }
  if (req.kind === 'approveWeth' && plan.amount > policy.maxAllowanceWei) return no('T.approveMax', 'that approval is above policy.maxAllowanceWei'); // PIN:T.approveMax
  if (req.kind === 'wrap' && plan.amount > policy.maxWrapWei) return no('T.wrapMax', 'that wrap is above policy.maxWrapWei'); // PIN:T.wrapMax
  if (req.kind === 'cancelOnChain') {
    if (!Array.isArray(p.orderHashes) || p.orderHashes.length === 0 || p.orderHashes.length > MAX_CANCEL_ORDERS) return no('T.cancelCount', `orderHashes must list 1 to ${MAX_CANCEL_ORDERS} orders`); // PIN:T.cancelCount
    if (!p.orderHashes.every(isBytes32)) return no('T.cancelFormat', 'every order hash must be 0x + 64 hex'); // PIN:T.cancelFormat
    if (new Set(p.orderHashes.map(lc)).size !== p.orderHashes.length) return no('T.cancelDupes', 'an order is listed twice'); // PIN:T.cancelDupes
    if (!p.orderHashes.every((h) => knownOrders.has(lc(h)))) return no('T.cancelKnown', 'the signer only cancels orders it signed itself'); // PIN:T.cancelKnown
    plan.orders = p.orderHashes.map((h) => knownOrders.get(lc(h)));
  }
  if (req.kind === 'setNftApproval' || req.kind === 'returnNftToFunding') {
    if (typeof p.slug !== 'string' || !Object.hasOwn(policy.collections, p.slug)) return no('T.nftSlug', 'that collection is not in the policy'); // PIN:T.nftSlug
    plan.slug = p.slug;
    plan.collection = policy.collections[p.slug].address;
  }
  if (req.kind === 'setNftApproval') {
    if (typeof p.approved !== 'boolean') return no('T.nftBool', 'approved must be true or false'); // PIN:T.nftBool
    plan.approved = p.approved;
    if (p.approved && !policy.collections[p.slug].enabled) return no('T.nftEnabled', 'NFT approval is only granted for an enabled collection'); // PIN:T.nftEnabled
    if (p.approved && policy.listing.enabled !== true) return no('T.nftListing', 'NFT approval is only needed to list, and listing is off in this version'); // PIN:T.nftListing
  }
  if (req.kind === 'returnNftToFunding') {
    plan.tokenId = typeof p.tokenId === 'string' ? parseUint(p.tokenId, UINT256_MAX) : null;
    if (plan.tokenId === null) return no('T.tokenId', 'tokenId must be a decimal string'); // PIN:T.tokenId
  }
  if (stopped && !reducesRisk(plan)) return no('T.stop', 'a STOP file is in the keys folder; only cancels, revokes and returns home are sent'); // PIN:T.stop
  return { ok: true, plan };
}

function allowedTarget(plan) {
  switch (plan.kind) {
    case 'approveWeth':
    case 'revokeWeth':
    case 'wrap':
    case 'unwrap':
    case 'returnWethToFunding':
      return WETH;
    case 'incrementCounter':
    case 'cancelOnChain':
      return SEAPORT;
    case 'setNftApproval':
    case 'returnNftToFunding':
      return plan.collection;
    default:
      return null;
  }
}

/** The offerer word of each order inside cancel(OrderComponents[]) calldata. */
function cancelOfferers(data) {
  const args = argsOf(data);
  const arrayAt = Number(wordAt(args, 0)) / 32;
  const count = Number(wordAt(args, arrayAt));
  const out = [];
  for (let i = 0; i < count; i++) {
    const elementOffset = Number(wordAt(args, arrayAt + 1 + i));
    out.push(addressAt(args, arrayAt + 1 + elementOffset / 32));
  }
  return out;
}

/**
 * The final check over a built EIP-1559 transaction, before it is signed.
 * ctx: { policy, house, plan, kill } (kill: true for the kill's own transactions).
 */
export function checkTx(tx, { policy, house, plan, kill }) {
  if (tx.type !== 2) return no('T.type', 'only EIP-1559 (type 2) transactions are signed; never type 4 (EIP-7702) or legacy'); // PIN:T.type
  if (tx.chainId !== CHAIN_ID) return no('T.chainId', 'the transaction is not for Ethereum mainnet'); // PIN:T.chainId
  if (tx.authorizationList !== undefined || tx.blobVersionedHashes !== undefined) return no('T.auth', 'no EIP-7702 authorizations or blobs'); // PIN:T.auth
  if (!Array.isArray(tx.accessList) || tx.accessList.length !== 0) return no('T.accessList', 'the access list must be empty'); // PIN:T.accessList
  if (!isAddress(tx.to)) return no('T.create', 'a transaction must have a recipient (never contract creation)'); // PIN:T.create
  if (!eqAddr(tx.to, allowedTarget(plan))) return no('T.to', `${plan.kind} may only call ${allowedTarget(plan)}`); // PIN:T.to
  if (!isHexData(tx.data) || tx.data.slice(0, 10).toLowerCase() !== SELECTOR_BY_KIND[plan.kind]) return no('T.selector', `the calldata is not ${plan.kind}'s function`); // PIN:T.selector
  if (plan.kind === 'wrap' ? tx.value !== plan.amount : tx.value !== 0n) return no('T.value', 'only a wrap sends ETH, and exactly its amount'); // PIN:T.value
  if (tx.value > policy.maxWrapWei) return no('T.valueMax', 'the ETH sent is above policy.maxWrapWei'); // PIN:T.valueMax
  if (tx.maxFeePerGas > (kill ? policy.gas.maxFeeWei : normalFeeCap(policy))) return no('T.maxFee', 'the fee is above the policy cap'); // PIN:T.maxFee
  if (tx.maxPriorityFeePerGas > tx.maxFeePerGas) return no('T.tip', 'the tip is above the max fee'); // PIN:T.tip
  if (tx.maxPriorityFeePerGas > (kill ? policy.gas.killPriorityWei : policy.gas.priorityWei)) return no('T.tipCap', 'the tip is above the policy tip'); // PIN:T.tipCap
  if (tx.gas > policy.gas.maxGasLimit) return no('T.gas', 'the gas limit is above policy.gas.maxGasLimit'); // PIN:T.gas
  const args = argsOf(tx.data);
  if ((plan.kind === 'approveWeth' || plan.kind === 'revokeWeth') && !eqAddr(addressAt(args, 0), OPENSEA_CONDUIT)) return no('T.spender', 'WETH is only ever approved to the OpenSea conduit'); // PIN:T.spender
  if (plan.kind === 'approveWeth' && wordAt(args, 1) > policy.maxAllowanceWei) return no('T.allowance', 'the approval is above policy.maxAllowanceWei'); // PIN:T.allowance
  if (plan.kind === 'revokeWeth' && wordAt(args, 1) !== 0n) return no('T.revokeZero', 'a revoke sets the allowance to zero'); // PIN:T.revokeZero
  if (plan.kind === 'returnWethToFunding' && !eqAddr(addressAt(args, 0), policy.fundingWallet)) return no('T.fundingWeth', 'WETH only ever goes back to the funding wallet'); // PIN:T.fundingWeth
  if (plan.kind === 'returnNftToFunding' && (!eqAddr(addressAt(args, 0), house) || !eqAddr(addressAt(args, 1), policy.fundingWallet))) return no('T.fundingNft', 'an NFT only ever goes from the house to the funding wallet'); // PIN:T.fundingNft
  if (plan.kind === 'setNftApproval' && !eqAddr(addressAt(args, 0), OPENSEA_CONDUIT)) return no('T.operator', 'NFT approval only ever goes to the OpenSea conduit'); // PIN:T.operator
  if (plan.kind === 'setNftApproval' && wordAt(args, 1) !== 0n && !policy.collections[plan.slug].enabled) return no('T.operatorEnabled', 'NFT approval is only granted for an enabled collection'); // PIN:T.operatorEnabled
  if (plan.kind === 'cancelOnChain' && !cancelOfferers(tx.data).every((a) => eqAddr(a, house))) return no('T.cancelOwn', 'an on-chain cancel only ever carries the house\'s own orders'); // PIN:T.cancelOwn
  return { ok: true };
}
