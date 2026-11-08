import { PublicKey, TransactionInstruction } from '@solana/web3.js';

/**
 * The trip's last instruction: Lighthouse (L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95, no longer
 * upgradeable) checks that the robot's coin account holds at least `min` once every swap has run.
 * If it does not, the whole transaction is undone (Lighthouse error 6001, 0x1771) and the trip
 * costs only its network fee.
 *
 * The bytes, read from Lighthouse transactions on mainnet 2026-11-05 (0x0f is its clock check,
 * 0x05 its account check, so 0x09 is its token-account check) and proven on mainnet the same day
 * from the robot's wallet: at the balance it passes, one unit over it fails with 6001.
 *   0      instruction    9 = AssertTokenAccount
 *   1      log level      0 = silent
 *   2      assertion      2 = Amount
 *   3..10  value          u64, little-endian
 *   11     operator       4 = GreaterThanOrEqual (the account's amount ≥ value)
 */
export const LIGHTHOUSE_PROGRAM = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
export const ASSERT_TOKEN_ACCOUNT = 9;
export const ASSERT_AMOUNT = 2;
export const GREATER_OR_EQUAL = 4;
/** Lighthouse's "assertion failed". */
export const LIGHTHOUSE_FAILED = 6001;

const U64_MAX = (1n << 64n) - 1n;

/** "The token account `account` holds at least `min`", as one Lighthouse instruction. */
export function atLeastCheck(account: PublicKey, min: bigint): TransactionInstruction {
  if (min < 0n || min > U64_MAX) throw new Error(`a Lighthouse floor must fit a u64, not ${min}`);
  const data = new Uint8Array(12);
  data[0] = ASSERT_TOKEN_ACCOUNT;
  data[1] = 0;
  data[2] = ASSERT_AMOUNT;
  new DataView(data.buffer).setBigUint64(3, min, true);
  data[11] = GREATER_OR_EQUAL;
  return new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM, keys: [{ pubkey: account, isSigner: false, isWritable: false }], data: Buffer.from(data) });
}

/** The floor a check carries, read back from its bytes; null for anything else. */
export function floorOfCheck(ix: TransactionInstruction): { account: PublicKey; min: bigint } | null {
  const d = ix.data;
  if (!ix.programId.equals(LIGHTHOUSE_PROGRAM) || d.length !== 12 || d[0] !== ASSERT_TOKEN_ACCOUNT || d[2] !== ASSERT_AMOUNT || d[11] !== GREATER_OR_EQUAL) return null;
  const account = ix.keys[0]?.pubkey;
  if (!account) return null;
  return { account, min: new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(3, true) };
}

/**
 * Whether a test run of a transaction holding only `atLeastCheck` failed the way Lighthouse fails:
 * `{"InstructionError":[i,{"Custom":6001}]}`.
 */
export function failedAsLighthouse(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('InstructionError' in err)) return false;
  const ie = (err as { InstructionError: unknown }).InstructionError;
  return Array.isArray(ie) && typeof ie[1] === 'object' && ie[1] !== null && (ie[1] as { Custom?: unknown }).Custom === LIGHTHOUSE_FAILED;
}

/**
 * The mainnet proof the cap waits on: two test runs from the robot's own wallet, one check at its
 * coin account's balance (must pass) and one a unit over it (must fail with 6001). `simulate`
 * test-runs one instruction from the robot's wallet and answers the run's error (null: it passed).
 * Answers why it is not proven, or null when it is.
 */
export async function proveLighthouse(account: PublicKey, balance: bigint, simulate: (ix: TransactionInstruction) => Promise<unknown>): Promise<string | null> {
  const met = await simulate(atLeastCheck(account, balance));
  if (met !== null && met !== undefined) return `the check at the balance failed: ${JSON.stringify(met)}`;
  const broken = await simulate(atLeastCheck(account, balance + 1n));
  if (!failedAsLighthouse(broken)) return `the check one unit over the balance did not fail as Lighthouse fails: ${JSON.stringify(broken ?? null)}`;
  return null;
}
