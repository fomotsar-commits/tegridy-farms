// Turning `tegridy-launch` numbers and states into words.
//
// PRESENTATION ONLY. Nothing here quotes a trade, and nothing here may invent a
// figure: every function either formats a value it was handed or says it cannot.
// The arithmetic lives in `math.ts` and there is exactly one copy of it.
//
// The rule these share: A REAL VALUE MUST NEVER RENDER AS ZERO, and an unknown
// must never render as a number. Both directions have shipped from this repo
// before — a scam pool rendered as "520607 ETH", a balance of one lamport shown as
// "0.0000". So `formatSol` has a `<0.0001` floor rather than truncating to zero,
// and every "we could not read it" path returns an explicit marker rather than a
// default.

import type { LaunchErrorName } from './program';
import type { LaunchPhase } from './read';

/**
 * Solana protocol constant. SOL is always 9 decimals; the LAUNCH MINT is not, and
 * conflating the two is why {@link formatTokenAmount} demands its decimals.
 */
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Format a lamport amount as SOL.
 *
 * Exact: the integer part comes from BigInt division and the fraction is padded
 * from the remainder, so nothing is routed through a float. Truncates, never
 * rounds, so a displayed amount is never overstated.
 *
 * THE FLOOR IS THE POINT. A NON-ZERO balance never renders as "0" or "0.0000" —
 * it renders as `<0.0001`, because a real balance shown as zero is the bug this
 * repo keeps re-shipping. That holds in both modes below.
 *
 * `fixed` chooses the presentation and nothing else:
 *   - default (`false`) trims trailing zeros — prose, where "1 SOL" reads better;
 *   - `true` pads to exactly `maxFractionDigits` — a stat grid, where a ragged
 *     fraction breaks the column.
 * One implementation, two settings, on purpose: this used to be two functions
 * with the same name in two modules, and only one of them had the floor.
 */
export function formatSol(
  lamports: bigint,
  maxFractionDigits = 4,
  options: { fixed?: boolean } = {},
): string {
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = abs % LAMPORTS_PER_SOL;
  const truncated = frac.toString().padStart(9, '0').slice(0, maxFractionDigits);
  // Everything the user owns fell off the end of the string: say "smaller than the
  // smallest thing this column can show", never "nothing".
  if (whole === 0n && frac > 0n && /^0*$/.test(truncated)) {
    return maxFractionDigits > 0
      ? `${neg ? '-' : ''}<0.${'0'.repeat(maxFractionDigits - 1)}1`
      : `${neg ? '-' : ''}<1`;
  }
  const digits = options.fixed ? truncated : truncated.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${digits ? `.${digits}` : ''}`;
}

/**
 * Format a raw base-unit amount using the mint's decimals.
 *
 * `decimals` is NOT stored on the curve and NOT constrained by the program — the
 * program's tests use 9 but nothing enforces it. A caller that could not read the
 * mint passes `null` and gets base units back with `isBaseUnits: true`, so the
 * page can say which one it is showing instead of silently assuming 9.
 */
export function formatTokenAmount(
  baseUnits: bigint,
  decimals: number | null,
  maxFractionDigits = 4,
): { text: string; isBaseUnits: boolean } {
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return { text: baseUnits.toString(), isBaseUnits: true };
  }
  const scale = 10n ** BigInt(decimals);
  const whole = baseUnits / scale;
  const frac = baseUnits % scale;
  const digits = frac.toString().padStart(decimals, '0').slice(0, maxFractionDigits).replace(/0+$/, '');
  return { text: `${whole.toLocaleString('en-US')}${digits ? `.${digits}` : ''}`, isBaseUnits: false };
}

/**
 * Parse a decimal string into base units, exactly.
 *
 * `null` on anything that is not a plain non-negative decimal — no silent
 * coercion of `NaN` to 0, which would turn a typo into a real trade — and `null`
 * when the input carries more precision than the mint has, rather than truncating
 * a digit the user typed.
 */
export function parseDecimalToBaseUnits(input: string, decimals: number): bigint | null {
  const t = input.trim();
  // A real amount is never this long (u64 max is 20 digits), and the cap bounds the work
  // a paste into the amount field can make this function do.
  if (t.length > 80) return null;
  // Written as an unambiguous alternation rather than `^\d*\.?\d*$`: two adjacent `\d*`
  // around an optional dot let the engine split a long digit run many ways, which is
  // quadratic backtracking on a near-miss (CodeQL js/polynomial-redos). This form also
  // subsumes the old explicit '' and '.' rejections — neither matches either branch.
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(t)) return null;
  const [whole = '', frac = ''] = t.split('.');
  if (frac.length > decimals) return null;
  const padded = frac.padEnd(decimals, '0');
  try {
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
  } catch {
    return null;
  }
}

/**
 * A cheap SHAPE check on a pasted mint address — base58 alphabet, plausible
 * length for a 32-byte key.
 *
 * Named "looksLike" on purpose: it says nothing about whether the key decodes to
 * 32 bytes, whether it is on the ed25519 curve, or whether anything exists at it.
 * It exists so a page can withhold a lookup for obvious typos without claiming the
 * address is real. The authoritative check is constructing a `PublicKey`.
 */
export function looksLikePubkey(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}

/**
 * Label a spot price WITHOUT assuming the launch mint's decimals.
 *
 * The program never stores decimals and never constrains them, so with no
 * `tokenDecimals` read from the mint account the only honest unit is raw base
 * units. Never assume 9.
 */
export function spotPriceLabel(price: number, tokenDecimals?: number | null): { value: string; unit: string } {
  if (!Number.isFinite(price) || price < 0) return { value: '—', unit: 'unreadable' };
  if (
    tokenDecimals == null ||
    !Number.isInteger(tokenDecimals) ||
    tokenDecimals < 0 ||
    tokenDecimals > 18
  ) {
    return { value: formatRatio(price), unit: 'lamports per base unit' };
  }
  const solPerToken = (price * 10 ** tokenDecimals) / Number(LAMPORTS_PER_SOL);
  return { value: formatRatio(solPerToken), unit: 'SOL per token' };
}

function formatRatio(v: number): string {
  if (v === 0) return '0';
  if (v < 0.000001 || v >= 1e9) return v.toExponential(3);
  const s = v.toPrecision(4);
  // Only strip trailing zeros from a FRACTION. Applying it to "1000" leaves "1",
  // i.e. a price understated by 1000x — the exact silent-wrong-number bug this
  // whole surface exists to avoid.
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

// ── error copy ───────────────────────────────────────────────────────────────

/**
 * A sentence per program error, written for the person who hit it.
 *
 * Keyed off `LaunchErrorName` so a new variant in errors.rs is a type error here
 * rather than a blank space on a page.
 *
 * Two of these are load-bearing and must not be smoothed:
 *  - `AwaitingMigration` (6019) and `AlreadyComplete` (6005) must never read the
 *    same. An earlier program version returned AlreadyComplete for the
 *    fully-funded case, which told callers a curve had moved to an AMM pool when
 *    it had not; 6019 exists solely to separate them (lib.rs:476-479).
 *  - `Paused` (6004) says "buys" and not "trading", because sells are
 *    deliberately unpausable (lib.rs:563-564).
 */
export const LAUNCH_ERROR_COPY: Record<LaunchErrorName, string> = {
  Overflow: 'Arithmetic overflow — this is a bug, not something you did.',
  InsufficientLiquidity: 'The curve cannot fill a trade this size.',
  ZeroAmount: 'That amount resolves to zero — usually the fee eats a dust trade.',
  FeeTooHigh: 'The configured fee is above the protocol ceiling. Configuration bug, not a user action.',
  Paused: 'Buys are paused. Selling is still open — a pause never strands holders.',
  AlreadyComplete: 'This curve has graduated. Trade it on the AMM pool instead.',
  NotReadyToGraduate: 'The curve has not reached its graduation target yet.',
  SlippageExceeded: 'Price moved past your tolerance before the trade landed. Retry.',
  Unauthorized: 'Wrong signer for this instruction.',
  InvalidParameter: 'A supplied value is outside its permitted range.',
  InsufficientRentExemptBalance: "That sell is larger than the curve's rent floor allows.",
  MintHasFreezeAuthority: 'The mint still carries a freeze authority. It must be revoked before launch.',
  NotDeployAuthority: 'Operator-only instruction.',
  GraduationTargetUnreachable: 'Operator configuration: the target exceeds what this curve could ever hold.',
  GraduationPriceGap: 'Operator configuration: the launch would list far from its final curve price.',
  AmmNotConfigured: 'The graduation venue is not configured yet. Not a problem with this launch.',
  AmmMismatch: 'The supplied cp-swap program or AmmConfig does not match the configured one.',
  MigrationReserveTooLow: 'The curve cannot yet afford migration. Retryable — it is a stall, not a break.',
  LpNotBurned: 'Migration aborted rather than leave a false "liquidity locked" claim.',
  AwaitingMigration: 'Fully funded and waiting on migration. It has NOT graduated yet — sells still work.',
};

// ── what a phase permits ─────────────────────────────────────────────────────

/** Phases in which the curve itself is the venue and a quote is meaningful. */
export function isTradablePhase(phase: LaunchPhase): boolean {
  return phase.kind === 'trading' || phase.kind === 'at-target' || phase.kind === 'awaiting-migration';
}

/**
 * Whether `buy` would be accepted right now, and why not if it would not.
 *
 * Kept separate from {@link sellBlockedReason} because the two are NOT symmetric:
 * a pause halts buys and leaves sells open (lib.rs:563-564), and a fully funded
 * curve rejects buys with `AwaitingMigration` while sells keep working.
 *
 * `null` means "nothing blocks it" ONLY for the phases where that is knowable. A
 * phase we could not establish returns `InvalidParameter` rather than `null`,
 * because "we do not know" must never render as "go ahead".
 */
export function buyBlockedReason(phase: LaunchPhase, paused: boolean): LaunchErrorName | null {
  switch (phase.kind) {
    case 'graduated':
      return 'AlreadyComplete';
    case 'awaiting-migration':
      return 'AwaitingMigration';
    case 'not-deployed':
    case 'not-a-program':
    // A closed program cannot execute any instruction, so this is a block and not
    // a maybe. It rides with the other unestablished phases deliberately: the
    // caller needs "this will not go through", and the reason it will not is the
    // phase's own job to say.
    case 'closed':
    case 'unreadable':
    case 'protocol-not-initialized':
    case 'pre-launch':
      return 'InvalidParameter';
    case 'trading':
    case 'at-target':
      return paused ? 'Paused' : null;
  }
}

/**
 * Sells are unpausable by design — only graduation stops them.
 *
 * Same non-answer rule as {@link buyBlockedReason}: an unestablished phase blocks,
 * it does not permit.
 */
export function sellBlockedReason(phase: LaunchPhase): LaunchErrorName | null {
  switch (phase.kind) {
    case 'graduated':
      return 'AlreadyComplete';
    case 'not-deployed':
    case 'not-a-program':
    // A closed program cannot execute any instruction, so this is a block and not
    // a maybe. It rides with the other unestablished phases deliberately: the
    // caller needs "this will not go through", and the reason it will not is the
    // phase's own job to say.
    case 'closed':
    case 'unreadable':
    case 'protocol-not-initialized':
    case 'pre-launch':
      return 'InvalidParameter';
    case 'trading':
    case 'at-target':
    case 'awaiting-migration':
      return null;
  }
}
