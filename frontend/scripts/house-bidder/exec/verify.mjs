// Checking what the signer signed, before anything is posted.
//
// The signer is the firewall: it builds and pins every field itself. The bot still checks its
// answer independently, with different code, because "no post without a verified signature"
// is only worth something if the check does not trust the thing it checks:
//   1. the order is the one the bot asked for (house, zone, the build's NFT line, the WETH
//      offer at price x quantity, OpenSea's exact 1% line, optional lines only as the policy
//      says, the requested times);
//   2. the signature recovers to the house over that exact order (viem, EIP-712, Seaport 1.6 domain);
//   3. the order hash the signer returned is Seaport's own: computed here, and asked of the
//      Seaport 1.6 contract itself with getOrderHash over eth_call.
// Any failure means the signer, the bot or an RPC is not what it should be, and the bot halts.

import { decodeFunctionResult, encodeFunctionData, hashStruct, recoverTypedDataAddress } from 'viem';
import { COLLECTIONS, ITEM, OPENSEA_CONDUIT_KEY, OPENSEA_FEE, ORDER, SEAPORT_16, SEAPORT_DOMAIN, SEAPORT_TYPES, SIGNED_ZONE, WETH, ZERO32 } from '../brain/constants.mjs';
import { addr, bpsOf, toWei } from '../brain/util.mjs';

const ITEM_ABI = [
  { name: 'itemType', type: 'uint8' },
  { name: 'token', type: 'address' },
  { name: 'identifierOrCriteria', type: 'uint256' },
  { name: 'startAmount', type: 'uint256' },
  { name: 'endAmount', type: 'uint256' },
];
/** Seaport 1.6 getOrderHash(OrderComponents) — view, returns the EIP-712 struct hash. */
export const GET_ORDER_HASH_ABI = [
  {
    type: 'function',
    name: 'getOrderHash',
    stateMutability: 'view',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          { name: 'offerer', type: 'address' },
          { name: 'zone', type: 'address' },
          { name: 'offer', type: 'tuple[]', components: ITEM_ABI },
          { name: 'consideration', type: 'tuple[]', components: [...ITEM_ABI, { name: 'recipient', type: 'address' }] },
          { name: 'orderType', type: 'uint8' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'zoneHash', type: 'bytes32' },
          { name: 'salt', type: 'uint256' },
          { name: 'conduitKey', type: 'bytes32' },
          { name: 'counter', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'orderHash', type: 'bytes32' }],
  },
];

const item = (i, withRecipient) => {
  const out = {
    itemType: Number(i.itemType),
    token: addr(i.token),
    identifierOrCriteria: toWei(i.identifierOrCriteria, 'identifierOrCriteria'),
    startAmount: toWei(i.startAmount, 'startAmount'),
    endAmount: toWei(i.endAmount, 'endAmount'),
  };
  if (withRecipient) out.recipient = addr(i.recipient);
  return out;
};

/** OrderComponents (the signed struct) from the signer's OrderParameters plus its counter. */
export function orderComponentsFrom(parameters, counter) {
  return {
    offerer: addr(parameters.offerer),
    zone: addr(parameters.zone),
    offer: parameters.offer.map((i) => item(i, false)),
    consideration: parameters.consideration.map((i) => item(i, true)),
    orderType: Number(parameters.orderType),
    startTime: toWei(parameters.startTime, 'startTime'),
    endTime: toWei(parameters.endTime, 'endTime'),
    zoneHash: String(parameters.zoneHash).toLowerCase(),
    salt: toWei(parameters.salt, 'salt'),
    conduitKey: String(parameters.conduitKey).toLowerCase(),
    counter: toWei(counter, 'counter'),
  };
}

/**
 * OpenSea's build answer against the pinned shape: SignedZone, a zero zoneHash, and exactly one
 * NFT line that is a collection bid (criteria 0) for `qty` NFTs paid to the house. Anything else
 * (an extra line, another recipient, a trait root) is refused before the signer is ever asked.
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkBuild(build, { slug, qty, house }) {
  const problems = [];
  const no = (why) => problems.push(why);
  const collection = COLLECTIONS[slug]?.address;
  if (!build || typeof build !== 'object') return { ok: false, problems: ['no build answer'] };
  if (addr(build.zone) !== SIGNED_ZONE) no(`zone ${build.zone} is not OpenSea's SignedZone`);
  if (String(build.zoneHash).toLowerCase() !== ZERO32) no('zoneHash is not zero');
  const lines = Array.isArray(build.consideration) ? build.consideration : [];
  if (lines.length !== 1) no(`${lines.length} consideration lines, not exactly one NFT line`);
  const l = lines[0];
  if (l) {
    let n;
    try {
      n = item(l, true);
    } catch (e) {
      no(`the NFT line cannot be read: ${e.message}`);
    }
    if (n) {
      if (n.itemType !== ITEM.ERC721_WITH_CRITERIA) no(`itemType ${n.itemType} is not a collection-wide ERC721 line (4)`);
      if (n.token !== collection) no(`the NFT line is for ${n.token}, not ${slug}`);
      if (n.identifierOrCriteria !== 0n) no('the criteria is not 0 (a trait or token bid, which v1 never makes)');
      if (n.startAmount !== BigInt(qty) || n.endAmount !== BigInt(qty)) no(`the NFT line is for ${n.startAmount}-${n.endAmount} NFTs, not ${qty}`);
      if (n.recipient !== house) no(`the NFT line pays ${n.recipient}, not the house`);
    }
  }
  return { ok: problems.length === 0, problems };
}

const sameItem = (a, b) => a.itemType === b.itemType && a.token === b.token && a.identifierOrCriteria === b.identifierOrCriteria && a.startAmount === b.startAmount && a.endAmount === b.endAmount && a.recipient === b.recipient;
const feeLine = (amount, recipient) => ({ itemType: ITEM.ERC20, token: WETH, identifierOrCriteria: 0n, startAmount: amount, endAmount: amount, recipient });

/**
 * The order the bot asked for, checked field by field against what the signer returned.
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkSignedBid({ request, response, build, house, policy, knownCounter = null }) {
  const problems = [];
  const no = (why) => problems.push(why);
  let o;
  try {
    if (!response || response.ok !== true) return { ok: false, problems: ['the signer did not sign'] };
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(response.orderHash))) no('the order hash is not 32 bytes');
    if (!/^0x[0-9a-fA-F]{130}$/.test(String(response.signature))) no('the signature is not 65 bytes');
    o = orderComponentsFrom(response.parameters, response.counter);
  } catch (e) {
    return { ok: false, problems: [...problems, `the signed order cannot be read: ${e.message}`] };
  }
  const qty = BigInt(request.qty);
  const unit = toWei(request.unitPriceWei, 'unitPriceWei');
  const total = unit * qty;
  const collection = COLLECTIONS[request.slug]?.address;

  if (o.offerer !== house) no(`offerer ${o.offerer} is not the house`);
  if (o.zone !== SIGNED_ZONE) no(`zone ${o.zone} is not OpenSea's SignedZone`);
  if (o.zoneHash !== ZERO32) no('zoneHash is not zero');
  if (o.conduitKey !== OPENSEA_CONDUIT_KEY) no("conduitKey is not OpenSea's");
  if (o.orderType !== ORDER.FULL_RESTRICTED && o.orderType !== ORDER.PARTIAL_RESTRICTED) no(`orderType ${o.orderType} is not a restricted order`);
  if (qty > 1n && o.orderType !== ORDER.PARTIAL_RESTRICTED) no('a bid for more than one NFT must allow partial fills');
  if (o.startTime !== BigInt(request.startTime)) no('startTime is not the one asked for');
  if (o.endTime !== BigInt(request.endTime)) no('endTime is not the one asked for');
  if (Number(response.parameters.totalOriginalConsiderationItems) !== o.consideration.length) no('totalOriginalConsiderationItems is not the number of consideration lines');
  if (knownCounter !== null && o.counter < knownCounter) no(`signed with counter ${o.counter}, below the chain's ${knownCounter}`);

  if (o.offer.length !== 1) no(`${o.offer.length} offer lines, not 1`);
  else {
    const w = o.offer[0];
    if (w.itemType !== ITEM.ERC20 || w.token !== WETH || w.identifierOrCriteria !== 0n) no('the offer is not WETH');
    if (w.startAmount !== total || w.endAmount !== total) no(`the offer is ${w.startAmount} wei, not ${total}`);
  }

  // Line 1 is exactly the NFT line OpenSea's build returned (already checked against the pins).
  const nft = build?.consideration?.[0] ? item(build.consideration[0], true) : null;
  if (!nft || !o.consideration[0] || !sameItem(o.consideration[0], nft)) no('the first consideration line is not the NFT line the build returned');
  if (nft && (nft.itemType !== ITEM.ERC721_WITH_CRITERIA || nft.token !== collection || nft.identifierOrCriteria !== 0n || nft.recipient !== house)) no('the NFT line is not a collection bid paying the house');

  // Line 2 is OpenSea's 1%; then only the lines the policy turns on, each exact.
  const expectFees = [feeLine(bpsOf(total, OPENSEA_FEE.bps), OPENSEA_FEE.recipient)];
  const optional = [];
  const cf = policy.collections[request.slug]?.creatorFee;
  if (cf) optional.push(feeLine(bpsOf(total, cf.bps), cf.recipient));
  if (policy.venueFee) optional.push(feeLine(bpsOf(total, policy.venueFee.bps), policy.venueFee.recipient));
  if (!o.consideration[1] || !sameItem(o.consideration[1], expectFees[0])) no("the second consideration line is not OpenSea's exact 1% fee");
  const rest = o.consideration.slice(2);
  if (rest.length !== optional.length) no(`${rest.length} further fee lines, the policy allows ${optional.length}`);
  for (const want of optional) if (!rest.some((l) => sameItem(l, want))) no(`the fee line to ${want.recipient} is missing or not exact`);
  for (const line of o.consideration) {
    if (line.startAmount % qty !== 0n || line.endAmount % qty !== 0n) no('a line does not divide by the quantity (a partial fill would revert)');
  }
  return { ok: problems.length === 0, problems, components: o };
}

/** getOrderHash on the Seaport 1.6 contract itself, through an injected eth_call. */
export function seaportOrderHash(call) {
  return async (components) => {
    const data = encodeFunctionData({ abi: GET_ORDER_HASH_ABI, functionName: 'getOrderHash', args: [components] });
    const out = await call({ to: SEAPORT_16, data });
    return String(decodeFunctionResult({ abi: GET_ORDER_HASH_ABI, functionName: 'getOrderHash', data: out })).toLowerCase();
  };
}

/** The EIP-712 struct hash of an order, computed here: what Seaport's getOrderHash returns. */
export const localOrderHash = (components) => hashStruct({ data: components, primaryType: 'OrderComponents', types: SEAPORT_TYPES }).toLowerCase();

/**
 * All three checks. Never throws: a failure of any kind is { ok: false, field, reason }, and the
 * caller halts on 'signature-mismatch' or holds the order back on 'verify-unavailable'.
 */
export async function verifySignedBid({ request, response, build, house, policy, getOrderHash, knownCounter = null }) {
  const c = checkSignedBid({ request, response, build, house, policy, knownCounter });
  if (!c.ok) return { ok: false, field: 'order', reason: c.problems.join('; ') };
  const components = c.components;
  let recovered;
  try {
    recovered = (await recoverTypedDataAddress({ domain: SEAPORT_DOMAIN, types: SEAPORT_TYPES, primaryType: 'OrderComponents', message: components, signature: response.signature })).toLowerCase();
  } catch (e) {
    return { ok: false, field: 'signature', reason: `the signature does not recover: ${e.shortMessage ?? e.message}` };
  }
  if (recovered !== house) return { ok: false, field: 'signature', reason: `the signature recovers to ${recovered}, not the house` };
  const want = String(response.orderHash).toLowerCase();
  if (localOrderHash(components) !== want) return { ok: false, field: 'orderHash', reason: 'the order hash is not the hash of the signed order' };
  let onchain;
  try {
    onchain = await getOrderHash(components);
  } catch (e) {
    return { ok: false, field: 'verify-unavailable', reason: `Seaport's getOrderHash could not be read: ${e?.shortMessage ?? e?.message ?? e}` };
  }
  if (onchain !== want) return { ok: false, field: 'orderHash', reason: `Seaport 1.6 hashes the order to ${onchain}, the signer said ${want}` };
  return { ok: true, components };
}
