// The words of the maker's plates on the two Ethereum rails (island rulings 3 and 4). Pure, so
// EvmMakerPlates.test.tsx pins every sentence. A share is a share of the supply at birth, an
// unread value is said in words, and nothing here writes 0 for a value it did not read.

import { CURVE_TOTAL_SUPPLY } from '../../lib/launcher/curve';
import { lockWindow, type CurveCreateBuy, type DopplerPlates } from '../../lib/launcher/birthPlates';
import { sharePercent } from '../solana/curve/uiFormat';

export const CURVE_NO_LOCK = "No lock: the Memetics Curve has no way to lock a maker's tokens.";
export const CURVE_READING = "Reading the maker's create-buy…";
export const CREATE_BUY_UNREADABLE =
  "Could not read the maker's create-buy right now. This is our read failing, not a finding about the launch.";
export const ALLOCATION_READING = "Reading the maker's allocation…";
export const ALLOCATION_UNREADABLE =
  "Could not read the maker's allocation right now. This is our read failing, not a finding about the launch.";
export const NOT_DOPPLER = "This address was not launched through Doppler's Airlock, so there is no maker's allocation to show.";
export const NO_ALLOCATION = 'No allocation at birth.';
export const BOUGHT_NONE = 'Bought in the launch transaction: none. On this rail the auction opens after creation.';
export const MAKER_IS_SENDER = 'The maker is the wallet that sent the launch transaction.';
export const MAKER_UNNAMED =
  "Its launch transaction went through another contract, not straight to Doppler's Airlock, so the maker could not be named.";

const wallets = (n: number) => `${n} ${n === 1 ? 'wallet' : 'wallets'}`;
/** Only ever called with a whole read as positive, so the null branch is a guard, not a value. */
const pct = (part: bigint, whole: bigint) => sharePercent(part, whole) ?? 'an unreadable share';

/** A raw token amount, grouped, at most four decimals. Dust says so rather than reading as 0. */
export function tokenAmountText(raw: bigint, decimals = 18): string {
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const digits = (raw % scale).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
  if (whole === 0n && raw > 0n && digits === '') return '<0.0001';
  return `${whole.toLocaleString('en-US')}${digits ? `.${digits}` : ''}`;
}

/** A unix time as `2026-10-02 14:05 UTC`; past year 9999 it says so instead of throwing. */
export function utcTime(sec: bigint): string {
  if (sec > 253_402_300_799n) return 'after the year 9999';
  const iso = new Date(Number(sec) * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** The Memetics Curve: the maker's figure, and apart from it what other wallets bought in that transaction. */
export function curveCreateBuyLines(v: CurveCreateBuy): { maker: string; others: string | null } {
  const maker =
    v.makerTokens === 0n
      ? 'The maker bought nothing in the launch transaction.'
      : `The maker's create-buy: ${pct(v.makerTokens, CURVE_TOTAL_SUPPLY)} of the supply (${tokenAmountText(v.makerTokens)} tokens), bought in the launch transaction, before anyone else could buy.`;
  const others =
    v.others > 0
      ? `Other wallets got ${pct(v.othersTokens, CURVE_TOTAL_SUPPLY)} of the supply in the same transaction (${wallets(v.others)}).`
      : null;
  return { maker, others };
}

/**
 * Doppler (/launch): the maker's allocation with its lock (the token's own vesting), other
 * wallets' allocations, and what reached the maker's wallet in the launch transaction itself.
 * A maker who could not be named gets no plate at all: nothing is pinned on a relay.
 */
export function dopplerPlatesLines(
  p: Extract<DopplerPlates, { kind: 'read' }>,
): { allocation: string; others: string | null; bought: string | null } {
  const { birth: b, vestingStart, released } = p;
  if (b.maker === null) {
    return {
      allocation: MAKER_UNNAMED,
      others: b.others > 0 ? `Wallets were allocated ${pct(b.othersAmount, b.birthSupply)} of the supply at birth (${wallets(b.others)}).` : NO_ALLOCATION,
      bought: null,
    };
  }
  let allocation: string;
  if (b.makerAmount === 0n && b.others === 0) {
    allocation = `${NO_ALLOCATION} The maker's wallet is ${b.maker}.`;
  } else if (b.makerAmount === 0n) {
    allocation = `Nothing was allocated at birth to the maker's wallet, ${b.maker}.`;
  } else {
    const window = vestingStart === null ? null : lockWindow(vestingStart, b.makerSchedules);
    const lock =
      vestingStart === null || window === null
        ? "locked by the token's own vesting (its dates could not be read)"
        : window.endAt <= vestingStart
          ? "not locked: the token's own vesting released it all at birth"
          : `locked by the token's own vesting: nothing before ${utcTime(window.cliffAt)}, all released by ${utcTime(window.endAt)}`;
    const soFar =
      released === null ? 'how much is released so far could not be read' : `${tokenAmountText(released)} tokens released so far`;
    allocation = `The maker's allocation: ${pct(b.makerAmount, b.birthSupply)} of the supply (${tokenAmountText(b.makerAmount)} tokens) to ${b.maker}, ${lock}; ${soFar}.`;
  }
  const others =
    b.others > 0
      ? `Other wallets were allocated ${pct(b.othersAmount, b.birthSupply)} of the supply at birth (${wallets(b.others)}).`
      : null;
  const bought =
    b.toMaker === null
      ? null
      : b.toMaker === 0n
        ? BOUGHT_NONE
        : `Received in the launch transaction: ${pct(b.toMaker, b.birthSupply)} of the supply (${tokenAmountText(b.toMaker)} tokens) reached the maker's wallet outside the vesting.`;
  return { allocation, others, bought };
}
