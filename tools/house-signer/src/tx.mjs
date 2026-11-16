// The transactions the house may send, built entirely here: the bot names a kind and its
// arguments, never calldata, a recipient, a value or a fee. policy.checkTx re-reads the
// finished transaction before it is signed.
//
// Serialization is EIP-1559 (type 2) only: 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas,
// maxFeePerGas, gas, to, value, data, accessList, yParity, r, s]). test/tx.test.mjs checks
// it against viem's serializeTransaction and signTransaction byte for byte.

import { encodeCall, SIGNATURES, ORDER_COMPONENTS, componentsTuple } from './abi.mjs';
import { CHAIN_ID, OPENSEA_CONDUIT, SEAPORT, WETH } from './constants.mjs';
import { keccak256 } from './keccak.mjs';
import { rlpEncode } from './rlp.mjs';
import { signDigest } from './sign.mjs';
import { bigintToMinimalBytes, bytesToHex, concatBytes, hexToBytes } from './hex.mjs';

// Gas limits per kind, from Seaport/WETH gas measured 2026-11-15 (BUILD-SPEC section 1)
// with headroom. Unused gas is not charged, so a generous limit costs nothing; a limit
// that is too low would revert and waste the fee.
const GAS = Object.freeze({
  approveWeth: 60_000n,
  revokeWeth: 60_000n,
  wrap: 60_000n,
  unwrap: 60_000n,
  returnWethToFunding: 70_000n,
  incrementCounter: 80_000n,
  setNftApproval: 80_000n,
  returnNftToFunding: 200_000n,
});
const CANCEL_GAS_FIRST = 80_000n;
const CANCEL_GAS_EACH = 35_000n;

export function gasLimitFor(plan) {
  if (plan.kind === 'cancelOnChain') return CANCEL_GAS_FIRST + CANCEL_GAS_EACH * BigInt(plan.orders.length - 1);
  return GAS[plan.kind];
}

/** { to, data, value } for a checked plan from policy.checkTxRequest. */
export function buildCall(plan, { policy, house }) {
  switch (plan.kind) {
    case 'approveWeth':
      return { to: WETH, data: encodeCall(SIGNATURES.approve, ['address', 'uint256'], [OPENSEA_CONDUIT, plan.amount]), value: 0n };
    case 'revokeWeth':
      return { to: WETH, data: encodeCall(SIGNATURES.approve, ['address', 'uint256'], [OPENSEA_CONDUIT, 0n]), value: 0n };
    case 'wrap':
      return { to: WETH, data: encodeCall(SIGNATURES.deposit, [], []), value: plan.amount };
    case 'unwrap':
      return { to: WETH, data: encodeCall(SIGNATURES.withdraw, ['uint256'], [plan.amount]), value: 0n };
    case 'returnWethToFunding':
      return { to: WETH, data: encodeCall(SIGNATURES.transfer, ['address', 'uint256'], [policy.fundingWallet, plan.amount]), value: 0n };
    case 'incrementCounter':
      return { to: SEAPORT, data: encodeCall(SIGNATURES.incrementCounter, [], []), value: 0n };
    case 'cancelOnChain':
      return {
        to: SEAPORT,
        data: encodeCall(SIGNATURES.cancel, [{ array: ORDER_COMPONENTS }], [plan.orders.map((o) => componentsTuple(o.components))]),
        value: 0n,
      };
    case 'setNftApproval':
      return { to: plan.collection, data: encodeCall(SIGNATURES.setApprovalForAll, ['address', 'bool'], [OPENSEA_CONDUIT, plan.approved]), value: 0n };
    case 'returnNftToFunding':
      // safeTransferFrom, not transferFrom: if the funding wallet were a contract that cannot
      // hold NFTs, the transfer reverts instead of locking the NFT there.
      return { to: plan.collection, data: encodeCall(SIGNATURES.safeTransferFrom, ['address', 'address', 'uint256'], [house, policy.fundingWallet, plan.tokenId]), value: 0n };
    default:
      throw new Error(`no call for ${plan.kind}`);
  }
}

const int = (v) => bigintToMinimalBytes(v);

function fields(tx) {
  return [
    int(tx.chainId),
    int(tx.nonce),
    int(tx.maxPriorityFeePerGas),
    int(tx.maxFeePerGas),
    int(tx.gas),
    hexToBytes(tx.to),
    int(tx.value),
    hexToBytes(tx.data),
    [],
  ];
}

/** The unsigned payload whose keccak the house key signs. */
export function serializeUnsigned(tx) {
  return bytesToHex(concatBytes(Uint8Array.of(0x02), rlpEncode(fields(tx))));
}

export function serializeSigned(tx, { yParity, r, s }) {
  return bytesToHex(concatBytes(Uint8Array.of(0x02), rlpEncode([...fields(tx), int(BigInt(yParity)), int(r), int(s)])));
}

/**
 * Sign a checked transaction. signDigest recovers the signature and compares it with the
 * house address before returning it (PIN:P16), so a raw transaction from someone else's
 * key can never be produced here.
 */
export function signTx(tx, privateKey, house) {
  if (tx.type !== 2 || tx.chainId !== CHAIN_ID) return { ok: false, field: 'type', reason: 'only type 2 mainnet transactions are signed' };
  const digest = bytesToHex(keccak256(hexToBytes(serializeUnsigned(tx))));
  const sig = signDigest({ digest, privateKey, expected: house });
  if (!sig.ok) return sig;
  const raw = serializeSigned(tx, sig);
  return { ok: true, raw, hash: bytesToHex(keccak256(hexToBytes(raw))) };
}
