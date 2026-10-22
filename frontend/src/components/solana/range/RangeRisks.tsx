import { FinePrint } from '../../ui/FinePrint';
import { Notice } from '../curve/ui';

// What a person must know before putting money into a range pool: beside the deposit
// (one press away) and again on the review. The vault's wait is said as read on chain
// (Squads multisig EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK, time_lock 172,800 s,
// 2026-10-21); reword it when that changes.

/** The risk in one sentence, first in every list. */
export const RANGE_RISK_SHORT =
  "The team's vault (2 of 2 keys; each of its actions waits 48 hours, as read on chain on 2026-10-21) can switch off openings, withdrawals or swaps on a range pool, change a fee tier's rates, and replace the range program. No outside firm has checked our changes to it. Only put in what you can afford to lose.";

const LINES = [
  "The range program is Raydium's concentrated-liquidity program with the venue's own changes, such as who holds its keys and its fee ceilings. Those changes have not had an outside review.",
  'A change to a fee tier’s rates applies to positions already open in its pools, yours too.',
  'If the vault switched off withdrawals on a pool, you could not take your money out until it switched them back on. Every vault action waits 48 hours, a pause too.',
  'Jupiter does not send trades to range pools. This site’s own swap sends a trade to one only when it pays the trader at least as much as Jupiter does, so fees can be small.',
  'Anyone can open a range pool for any pair, at any price. Review checks this pool’s price against Jupiter’s.',
  'When the price moves, you can end up with less than if you had just held both coins.',
  'A coin’s issuer can freeze a pool’s vault, which stops every deposit and withdrawal. Review checks this; it is not watched for you.',
  'This browser remembers a transaction you sent until the network answers for it. Another tab does not know about it.',
] as const;

/** Beside the deposit: the risks, one press away. */
export function RangeRisks() {
  return (
    <details className="rounded-lg" style={{ border: '1px solid rgba(255,255,255,0.08)' }} data-testid="range-risks">
      <summary className="min-h-[44px] flex items-center px-3 cursor-pointer text-white/75">Risks</summary>
      <ul className="list-disc pl-7 pr-3 pb-3 space-y-1 text-white/65">
        <li>{RANGE_RISK_SHORT}</li>
        {LINES.map((l) => (
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
        <p>{RANGE_RISK_SHORT}</p>
        {LINES.slice(0, 3).map((l) => (
          <p key={l}>{l}</p>
        ))}
      </FinePrint>
    </div>
  );
}
