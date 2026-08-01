// Bonding-curve math for `tegridy-launch` — a line-by-line port of the program's
// own `curve.rs`.
//
// WHY THIS FILE IS THE MOST DANGEROUS ONE IN THE CLIENT
//
// Any difference between what this quotes and what the program executes takes
// money from a user: they approve a transaction believing one number and the
// chain settles a different one. So this is not "close enough" arithmetic — it is
// a transcription, and it is proven to be one:
//
//   • `curveVectors.fixture.ts` holds 3,125 input/output rows produced by
//     COMPILING AND RUNNING the real `curve.rs` on the host (see that file's
//     header for the exact recipe). `math.test.ts` replays every row through the
//     functions below and asserts an exact match, error variants included.
//   • The literal assertions from `curve.rs`'s own `#[cfg(test)] mod tests` are
//     hand-ported into `math.test.ts` as well, so the two suites pin the same
//     numbers.
//
// Hard rules, all inherited from curve.rs:
//   • `bigint` everywhere, never `number`. `virtual_token_reserves` is
//     1_073_000_000_000_000 in the program's own tests and products of that with
//     lamports leave float precision immediately.
//   • Rounding is asymmetric ON PURPOSE (curve.rs:19-29): tokens out on a buy
//     round DOWN, lamports out on a sell round DOWN, fees round UP. Every
//     decision favours the curve so an order cannot be sliced to grind value out.
//     Flipping one produces a quote the program will refuse or beat.
//   • Rust computes in `u128` intermediates but returns `u64`, and it FAILS
//     (`u64::try_from`) rather than wrapping. `bigint` has no such ceiling, so
//     every return is range-checked here explicitly. The fixture contains rows
//     that only that check gets right (`lamportsUntilTarget` overflows u64 for a
//     large target at a high fee).
//
// This module imports NOTHING — same doctrine as `dbc.ts`: the layer everything
// else trusts carries zero runtime weight.

/** Basis-points denominator. curve.rs:32. */
export const BPS_DENOMINATOR = 10_000n;

/** Hard ceiling on the trade fee, enforced at config time as well as here. curve.rs:37. */
export const MAX_FEE_BPS = 1_000n;

/** How far a launch may list from its final curve price, in bps (±5%). curve.rs:49. */
export const PRICE_CONTINUITY_BAND_BPS = 500n;

/** Largest value the program can hold in a `u64` field. */
export const U64_MAX = 2n ** 64n - 1n;

/** The four failures `curve.rs` can return, by name. `CurveError`, curve.rs:51-63. */
export type CurveErrorCode = 'Overflow' | 'InsufficientLiquidity' | 'ZeroAmount' | 'FeeTooHigh';

/**
 * The port of Rust's `Result<T, CurveError>`.
 *
 * Deliberately NOT exceptions: a quote failing is an ordinary, expected outcome
 * (a dust trade, a fully-funded curve, a size the curve cannot fill) and the UI
 * has to render each one differently. An exception invites `catch {}` and a
 * catch-all is how a real failure becomes a clean-looking zero.
 */
export type CurveResult<T> = { ok: true; value: T } | { ok: false; error: CurveErrorCode };

function err<T>(error: CurveErrorCode): CurveResult<T> {
  return { ok: false, error };
}
function ok<T>(value: T): CurveResult<T> {
  return { ok: true, value };
}

/** True when `v` is something the program could actually hold in a `u64`. */
export function isU64(v: bigint): boolean {
  return v >= 0n && v <= U64_MAX;
}

/**
 * Reject an input the program could never have received.
 *
 * Rust's types make this unrepresentable; TypeScript's do not, and a UI derives
 * `maxLamportsIn` from a text field. A value outside `u64` is classified as
 * `Overflow` because that is what the equivalent conversion does on the Rust side
 * — never silently clamped, which would quote a trade the user did not ask for.
 */
function guardU64(...vs: readonly bigint[]): CurveErrorCode | null {
  for (const v of vs) if (!isU64(v)) return 'Overflow';
  return null;
}

/** `u64::try_from` — the program fails rather than wrapping. */
function toU64(v: bigint): CurveResult<bigint> {
  return isU64(v) ? ok(v) : err<bigint>('Overflow');
}

/** Ceiling division for non-negative bigints. */
function divCeil(num: bigint, den: bigint): bigint {
  return (num + den - 1n) / den;
}

/**
 * Fee, rounded UP so the protocol never loses a lamport to truncation. `fee_up`,
 * curve.rs:91-106.
 *
 * Up is the correct direction: rounding down would let a trader split one order
 * into many sub-fee-sized orders and pay nothing at all.
 */
export function feeUp(amount: bigint, feeBps: bigint): CurveResult<bigint> {
  const bad = guardU64(amount, feeBps);
  if (bad) return err(bad);
  if (feeBps > MAX_FEE_BPS) return err('FeeTooHigh');
  if (feeBps === 0n) return ok(0n);
  return toU64(divCeil(amount * feeBps, BPS_DENOMINATOR));
}

/** `BuyQuote`, curve.rs:66-74. All lamport/token amounts are raw base units. */
export interface BuyQuote {
  /** Fee skimmed off the incoming lamports, before the curve sees them. */
  feeLamports: bigint;
  /** Lamports that actually move along the curve (`lamportsIn - fee`). */
  lamportsToCurve: bigint;
  /** Tokens the trader receives. */
  tokensOut: bigint;
}

/**
 * Quote a buy: lamports in, tokens out. `quote_buy`, curve.rs:112-161.
 *
 * `solReserves` / `tokenReserves` are the EFFECTIVE (virtual + real) reserves —
 * see {@link effectiveReserves}. Callers on a live curve should use
 * {@link quoteBuyOnCurve}, which additionally applies the graduation cap and the
 * real-reserve check that live in `buy` rather than here.
 */
export function quoteBuy(
  solReserves: bigint,
  tokenReserves: bigint,
  lamportsIn: bigint,
  feeBps: bigint,
): CurveResult<BuyQuote> {
  const bad = guardU64(solReserves, tokenReserves, lamportsIn, feeBps);
  if (bad) return err(bad);

  if (lamportsIn === 0n) return err('ZeroAmount');
  if (solReserves === 0n || tokenReserves === 0n) return err('InsufficientLiquidity');

  const fee = feeUp(lamportsIn, feeBps);
  if (!fee.ok) return err(fee.error);
  const lamportsToCurve = lamportsIn - fee.value;
  // A trade so small the fee eats all of it would mint zero tokens while still
  // charging — reject rather than silently take the fee for nothing.
  if (lamportsToCurve === 0n) return err('ZeroAmount');

  // out = (y * dx) / (x + dx) — algebraically y - k/(x+dx), written this way to
  // keep intermediates small. Truncating division rounds DOWN = favours the curve.
  const tokensOutWide = (tokenReserves * lamportsToCurve) / (solReserves + lamportsToCurve);
  const tokensOut = toU64(tokensOutWide);
  if (!tokensOut.ok) return err(tokensOut.error);

  if (tokensOut.value === 0n) return err('ZeroAmount');
  // Cannot hand out the entire reserve — that would leave k undefined.
  if (tokensOut.value >= tokenReserves) return err('InsufficientLiquidity');

  return ok({ feeLamports: fee.value, lamportsToCurve, tokensOut: tokensOut.value });
}

/** `SellQuote`, curve.rs:77-85. */
export interface SellQuote {
  /** Gross lamports the curve gives up, before fee. */
  grossLamports: bigint;
  /** Fee skimmed from the proceeds. */
  feeLamports: bigint;
  /** Lamports the trader actually receives (`gross - fee`). */
  lamportsOut: bigint;
}

/**
 * Quote a sell: tokens in, lamports out. `quote_sell`, curve.rs:164-204.
 *
 * Note the check order differs from {@link quoteBuy}: here the fee is charged
 * AFTER the liquidity checks, so an over-large sell on a curve with an illegal
 * fee reports `InsufficientLiquidity`, not `FeeTooHigh`. That asymmetry is real
 * and the fixture pins it.
 */
export function quoteSell(
  solReserves: bigint,
  tokenReserves: bigint,
  tokensIn: bigint,
  feeBps: bigint,
): CurveResult<SellQuote> {
  const bad = guardU64(solReserves, tokenReserves, tokensIn, feeBps);
  if (bad) return err(bad);

  if (tokensIn === 0n) return err('ZeroAmount');
  if (solReserves === 0n || tokenReserves === 0n) return err('InsufficientLiquidity');

  // out = (x * dy) / (y + dy) — the mirror of the buy branch, rounds DOWN.
  const grossWide = (solReserves * tokensIn) / (tokenReserves + tokensIn);
  const gross = toU64(grossWide);
  if (!gross.ok) return err(gross.error);

  if (gross.value === 0n) return err('ZeroAmount');
  if (gross.value >= solReserves) return err('InsufficientLiquidity');

  const fee = feeUp(gross.value, feeBps);
  if (!fee.ok) return err(fee.error);

  return ok({
    grossLamports: gross.value,
    feeLamports: fee.value,
    lamportsOut: gross.value - fee.value,
  });
}

/**
 * The largest `lamportsIn` that moves real SOL reserves exactly to
 * `targetRealSol` and no further. `lamports_until_target`, curve.rs:216-240.
 *
 * `null` means the curve has ALREADY reached the target — Rust's `None`. In
 * `buy` that is the `AwaitingMigration` branch (lib.rs:476-479), which is NOT
 * the same thing as graduated and must never render as such.
 *
 * The returned value is grossed UP for the fee: it is what a buyer must SEND,
 * not what lands on the curve.
 *
 * ⚠ The fee ceiling here is `BPS_DENOMINATOR`, not `MAX_FEE_BPS` — curve.rs:230
 * only guards the division. A curve with `feeBps` in (1000, 10000) passes this
 * and then fails inside `quoteBuy`. Pinned by the fixture; do not "tidy" it.
 */
export function lamportsUntilTarget(
  realSolReserves: bigint,
  targetRealSol: bigint,
  feeBps: bigint,
): CurveResult<bigint | null> {
  const bad = guardU64(realSolReserves, targetRealSol, feeBps);
  if (bad) return err(bad);

  if (realSolReserves >= targetRealSol) return ok(null);
  const remainingToCurve = targetRealSol - realSolReserves;

  if (feeBps >= BPS_DENOMINATOR) return err('FeeTooHigh');
  // `remainingToCurve` is post-fee. Gross it back up so the caller charges the
  // fee on the full amount: gross = ceil(net * BPS / (BPS - fee_bps)).
  const gross = divCeil(remainingToCurve * BPS_DENOMINATOR, BPS_DENOMINATOR - feeBps);
  const capped = toU64(gross);
  return capped.ok ? ok(capped.value) : err(capped.error);
}

/**
 * The most real SOL a curve can EVER accumulate, given its opening parameters.
 * `max_reachable_real_sol`, curve.rs:266-281.
 *
 * An EXCLUSIVE upper bound: `quoteBuy` refuses to hand out the entire token
 * reserve, so the last fraction is unreachable (curve.rs:253-255). A graduation
 * target above this produces a launch that can never graduate.
 */
export function maxReachableRealSol(
  virtualSol: bigint,
  virtualToken: bigint,
  tokenSupply: bigint,
): CurveResult<bigint> {
  const bad = guardU64(virtualSol, virtualToken, tokenSupply);
  if (bad) return err(bad);
  if (virtualSol === 0n || virtualToken === 0n || tokenSupply === 0n) return err('ZeroAmount');
  // Rounds DOWN: used as a ceiling to compare a target against, so understating
  // it keeps the check conservative.
  return toU64((virtualSol * tokenSupply) / virtualToken);
}

/** Integer square root by Newton's method. `isqrt_u128`, curve.rs:284-301. */
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  // Seed with n/2 + 1, NOT (n+1)/2 — see curve.rs:288-293 for why.
  let x = n / 2n + 1n;
  let y = (x + n / x) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * Ratio of the pool's opening price to the curve's final price, in bps.
 * `graduation_price_ratio_bps`, curve.rs:322-366.
 *
 * `10_000` means a launch lists at exactly the price its last curve buyer paid.
 * The curve prices on `virtual + real`, but the pool is seeded with REAL reserves
 * only, so those coincide for exactly one target and the token gaps the instant
 * it lists otherwise. This repo's original parameters listed at ~14% of the final
 * curve price — a ~7x drop with nothing stolen (curve.rs:307-318).
 */
export function graduationPriceRatioBps(
  virtualSol: bigint,
  virtualToken: bigint,
  tokenSupply: bigint,
  graduationTarget: bigint,
  migrationReserve: bigint,
): CurveResult<bigint> {
  const bad = guardU64(virtualSol, virtualToken, tokenSupply, graduationTarget, migrationReserve);
  if (bad) return err(bad);
  if (
    virtualSol === 0n ||
    virtualToken === 0n ||
    tokenSupply === 0n ||
    graduationTarget === 0n
  ) {
    return err('ZeroAmount');
  }

  // k is fixed by the opening book: k = Vs · (Vt + S).
  const k = virtualSol * (virtualToken + tokenSupply);
  // State at migration: the curve has taken in target AND reserve.
  const x = virtualSol + graduationTarget + migrationReserve;
  const y = k / x;
  // Unsold tokens — everything the pool receives. Rust uses `checked_sub` here,
  // so an underflow is InsufficientLiquidity, not a negative number.
  if (y < virtualToken) return err('InsufficientLiquidity');
  const remaining = y - virtualToken;
  if (remaining === 0n) return err('InsufficientLiquidity');

  // pool/curve = [T / remaining] / [x / y] = T·y / (remaining·x)
  return toU64((graduationTarget * y * BPS_DENOMINATOR) / (remaining * x));
}

/**
 * The graduation target that lists a launch at exactly its final curve price.
 * `continuity_target`, curve.rs:376-404.
 *
 * `T = sqrt( Vs·(Vt+S)·(Vs+R) / Vt ) − Vs − R`. Advisory —
 * {@link graduationPriceRatioBps} is the authoritative check. Operators need this
 * because a ±5% price tolerance is only about ±0.7% in `T`.
 */
export function continuityTarget(
  virtualSol: bigint,
  virtualToken: bigint,
  tokenSupply: bigint,
  migrationReserve: bigint,
): CurveResult<bigint> {
  const bad = guardU64(virtualSol, virtualToken, tokenSupply, migrationReserve);
  if (bad) return err(bad);
  if (virtualSol === 0n || virtualToken === 0n || tokenSupply === 0n) return err('ZeroAmount');

  // Divide before the second multiply so large books do not overflow — and
  // because the truncation is part of the result the program produces.
  const scaled = (virtualSol * (virtualToken + tokenSupply)) / virtualToken;
  const x = isqrt(scaled * (virtualSol + migrationReserve));
  // Rust chains two `checked_sub`s; either underflowing is InsufficientLiquidity.
  if (x < virtualSol) return err('InsufficientLiquidity');
  const afterVs = x - virtualSol;
  if (afterVs < migrationReserve) return err('InsufficientLiquidity');
  return toU64(afterVs - migrationReserve);
}

// ── the parts of `buy` / `sell` that live in lib.rs, not curve.rs ────────────

/**
 * The curve fields the quote engine needs. A subset of `BondingCurve`
 * (state.rs:123-166) so callers can quote from a decoded account or from
 * hypothetical numbers without inventing the rest.
 *
 * ⚠ `tradeFeeBps` MUST come from the CURVE, never from `GlobalConfig`. Every
 * launch snapshots its own terms at creation (lib.rs:430-432) precisely so
 * governance cannot rewrite a live launch's economics. Quoting from the global
 * disagrees with the program silently — no revert, the user just receives a
 * different number than the one they were shown.
 */
export interface CurveTerms {
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  tradeFeeBps: bigint;
  graduationTargetLamports: bigint;
  migrationReserveLamports: bigint;
}

/** Effective (virtual + real) reserves — what the pricing function sees. state.rs:168-183. */
export function effectiveReserves(c: CurveTerms): CurveResult<{ sol: bigint; tokens: bigint }> {
  const sol = c.virtualSolReserves + c.realSolReserves;
  const tokens = c.virtualTokenReserves + c.realTokenReserves;
  if (!isU64(sol) || !isU64(tokens)) return err('Overflow');
  return ok({ sol, tokens });
}

/**
 * The ceiling buys are capped against: `graduation_target + migration_reserve`.
 *
 * NOT the target alone. Capping at the target made the migration reserve
 * unraisable and was caught by the CI rehearsal (lib.rs:459-469, state.rs:143-147).
 * This is also the correct denominator for a progress bar — using the target
 * alone shows 100% while buys still succeed.
 */
export function raiseCeiling(c: CurveTerms): CurveResult<bigint> {
  const v = c.graduationTargetLamports + c.migrationReserveLamports;
  return isU64(v) ? ok(v) : err('Overflow');
}

/**
 * The failures `buy`/`sell` can return that are NOT in `curve.rs`. Names match
 * `LaunchError` (errors.rs:5-48); {@link LAUNCH_ERROR_CODES} maps them to the
 * numbers Anchor emits.
 */
export type LaunchQuoteErrorCode =
  | CurveErrorCode
  | 'AlreadyComplete'
  | 'AwaitingMigration'
  | 'SlippageExceeded'
  | 'InsufficientRentExemptBalance';

/** A buy quote as the PROGRAM will execute it, cap included. */
export interface CurveBuyQuote extends BuyQuote {
  /**
   * What the wallet is ACTUALLY debited — `min(maxLamportsIn, lamportsUntilTarget)`.
   *
   * `max_lamports_in` is a CEILING, not a spend: a buy that would carry the curve
   * past `target + reserve` is capped there and the remainder is never taken
   * (lib.rs:466-480). There is no refund transfer — the money never leaves the
   * wallet. A UI that shows the user "you will spend `maxLamportsIn`" is wrong on
   * the last buy of every launch.
   */
  lamportsIn: bigint;
  /** True when the cap bit, i.e. `lamportsIn < maxLamportsIn`. Worth saying out loud. */
  capped: boolean;
}

/**
 * Quote a buy against a live curve, in the exact order `buy` evaluates it
 * (lib.rs:452-495).
 *
 * `complete` and `paused` are NOT checked here — they are account state, not
 * math; see `phase.ts`. Everything else is: the graduation cap, the zero check,
 * the curve math, the slippage floor, and the real-reserve check.
 *
 * @param minTokensOut the slippage floor sent as the instruction's second arg.
 *   Defaults to 0 so a display-only quote needs no tolerance — but a user surface
 *   must pass a real one (lib.rs:491).
 */
export function quoteBuyOnCurve(
  c: CurveTerms,
  maxLamportsIn: bigint,
  minTokensOut = 0n,
): { ok: true; value: CurveBuyQuote } | { ok: false; error: LaunchQuoteErrorCode } {
  // `max_lamports_in` is a u64 arg. A value outside that range is not a small
  // trade, it is an unsendable one — classify it as Overflow rather than letting
  // `min()` pick it and report ZeroAmount.
  if (!isU64(maxLamportsIn) || !isU64(minTokensOut)) return { ok: false, error: 'Overflow' };

  const ceiling = raiseCeiling(c);
  if (!ceiling.ok) return ceiling;

  const limit = lamportsUntilTarget(c.realSolReserves, ceiling.value, c.tradeFeeBps);
  if (!limit.ok) return limit;
  // `None` — fully funded and waiting on migration. NOT graduated (lib.rs:476-479).
  if (limit.value === null) return { ok: false, error: 'AwaitingMigration' };

  const lamportsIn = maxLamportsIn < limit.value ? maxLamportsIn : limit.value;
  if (lamportsIn === 0n) return { ok: false, error: 'ZeroAmount' };

  const eff = effectiveReserves(c);
  if (!eff.ok) return eff;

  const q = quoteBuy(eff.value.sol, eff.value.tokens, lamportsIn, c.tradeFeeBps);
  if (!q.ok) return q;

  if (q.value.tokensOut < minTokensOut) return { ok: false, error: 'SlippageExceeded' };
  // Two distinct reserve checks against two different quantities: curve.rs:152
  // compares against EFFECTIVE tokens, lib.rs:492 against REAL ones. Keep both.
  if (q.value.tokensOut > c.realTokenReserves) {
    return { ok: false, error: 'InsufficientLiquidity' };
  }

  return { ok: true, value: { ...q.value, lamportsIn, capped: lamportsIn < maxLamportsIn } };
}

/**
 * Quote a sell against a live curve, in the exact order `sell` evaluates it
 * (lib.rs:565-587).
 *
 * `sell` is deliberately NOT gated on `paused` (lib.rs:563-564) — a pause stops
 * new money entering and must never trap holders.
 *
 * @param curveAccountLamports the curve PDA's ACTUAL lamport balance and
 *   `rentExemptLamports` its rent floor. Supply both to include the program's
 *   rent check (lib.rs:605-614); omit them and that check is skipped, which is
 *   honest for a display-only quote but wrong for a "max sell" control. Note the
 *   check reads the ACCOUNT BALANCE, not `realSolReserves` — the PDA also holds
 *   rent and any donated lamports.
 */
export function quoteSellOnCurve(
  c: CurveTerms,
  tokensIn: bigint,
  minLamportsOut = 0n,
  rent?: { curveAccountLamports: bigint; rentExemptLamports: bigint },
): { ok: true; value: SellQuote } | { ok: false; error: LaunchQuoteErrorCode } {
  if (!isU64(tokensIn) || !isU64(minLamportsOut)) return { ok: false, error: 'Overflow' };
  if (tokensIn === 0n) return { ok: false, error: 'ZeroAmount' };

  const eff = effectiveReserves(c);
  if (!eff.ok) return eff;

  const q = quoteSell(eff.value.sol, eff.value.tokens, tokensIn, c.tradeFeeBps);
  if (!q.ok) return q;

  if (q.value.lamportsOut < minLamportsOut) return { ok: false, error: 'SlippageExceeded' };
  // The curve may only ever pay out REAL lamports; the virtual leg is pricing
  // fiction and is never redeemable (lib.rs:582-587).
  if (q.value.grossLamports > c.realSolReserves) {
    return { ok: false, error: 'InsufficientLiquidity' };
  }
  if (rent && rent.curveAccountLamports - q.value.grossLamports < rent.rentExemptLamports) {
    return { ok: false, error: 'InsufficientRentExemptBalance' };
  }

  return q;
}
