// A small Solidity ABI encoder, enough for the calls the signer itself builds and no more.
//
// Types: 'address', 'uint8', 'uint256', 'bytes32', 'bool', 'bytes', { tuple: [types] } and
// { array: type } (dynamic arrays only). Values are bigints, booleans and 0x hex strings;
// a tuple's value is an array of its members in order. The output is checked byte for
// byte against viem's encodeFunctionData in test/abi.test.mjs.

import { selectorOf } from './keccak.mjs';
import {
  bigintToBytes, bytesToBigint, concatBytes, hexToBytes, isAddress, isBytes32, isHexData, bytesToHex,
} from './hex.mjs';

const WORD = 32;

function isDynamic(type) {
  if (type === 'bytes') return true;
  if (typeof type === 'object' && type.array) return true;
  if (typeof type === 'object' && type.tuple) return type.tuple.some(isDynamic);
  return false;
}

function staticSize(type) {
  if (typeof type === 'object' && type.tuple) return type.tuple.reduce((s, t) => s + staticSize(t), 0);
  return WORD;
}

function encodeWord(type, value) {
  switch (type) {
    case 'address':
      if (!isAddress(value)) throw new Error('abi: bad address');
      return bigintToBytes(BigInt(value), WORD);
    case 'uint8':
      if (typeof value !== 'bigint' || value < 0n || value > 255n) throw new Error('abi: bad uint8');
      return bigintToBytes(value, WORD);
    case 'uint256':
      if (typeof value !== 'bigint') throw new Error('abi: uint256 must be a bigint');
      return bigintToBytes(value, WORD);
    case 'bytes32':
      if (!isBytes32(value)) throw new Error('abi: bad bytes32');
      return hexToBytes(value);
    case 'bool':
      if (typeof value !== 'boolean') throw new Error('abi: bad bool');
      return bigintToBytes(value ? 1n : 0n, WORD);
    default:
      throw new Error(`abi: unsupported type ${JSON.stringify(type)}`);
  }
}

function encodeValue(type, value) {
  if (type === 'bytes') {
    if (!isHexData(value)) throw new Error('abi: bad bytes');
    const raw = hexToBytes(value);
    const padded = new Uint8Array(Math.ceil(raw.length / WORD) * WORD);
    padded.set(raw);
    return concatBytes(bigintToBytes(BigInt(raw.length), WORD), padded);
  }
  if (typeof type === 'object' && type.tuple) {
    if (!Array.isArray(value) || value.length !== type.tuple.length) throw new Error('abi: tuple arity');
    return encodeParams(type.tuple, value);
  }
  if (typeof type === 'object' && type.array) {
    if (!Array.isArray(value)) throw new Error('abi: expected an array');
    return concatBytes(bigintToBytes(BigInt(value.length), WORD), encodeParams(value.map(() => type.array), value));
  }
  return encodeWord(type, value);
}

/** Head/tail encoding of a list of values, as for a function's arguments. */
export function encodeParams(types, values) {
  if (types.length !== values.length) throw new Error('abi: argument count');
  const heads = [];
  const tails = [];
  let offset = types.reduce((s, t) => s + (isDynamic(t) ? WORD : staticSize(t)), 0);
  types.forEach((type, i) => {
    const encoded = encodeValue(type, values[i]);
    if (isDynamic(type)) {
      heads.push(bigintToBytes(BigInt(offset), WORD));
      tails.push(encoded);
      offset += encoded.length;
    } else {
      heads.push(encoded);
    }
  });
  return concatBytes(...heads, ...tails);
}

export function encodeCall(signature, types, values) {
  return bytesToHex(concatBytes(hexToBytes(selectorOf(signature)), encodeParams(types, values)));
}

// --- Seaport struct shapes --------------------------------------------------------------

export const OFFER_ITEM = { tuple: ['uint8', 'address', 'uint256', 'uint256', 'uint256'] };
export const CONSIDERATION_ITEM = { tuple: ['uint8', 'address', 'uint256', 'uint256', 'uint256', 'address'] };
// OrderComponents and OrderParameters share one layout: the last word is the counter in
// the first and totalOriginalConsiderationItems in the second.
export const ORDER_COMPONENTS = {
  tuple: [
    'address', 'address', { array: OFFER_ITEM }, { array: CONSIDERATION_ITEM },
    'uint8', 'uint256', 'uint256', 'bytes32', 'uint256', 'bytes32', 'uint256',
  ],
};
export const ORDER = { tuple: [ORDER_COMPONENTS, 'bytes'] };

const ITEM_SIG = '(uint8,address,uint256,uint256,uint256)';
const CITEM_SIG = '(uint8,address,uint256,uint256,uint256,address)';
const COMPONENTS_SIG = `(address,address,${ITEM_SIG}[],${CITEM_SIG}[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256)`;

// Every function the signer encodes or reads. test/abi.test.mjs pins each selector.
export const SIGNATURES = Object.freeze({
  approve: 'approve(address,uint256)',
  deposit: 'deposit()',
  withdraw: 'withdraw(uint256)',
  transfer: 'transfer(address,uint256)',
  incrementCounter: 'incrementCounter()',
  cancel: `cancel(${COMPONENTS_SIG}[])`,
  setApprovalForAll: 'setApprovalForAll(address,bool)',
  safeTransferFrom: 'safeTransferFrom(address,address,uint256)',
  getCounter: 'getCounter(address)',
  getOrderHash: `getOrderHash(${COMPONENTS_SIG})`,
  validate: `validate((${COMPONENTS_SIG},bytes)[])`,
  information: 'information()',
  balanceOf: 'balanceOf(address)',
  allowance: 'allowance(address,address)',
  getConduit: 'getConduit(bytes32)',
});

export const SELECTORS = Object.freeze(
  Object.fromEntries(Object.entries(SIGNATURES).map(([k, sig]) => [k, selectorOf(sig)])),
);

/** OrderComponents (bigints inside) -> the tuple value the encoder takes. */
export function componentsTuple(c, lastWord = c.counter) {
  return [
    c.offerer,
    c.zone,
    c.offer.map((o) => [BigInt(o.itemType), o.token, o.identifierOrCriteria, o.startAmount, o.endAmount]),
    c.consideration.map((o) => [BigInt(o.itemType), o.token, o.identifierOrCriteria, o.startAmount, o.endAmount, o.recipient]),
    BigInt(c.orderType),
    c.startTime,
    c.endTime,
    c.zoneHash,
    c.salt,
    c.conduitKey,
    lastWord,
  ];
}

// --- reading return data ----------------------------------------------------------------

function words(data) {
  if (!isHexData(data)) throw new Error('abi: return data is not hex');
  const bytes = hexToBytes(data);
  if (bytes.length % WORD !== 0) throw new Error('abi: return data is not whole words');
  return bytes;
}

/** The n-th 32-byte word of return data (or of calldata after its selector), as a bigint. */
export function wordAt(data, n) {
  const bytes = words(data);
  if ((n + 1) * WORD > bytes.length) throw new Error('abi: return data too short');
  return bytesToBigint(bytes.slice(n * WORD, (n + 1) * WORD));
}

/** The n-th word as an address; refuses a word with anything above the low 20 bytes. */
export function addressAt(data, n) {
  const v = wordAt(data, n);
  if (v >> 160n !== 0n) throw new Error('abi: word is not an address');
  return `0x${v.toString(16).padStart(40, '0')}`;
}

/** A dynamic string whose offset word is the n-th word. */
export function stringAt(data, n) {
  const bytes = words(data);
  const offset = Number(wordAt(data, n));
  if (offset % WORD !== 0 || offset + WORD > bytes.length) throw new Error('abi: bad string offset');
  const length = Number(bytesToBigint(bytes.slice(offset, offset + WORD)));
  if (offset + WORD + length > bytes.length) throw new Error('abi: string runs past the data');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(offset + WORD, offset + WORD + length));
}

/** Calldata with its 4-byte selector removed, for reading the arguments back. */
export function argsOf(calldata) {
  if (!isHexData(calldata) || calldata.length < 10) throw new Error('abi: calldata too short');
  return `0x${calldata.slice(10)}`;
}
