// When another lender may take a loan over without the borrower (Gondi v3.2 MultiSourceLoan,
// a lender's refinanceFull): not before `minLockPeriod` of the term has passed
// (`_getUnlockedTime`), and not in its last `minLockPeriod` (`_isLoanLocked`). The contract
// reads that one setting, in basis points of the term, at each takeover: its owner, the
// venue's Safe, can change it at once (`setMinLockPeriod`), and the change reaches open loans.
// So the site says what the chain says, and no read means no number.

/** What the loan contract's takeover window reads as: the share of the term at each end. */
export type TakeoverWindow =
  | { kind: 'reading' }
  | { kind: 'unread' }
  /** Half the term or more is locked at each end: at most one second of the term is left. */
  | { kind: 'none' }
  | { kind: 'window'; from: string; to: string };

const PRECISION = 10_000n;

/** A share of the term in basis points, as a percent: 1500 is "15%", 1250 "12.5%". */
function percent(bps: bigint): string {
  const whole = bps / 100n;
  const rest = bps % 100n;
  return rest === 0n ? `${whole}%` : `${whole}.${rest.toString().padStart(2, '0').replace(/0$/, '')}%`;
}

/** `getMinLockPeriod`'s answer, or anything else for a read that did not come back; `reading` while it is on its way. */
export function takeoverWindow(minLockPeriod: unknown, reading = false): TakeoverWindow {
  if (typeof minLockPeriod !== 'bigint' || minLockPeriod < 0n || minLockPeriod > PRECISION) return { kind: reading ? 'reading' : 'unread' };
  if (minLockPeriod * 2n >= PRECISION) return { kind: 'none' };
  return { kind: 'window', from: percent(minLockPeriod), to: percent(PRECISION - minLockPeriod) };
}

/** Where the window comes from, and who can move it: said after it wherever it is named. */
function source(w: TakeoverWindow): string {
  const safe = "The venue's Safe can change it at once, for open loans too.";
  if (w.kind === 'reading') return `That part of the term is the loan contract's setting, still being read. ${safe}`;
  if (w.kind === 'unread') return `That part of the term is the loan contract's setting, and it could not be read just now, so none is shown. ${safe}`;
  return `${w.kind === 'window' ? 'That window' : 'That'} is the loan contract's setting, read just now. ${safe}`;
}

const lead = (w: Exclude<TakeoverWindow, { kind: 'none' }>, term: string) => (w.kind === 'window' ? `From ${w.from} to ${w.to} of ${term}` : `For part of ${term}`);

/** For a lender, before signing: their loan can be taken over, and what they then get. */
export function lenderTakeoverLine(w: TakeoverWindow): string {
  const body =
    w.kind === 'none'
      ? 'Right now the loan contract lets no other lender take a loan over.'
      : `${lead(w, "a loan's term")}, another lender can take the loan over at a lower rate without asking you or the borrower. You then get your WETH back plus the interest so far, less the venue's share of that interest.`;
  return `${body} ${source(w)}`;
}

/** For a borrower, before taking a loan: it can move to a new lender, and what that changes. */
export function borrowerTakeoverLine(w: TakeoverWindow): string {
  const body =
    w.kind === 'none'
      ? 'Right now the loan contract lets no other lender take this loan over.'
      : `${lead(w, 'the term')}, another lender can take this loan over at a lower rate without asking you. The loan then has a new number and its deadline can only move later. If the new lender lends more, the extra WETH is sent to you and you owe it too.`;
  return `${body} ${source(w)}`;
}
