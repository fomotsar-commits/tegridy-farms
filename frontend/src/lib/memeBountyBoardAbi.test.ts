import { describe, it, expect } from 'vitest';
import { decodeFunctionResult, encodeAbiParameters, type AbiFunction } from 'viem';
import { memeBountyBoardAbi } from '../generated';
import { MEME_BOUNTY_BOARD_ABI } from './contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Regression guard for the `getBounty` ABI-arity drift found 2026-07-23.
//
// GROUND TRUTH — the return shape below is the *deployed* one, taken from the
// Etherscan-verified ABI of the Wave-0 MemeBountyBoard at
// 0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9, and it matches
// contracts/src/MemeBountyBoard.sol:841-847 exactly. SEVEN values.
//
// History: a phantom 8th `dummy` output was introduced in the hand-written
// MEME_BOUNTY_BOARD_ABI (28e0348, 2026-03-24) and removed there in fe60a2d
// (2026-05-31, "over-declare is the decode-breaking direction") — but
// src/generated.ts was never re-run through `wagmi generate`, so the stale
// 8-value copy survived. Over-declaring makes viem demand 32 extra bytes that
// the contract never returns, so every decode throws.
//
// The bug hid because bountyCount() == 0 on the live board: the read reverts
// with Panic(0x32) on the array access before decoding is ever reached.
//
// NOTE: the Solidity return widths are deliberately uint256 even though the
// storage struct is repacked to uint96/uint48 — the packing is intentionally
// invisible to the ABI. Do not "fix" the source to match storage.
// ─────────────────────────────────────────────────────────────────────────────

/** The exact output tuple the deployed contract encodes. */
const DEPLOYED_GET_BOUNTY_OUTPUTS = [
  { name: 'creator', type: 'address' },
  { name: 'description', type: 'string' },
  { name: 'reward', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
  { name: 'winner', type: 'address' },
  { name: 'submCount', type: 'uint256' },
  { name: 'status', type: 'uint8' },
] as const;

/** A realistic bounty, encoded the way the live contract would return it. */
const BOUNTY = {
  creator: '0x1489a1B0dF0e5F7B2C4d3E6a7b8c9D0e1F2A3456',
  description: 'Best TOWELI meme — towel not included',
  reward: 250_000_000_000_000_000n, // 0.25 ETH
  deadline: 1_784_000_000n,
  winner: '0x0000000000000000000000000000000000000000',
  submCount: 3n,
  status: 1, // BountyStatus.Active
} as const;

const REAL_RETURN_DATA = encodeAbiParameters(DEPLOYED_GET_BOUNTY_OUTPUTS, [
  BOUNTY.creator,
  BOUNTY.description,
  BOUNTY.reward,
  BOUNTY.deadline,
  BOUNTY.winner,
  BOUNTY.submCount,
  BOUNTY.status,
]);

const getBountyOf = (abi: readonly unknown[]) =>
  (abi as AbiFunction[]).find((e) => e.type === 'function' && e.name === 'getBounty')!;

describe('MemeBountyBoard getBounty ABI — arity matches deployed bytecode', () => {
  it('generated.ts declares exactly the 7 outputs the contract returns', () => {
    const entry = getBountyOf(memeBountyBoardAbi);
    expect(entry).toBeDefined();
    // Pins the invariant, not a literal count: generated must equal ground truth.
    expect(entry.outputs.map((o) => ({ name: o.name, type: o.type }))).toEqual(
      DEPLOYED_GET_BOUNTY_OUTPUTS.map((o) => ({ name: o.name, type: o.type })),
    );
  });

  it('decodes a real bounty payload via generated.ts without throwing', () => {
    const decoded = decodeFunctionResult({
      abi: memeBountyBoardAbi,
      functionName: 'getBounty',
      data: REAL_RETURN_DATA,
    }) as readonly [string, string, bigint, bigint, string, bigint, number];

    expect(decoded).toHaveLength(7);
    expect(decoded[0]).toBe(BOUNTY.creator);
    expect(decoded[1]).toBe(BOUNTY.description);
    expect(decoded[2]).toBe(BOUNTY.reward);
    expect(decoded[3]).toBe(BOUNTY.deadline);
    expect(decoded[4]).toBe(BOUNTY.winner);
    expect(decoded[5]).toBe(BOUNTY.submCount);
    expect(decoded[6]).toBe(BOUNTY.status);
  });

  it('decodes the same payload via the hand-written lib/contracts ABI', () => {
    const decoded = decodeFunctionResult({
      abi: MEME_BOUNTY_BOARD_ABI,
      functionName: 'getBounty',
      data: REAL_RETURN_DATA,
    }) as readonly [string, string, bigint, bigint, string, bigint, number];

    expect(decoded).toHaveLength(7);
    expect(decoded[2]).toBe(BOUNTY.reward);
    expect(decoded[6]).toBe(BOUNTY.status);
  });

  it('generated.ts and lib/contracts.ts do not drift apart', () => {
    // wagmi.config.ts generates src/generated.ts *from* MEME_BOUNTY_BOARD_ABI,
    // so the two must stay identical. This is the guard that would have caught
    // the 2026-05-31 fix landing in one file but not the other.
    expect(getBountyOf(memeBountyBoardAbi).outputs).toEqual(
      getBountyOf(MEME_BOUNTY_BOARD_ABI).outputs,
    );
  });

  // Why the stale ABI survived two months unnoticed. The obvious guess — "an
  // 8-value ABI against a 7-value return throws" — is WRONG here, and it is
  // worth pinning so nobody re-derives the wrong severity from first principles.
  //
  // getBounty returns a dynamic `string` at index 1, so the payload is
  // head (7 x 32B, with an offset pointer for the string) followed by a tail
  // that is ALWAYS at least one 32-byte length word. Head+tail is therefore
  // always >= 256B = 8 slots, so the phantom 8th slot never underflows: it
  // silently reads the string's length word instead. All 7 real values still
  // decode correctly. The defect is a bogus trailing element, not a broken read.
  it('over-declaring an 8th output silently yields garbage — it does NOT throw', () => {
    const overDeclared = [
      {
        type: 'function',
        name: 'getBounty',
        inputs: [{ name: '_id', type: 'uint256' }],
        outputs: [...DEPLOYED_GET_BOUNTY_OUTPUTS, { name: 'dummy', type: 'uint256' }],
        stateMutability: 'view',
      },
    ] as const;

    const decoded = decodeFunctionResult({
      abi: overDeclared,
      functionName: 'getBounty',
      data: REAL_RETURN_DATA,
    }) as readonly [string, string, bigint, bigint, string, bigint, number, bigint];

    expect(decoded).toHaveLength(8);
    // The 7 real fields are unharmed...
    expect(decoded[1]).toBe(BOUNTY.description);
    expect(decoded[2]).toBe(BOUNTY.reward);
    expect(decoded[6]).toBe(BOUNTY.status);
    // ...and the 8th is the UTF-8 byte length of `description`, not a real field.
    const descByteLength = BigInt(new TextEncoder().encode(BOUNTY.description).length);
    expect(decoded[7]).toBe(descByteLength);
  });

  // Even the degenerate case cannot throw: an empty description still emits a
  // 32-byte length word, landing the payload at exactly 256B = 8 slots.
  it('empty description still fills the phantom slot (no underflow path exists)', () => {
    const emptyDesc = encodeAbiParameters(DEPLOYED_GET_BOUNTY_OUTPUTS, [
      BOUNTY.creator,
      '',
      BOUNTY.reward,
      BOUNTY.deadline,
      BOUNTY.winner,
      BOUNTY.submCount,
      BOUNTY.status,
    ]);
    expect((emptyDesc.length - 2) / 2).toBe(256);
  });
});
