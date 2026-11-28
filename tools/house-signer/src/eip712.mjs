// EIP-712 for exactly two messages: a Seaport 1.6 order and OpenSea's gasless-cancel
// message. Nothing else can be hashed here.
//
// A general typed-data signer would sign whatever types and domain the caller hands it,
// which is how a wallet gets tricked into signing a Permit, a bulk-order tree or an order
// for another contract. This module takes no types, no domain and no primary type from
// anyone: the type strings, the domain and the struct layouts are fixed below, and the
// only inputs are the field values of those two structs. There is no bulk-order (merkle
// tree) path at all.
//
// The type strings are Seaport's own (unchanged since 1.1). The cancel message is the one
// opensea-js signs in src/sdk/cancellation.ts (getOffererSignature):
//   domain { chainId, name: "Seaport", version: getSeaportVersion(protocol) = "1.6",
//            verifyingContract: protocol }
//   types  { OrderHash: [{ name: "orderHash", type: "bytes32" }] }
// test/eip712.test.mjs checks every hash here against viem's hashTypedData / hashStruct.

import { keccak256, keccakText } from './keccak.mjs';
import { CHAIN_ID, SEAPORT, SEAPORT_NAME, SEAPORT_VERSION } from './constants.mjs';
import { bigintToBytes, bytesToHex, concatBytes, hexToBytes, isAddress, isBytes32 } from './hex.mjs';

const OFFER_ITEM_TYPE = 'OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)';
const CONSIDERATION_ITEM_TYPE = 'ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)';
const ORDER_COMPONENTS_TYPE = 'OrderComponents(address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)';
const ORDER_HASH_TYPE = 'OrderHash(bytes32 orderHash)';
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

// EIP-712 appends referenced struct types sorted by name: ConsiderationItem, then OfferItem.
export const TYPE_HASHES = Object.freeze({
  OfferItem: bytesToHex(keccakText(OFFER_ITEM_TYPE)),
  ConsiderationItem: bytesToHex(keccakText(CONSIDERATION_ITEM_TYPE)),
  OrderComponents: bytesToHex(keccakText(ORDER_COMPONENTS_TYPE + CONSIDERATION_ITEM_TYPE + OFFER_ITEM_TYPE)),
  OrderHash: bytesToHex(keccakText(ORDER_HASH_TYPE)),
  EIP712Domain: bytesToHex(keccakText(DOMAIN_TYPE)),
});

/** The one domain the signer signs under. Frozen; nothing can pass in another. */
export const SEAPORT_DOMAIN = Object.freeze({
  name: SEAPORT_NAME,
  version: SEAPORT_VERSION,
  chainId: CHAIN_ID,
  verifyingContract: SEAPORT,
});

function word(value) {
  return bigintToBytes(value, 32);
}

function addressWord(value) {
  if (!isAddress(value)) throw new Error('eip712: bad address');
  return word(BigInt(value));
}

function uint8Word(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('eip712: bad uint8');
  return word(BigInt(value));
}

function uintWord(value) {
  if (typeof value !== 'bigint') throw new Error('eip712: uint256 must be a bigint');
  return word(value);
}

function bytes32Word(value) {
  if (!isBytes32(value)) throw new Error('eip712: bad bytes32');
  return hexToBytes(value);
}

const DOMAIN_SEPARATOR = bytesToHex(keccak256(concatBytes(
  hexToBytes(TYPE_HASHES.EIP712Domain),
  keccakText(SEAPORT_DOMAIN.name),
  keccakText(SEAPORT_DOMAIN.version),
  uintWord(SEAPORT_DOMAIN.chainId),
  addressWord(SEAPORT_DOMAIN.verifyingContract),
)));

export function domainSeparator() {
  return DOMAIN_SEPARATOR;
}

function hashOfferItem(item) {
  return keccak256(concatBytes(
    hexToBytes(TYPE_HASHES.OfferItem),
    uint8Word(item.itemType),
    addressWord(item.token),
    uintWord(item.identifierOrCriteria),
    uintWord(item.startAmount),
    uintWord(item.endAmount),
  ));
}

function hashConsiderationItem(item) {
  return keccak256(concatBytes(
    hexToBytes(TYPE_HASHES.ConsiderationItem),
    uint8Word(item.itemType),
    addressWord(item.token),
    uintWord(item.identifierOrCriteria),
    uintWord(item.startAmount),
    uintWord(item.endAmount),
    addressWord(item.recipient),
  ));
}

/**
 * Seaport's order hash: hashStruct(OrderComponents). This is the value Seaport's
 * getOrderHash returns and the one OpenSea calls order_hash.
 */
export function hashOrderComponents(c) {
  if (!Array.isArray(c.offer) || !Array.isArray(c.consideration)) throw new Error('eip712: offer and consideration must be arrays');
  return bytesToHex(keccak256(concatBytes(
    hexToBytes(TYPE_HASHES.OrderComponents),
    addressWord(c.offerer),
    addressWord(c.zone),
    keccak256(concatBytes(...c.offer.map(hashOfferItem))),
    keccak256(concatBytes(...c.consideration.map(hashConsiderationItem))),
    uint8Word(c.orderType),
    uintWord(c.startTime),
    uintWord(c.endTime),
    bytes32Word(c.zoneHash),
    uintWord(c.salt),
    bytes32Word(c.conduitKey),
    uintWord(c.counter),
  )));
}

function digestOf(structHashHex) {
  return bytesToHex(keccak256(concatBytes(Uint8Array.of(0x19, 0x01), hexToBytes(DOMAIN_SEPARATOR), hexToBytes(structHashHex))));
}

/** { orderHash, digest }: the digest is what the house key signs for this order. */
export function orderDigest(components) {
  const orderHash = hashOrderComponents(components);
  return { orderHash, digest: digestOf(orderHash) };
}

/** The digest of OpenSea's gasless-cancel message for one order hash. */
export function cancelDigest(orderHash) {
  if (!isBytes32(orderHash)) throw new Error('eip712: order hash must be 32 bytes');
  const structHash = bytesToHex(keccak256(concatBytes(hexToBytes(TYPE_HASHES.OrderHash), bytes32Word(orderHash))));
  return digestOf(structHash);
}
