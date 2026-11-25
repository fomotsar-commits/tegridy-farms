import { FinePrint } from '../../ui/FinePrint';
import { LpSummary } from '../lp/LpDisclosures';
import { Notice } from '../curve/ui';

/**
 * The risk in one sentence, first in every range Risks list, as the pools say theirs (RISK_SHORT).
 * Read 2026-11-25 UTC, finalized slot 473,596,120: Squads multisig EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK,
 * threshold 2 of 2 members, time_lock 172,800 s; its vault is the program's upgrade authority and
 * compiled admin, whose update_pool_status switches deposits, withdrawals, fee and reward collection
 * and swaps (the open-fee build, 1e896e1e). Reword it when any of that changes.
 */
export const RANGE_RISK_SHORT =
  "The team's vault can switch off withdrawals or the collection of fees and rewards, change fee rates or replace the program, 48 hours after both keys approve (read on chain 2026‑11‑25). Our changes to Raydium's program have no outside audit. Only put in what you can afford to lose.";

/** What the review says too, in this order: each one adds to the one before it. */
const REVIEW_LINES = [
  RANGE_RISK_SHORT,
  "The team's vault is a Squads multisig. It can also switch off deposits or swaps on a range pool, and every action it takes has the same wait. If it switched off withdrawals, you could not take your money out until it switched them back on.",
  "The range program is Raydium's concentrated-liquidity program with our own changes, such as who holds its keys and its fee ceilings.",
  "A change to a fee tier's rates applies to positions already open in its pools, yours too.",
] as const;

const LINES = [
  "If a pool runs a reward, the team's vault can lower its rate or end it early. Rewards not yet earned go back to whoever started it.",
  "Jupiter does not send trades to range pools. This site's own swap sends a trade to one only when it pays the trader at least as much as Jupiter does, so fees can be small.",
  "Anyone can open a range pool for any pair, at any price. Review checks this pool's price against Jupiter's.",
  'When the price moves, you can end up with less than if you had just held both coins.',
  "A coin's issuer can freeze the account a pool keeps that coin in, which stops every deposit and withdrawal. Review checks this; it is not watched for you.",
  'This browser remembers a transaction you sent until the network answers for it. Another tab does not know about it.',
] as const;

/** Beside the deposit, one press away. `reviewing`: the review on screen says REVIEW_LINES. */
export function RangeRisks({ reviewing = false }: { reviewing?: boolean }) {
  return (
    <details className="rounded-lg" style={{ border: '1px solid rgba(255,255,255,0.08)' }} data-testid="range-risks">
      <LpSummary>Risks</LpSummary>
      <ul className="list-disc pl-7 pr-3 pb-3 space-y-1 text-white/65">
        {[...(reviewing ? [] : REVIEW_LINES), ...LINES].map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </details>
  );
}

/** On the review, above its rows. */
export function RangeReviewDisclosure() {
  return (
    <div className="space-y-1" data-testid="range-review-disclosure">
      {/* On a phone the review is two screens long and its button is at the end of it. */}
      <Notice>Read this through. The Sign in wallet button is at the end of it.</Notice>
      <FinePrint summary="Risks">
        {REVIEW_LINES.map((l) => (
          <p key={l}>{l}</p>
        ))}
      </FinePrint>
    </div>
  );
}
