import { formatWei } from '../../lib/formatting';
import type { ClaimVerdict } from '../../lib/referrals/qualification';

// What ReferralSplitter actually holds for this wallet, and nothing else.
//
// ─── EVERY NUMBER HERE IS A READ, NOT A PROJECTION ──────────────────────────
//
// The claimable figure is `pendingETH(wallet)` passed through untouched. There
// is deliberately no "you have earned about X", no per-referee estimate and no
// annualised anything on this card. A referral fee depends on trade volume that
// has not happened, and any number placed beside a Claim button is read as an
// entitlement no matter how it is hedged.
//
// ─── AND A FAILED READ IS NEVER A ZERO ──────────────────────────────────────
//
// `useReferralStanding` maps every failed contract read to null, and
// qualification.ts collapses any null into an `unknown` verdict. This card is
// the last link in that chain: `unknown` renders as "could not be read" with NO
// figure, because "0 ETH claimable" and "we could not ask the chain" look
// identical on a claim screen and only one of them means the user has nothing.
//
// The same rule applies to the two counters. `referredCount` of null prints as
// unread, not as zero — "nobody has used your link" is a fact about the wallet,
// and an RPC failure is not.
//
// ─── THE THREE STATES THAT USED TO BE ONE ───────────────────────────────────
//
// A wallet with an empty claim page is in one of several genuinely different
// situations, and the old surface rendered them all as three zeroes:
//
//   never-registered  nobody has ever linked this wallet as their referrer
//   too-recent        MIN_REFERRAL_AGE — 7 days from the FIRST referee linking,
//                     not from each fee — during which claiming reverts even
//                     with a real balance
//   nothing-pending   the chain answered, and the balance is genuinely zero
//
// They are separate branches here because the action a user should take differs
// in each, and guessing wrong costs them either a wasted transaction or a
// pointless unstake.

interface Props {
  claim: ClaimVerdict;
  /** True while the first round of reads is in flight. */
  isLoading: boolean;
  connected: boolean;
  /** From `getReferralInfo`. Null when that read failed — never defaulted to 0. */
  referredCount: number | null;
  /** Lifetime `totalEarned`, wei. Null when the read failed. */
  lifetimeEarnedWei: bigint | null;
  /** Lifetime `totalForfeited`, wei — credits routed to treasury. Null on failure. */
  forfeitedWei: bigint | null;
  /** Sends `claimReferralRewards`. Absent when no write path is wired. */
  onClaim?: () => void;
  /** A transaction is in flight. */
  busy?: boolean;
}

/** A wei figure, or the reason there is no figure. Never a fallback number. */
function wei(value: bigint | null): string {
  return value === null ? 'not read' : `${formatWei(value, 18, 6)} ETH`;
}

function unlockDate(unlocksAt: bigint): string {
  // Chain seconds → ms. Rendered as a date, not a countdown: the contract
  // compares against `block.timestamp`, and a ticking "2h 14m" implies a
  // precision the next block can move.
  return new Date(Number(unlocksAt) * 1000).toLocaleString();
}

export function ReferralEarningsCard({
  claim,
  isLoading,
  connected,
  referredCount,
  lifetimeEarnedWei,
  forfeitedWei,
  onClaim,
  busy,
}: Props) {
  return (
    <section
      className="rounded-xl p-4"
      style={{ background: '#000', border: '1px solid var(--color-purple-75)' }}
      aria-label="Your referral earnings"
    >
      <h3 className="text-white text-[13px] font-medium">What the splitter holds for you</h3>

      {!connected && (
        <p className="mt-2 text-white/60 text-[12px] leading-relaxed">
          Balances are per-wallet on-chain state. Connect a wallet and this reads it. Nothing is shown meanwhile
          because nothing has been read.
        </p>
      )}

      {connected && isLoading && <p className="mt-2 text-white/60 text-[12px]">Reading the splitter…</p>}

      {connected && !isLoading && (
        <>
          <div className="mt-3">
            {claim.kind === 'claimable' && (
              <div
                className="rounded-lg p-4 flex items-center justify-between flex-wrap gap-3"
                style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.22)' }}
              >
                <div>
                  <p className="text-emerald-400/70 text-[10px] uppercase tracking-wider mb-0.5">Claimable now</p>
                  {/* `pendingETH`, straight from the contract. */}
                  <p className="stat-value text-[16px] text-emerald-400">{formatWei(claim.pendingWei, 18, 6)} ETH</p>
                </div>
                {onClaim && (
                  <button
                    type="button"
                    onClick={onClaim}
                    disabled={busy}
                    className="btn-primary px-5 py-2.5 text-[12px] disabled:opacity-60"
                  >
                    {busy ? 'Claiming…' : 'Claim ETH'}
                  </button>
                )}
              </div>
            )}

            {claim.kind === 'nothing-pending' && (
              <p className="text-white/70 text-[12px] leading-relaxed">
                The splitter answered: <strong className="text-white">0 ETH</strong> is claimable. That is a read, not a
                failure — no referee fee has been credited to this wallet since its last claim.
              </p>
            )}

            {claim.kind === 'never-registered' && (
              <p className="text-white/70 text-[12px] leading-relaxed">
                No wallet has linked this address as their referrer yet, so the splitter holds no balance and the 7-day
                claim clock has not started. Sharing a link is what starts it — but read the requirement above first.
              </p>
            )}

            {claim.kind === 'too-recent' && (
              <p role="status" className="text-white/70 text-[12px] leading-relaxed">
                Claiming is locked until <strong className="text-white">{unlockDate(claim.unlocksAt)}</strong>. The
                splitter enforces a 7-day minimum age counted from when the first wallet linked you — not per fee and
                not per claim — and a claim before then reverts. Any balance keeps accruing in the meantime.
              </p>
            )}

            {(claim.kind === 'unknown' || claim.kind === 'engine-inert' || claim.kind === 'banned') && (
              <p role="alert" className="text-[12px] leading-relaxed" style={{ color: '#FFD37C' }}>
                {claim.reason}
                {claim.kind === 'unknown' && (
                  <span className="text-white/60"> No balance is shown, because none was read.</span>
                )}
              </p>
            )}
          </div>

          <dl className="mt-4 grid grid-cols-3 gap-3">
            <div className="bg-black/40 rounded-lg p-3 text-center">
              <dt className="text-white text-[10px] uppercase tracking-wider label-pill mb-1">Referred</dt>
              <dd className="stat-value text-[16px] text-white">
                {referredCount === null ? <span className="text-white/50 text-[12px]">not read</span> : referredCount}
              </dd>
            </div>
            <div className="bg-black/40 rounded-lg p-3 text-center">
              <dt className="text-white text-[10px] uppercase tracking-wider label-pill mb-1">Earned lifetime</dt>
              <dd className="stat-value text-[13px] text-white">{wei(lifetimeEarnedWei)}</dd>
            </div>
            <div className="bg-black/40 rounded-lg p-3 text-center">
              {/* Forfeited is shown beside earned deliberately. `totalEarned`
                  includes credits that were later routed to the treasury, so
                  earned alone overstates what a wallet ever received. */}
              <dt className="text-white text-[10px] uppercase tracking-wider label-pill mb-1">Forfeited</dt>
              <dd className="stat-value text-[13px] text-white">{wei(forfeitedWei)}</dd>
            </div>
          </dl>

          <p className="mt-3 text-white/50 text-[11px] leading-relaxed">
            “Earned lifetime” is the splitter’s <span className="font-mono">totalEarned</span>, which counts credits that
            were later forfeited to the treasury. “Forfeited” is that portion. Neither figure is an estimate and neither
            is computed here.
          </p>
        </>
      )}
    </section>
  );
}

export default ReferralEarningsCard;
