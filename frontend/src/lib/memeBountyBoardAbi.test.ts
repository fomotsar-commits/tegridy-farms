import { describe, it, expect } from 'vitest';
import { decodeFunctionResult, encodeAbiParameters, type AbiFunction } from 'viem';
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
// (2026-05-31, "over-declare is the decode-breaking direction"). A second,
// redundant copy lived on in the wagmi-generated src/generated.ts, which was
// never re-run through codegen; that file does not exist on this branch, and
// the orphaned wagmi.config.ts that would have recreated it has now been
// deleted. src/lib/contracts.ts (+ its generated ./abi-supplement half) is the
// single ABI source of truth. This test pins the shape so it cannot drift back.
//
// Note the bug would have hidden anyway: bountyCount() == 0 on the live board,
// so the read reverts with Panic(0x32) on the array access before decoding is
// ever reached. See also the final two tests — over-declaring here could not
// have thrown even with a populated board.
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
  it('declares exactly the 7 outputs the deployed contract returns', () => {
    const entry = getBountyOf(MEME_BOUNTY_BOARD_ABI);
    expect(entry).toBeDefined();
    // Pins the invariant, not a literal count: the shipped ABI must equal the
    // deployed tuple field-for-field.
    expect(entry.outputs.map((o) => ({ name: o.name, type: o.type }))).toEqual(
      DEPLOYED_GET_BOUNTY_OUTPUTS.map((o) => ({ name: o.name, type: o.type })),
    );
  });

  it('decodes a real bounty payload without throwing', () => {
    const decoded = decodeFunctionResult({
      abi: MEME_BOUNTY_BOARD_ABI,
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
