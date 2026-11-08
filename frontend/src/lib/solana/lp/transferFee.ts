/**
 * A Token-2022 transfer fee, and what it takes out of a transfer.
 *
 * A token with a transfer fee keeps back part of EVERY transfer of it: the sender is
 * debited the whole amount, and the receiving account gets that amount less the fee. The
 * fee is held in the receiving account until whoever holds the token's withdraw authority
 * collects it. So a pool deposit of such a token leaves the wallet in full and reaches
 * the pool less the fee, and a withdrawal or a swap out of the pool reaches the wallet
 * less the fee.
 *
 * THE MATHS, copied, not re-derived (pinned by transferFee.test.ts):
 *   - spl-token-2022 8.0.1, extension/transfer_fee/mod.rs, the version the pool program
 *     builds against (solana/tegridy-amm/Cargo.lock): `calculate_fee`,
 *     `calculate_pre_fee_amount`, `calculate_inverse_fee`, `get_epoch_fee`;
 *   - the pool program's own two wrappers (cp-swap utils/token.rs): `get_transfer_fee`,
 *     which a withdrawal and a swap charge, and `get_transfer_inverse_fee`, which a
 *     deposit adds on top of what the pool takes, and which REFUSES a deposit whose fee
 *     does not check out (TransferFeeCalculateNotMatch).
 *
 * An opening (initialize.rs) charges no fee of its own: it sends what it is given and
 * counts the pool's shares from what the vaults then hold, which is that less the fee.
 *
 * Pure bigint. `null` for a fee is "this token takes none" (a classic token, or a
 * Token-2022 token with no transfer fee). Amounts are u64 on chain; nothing here is
 * called with one outside 0..u64::MAX.
 */

export const MAX_FEE_BASIS_POINTS = 10_000;
const ONE_IN_BASIS_POINTS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;

/** One fee setting: from `epoch` on, `basisPoints` of each transfer, at most `maximumFee` tokens. */
export interface TransferFee {
  epoch: bigint;
  maximumFee: bigint;
  basisPoints: number;
}

/** The mint's `TransferFeeConfig` extension (108 bytes), decoded by tokenSafety.ts. */
export interface TransferFeeConfig {
  /** Can change the fee; a change takes effect two epochs after it is made. Null = nobody, ever. */
  configAuthority: string | null;
  /** Collects every fee the token has kept back. */
  withdrawAuthority: string | null;
  withheldAmount: bigint;
  /** In force while the network's epoch is below `newer.epoch`. */
  older: TransferFee;
  /** In force from `newer.epoch` on. */
  newer: TransferFee;
}

const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;

/** `get_epoch_fee`. */
export function epochFee(c: TransferFeeConfig, epoch: bigint): TransferFee {
  return epoch >= c.newer.epoch ? c.newer : c.older;
}

/** `calculate_fee`: the fee on a transfer of `preFee`. */
export function feeOf(f: TransferFee, preFee: bigint): bigint {
  const bps = BigInt(f.basisPoints);
  if (bps === 0n || preFee === 0n) return 0n;
  const raw = ceilDiv(preFee * bps, ONE_IN_BASIS_POINTS);
  return raw < f.maximumFee ? raw : f.maximumFee;
}

/** `calculate_pre_fee_amount`: the smallest transfer that delivers `postFee`. Null = past u64. */
export function preFeeAmountOf(f: TransferFee, postFee: bigint): bigint | null {
  const bps = BigInt(f.basisPoints);
  if (bps === 0n) return postFee;
  if (postFee === 0n) return 0n;
  if (bps === ONE_IN_BASIS_POINTS) {
    const v = f.maximumFee + postFee;
    return v > U64_MAX ? null : v;
  }
  const raw = ceilDiv(postFee * ONE_IN_BASIS_POINTS, ONE_IN_BASIS_POINTS - bps);
  if (raw - postFee >= f.maximumFee) {
    const v = postFee + f.maximumFee;
    return v > U64_MAX ? null : v;
  }
  return raw > U64_MAX ? null : raw;
}

/** `calculate_inverse_fee`: the fee on the transfer that delivers `postFee`. Null = past u64. */
export function inverseFeeOf(f: TransferFee, postFee: bigint): bigint | null {
  const pre = preFeeAmountOf(f, postFee);
  return pre === null ? null : feeOf(f, pre);
}

/** The pool program's `get_transfer_fee`: what a withdrawal or a swap loses on a transfer of `preFee`. */
export function poolFee(f: TransferFee | null, preFee: bigint): bigint {
  return f ? feeOf(f, preFee) : 0n;
}

/**
 * The pool program's `get_transfer_inverse_fee`: what a deposit sends ON TOP of the
 * `postFee` the pool takes, so that `postFee` arrives. Null = the program refuses the
 * deposit: a side of 0 (InvalidInput), a sum past u64, or a fee that does not check out
 * against the sum it is added to (TransferFeeCalculateNotMatch). At 100% it is the
 * maximum fee, with no check, as the program has it.
 */
export function poolInverseFee(f: TransferFee | null, postFee: bigint): bigint | null {
  if (!f) return 0n;
  if (postFee === 0n) return null;
  if (f.basisPoints === MAX_FEE_BASIS_POINTS) return f.maximumFee;
  const fee = inverseFeeOf(f, postFee);
  if (fee === null || postFee + fee > U64_MAX) return null;
  return feeOf(f, postFee + fee) === fee ? fee : null;
}

/** What arrives of a transfer of `preFee`. */
export function afterFee(f: TransferFee | null, preFee: bigint): bigint {
  return preFee - poolFee(f, preFee);
}

const sameFee = (a: TransferFee, b: TransferFee) => a.basisPoints === b.basisPoints && a.maximumFee === b.maximumFee;

/**
 * The fee a transfer pays now. With the network's epoch, exactly the token program's
 * choice. Without it (the page does not read the epoch; every builder does, and refuses
 * without it), the fee both settings agree on, and when a change is pending, the larger
 * of the two: a page estimate that can only say a little too much is taken, and the
 * review then says exactly.
 */
export function feeNow(c: TransferFeeConfig | null | undefined, epoch: bigint | null): TransferFee | null {
  if (!c) return null;
  if (epoch !== null) return epochFee(c, epoch);
  if (sameFee(c.older, c.newer)) return c.newer;
  const higher = (a: TransferFee, b: TransferFee) =>
    a.basisPoints > b.basisPoints || (a.basisPoints === b.basisPoints && a.maximumFee >= b.maximumFee) ? a : b;
  return higher(c.newer, c.older);
}

/** A rate for people: "5%", "0.25%", "100%". */
export function feeRateText(f: TransferFee): string {
  return `${(f.basisPoints / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}
