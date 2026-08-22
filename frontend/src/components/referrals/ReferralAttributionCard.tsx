import { shortenAddress } from '../../lib/formatting';
import { isSelfReferral } from '../../lib/referrals/attribution';
import type { ReferralAttributionState } from '../../hooks/useReferralAttribution';

// Who this browser is attributed to, why that did not change, and how to undo it.
//
// ─── FIRST-TOUCH, MADE VISIBLE ──────────────────────────────────────────────
//
// lib/referrals/attribution.ts keeps the FIRST referrer a browser ever saw and
// records every later one it declined to apply. The rule is chosen there and the
// reasoning is written there; this card is the second half of it. "Do not
// overwrite" on its own produces a user who was told they were referred by B,
// sees a prefill saying A, and has nothing on screen explaining the difference.
//
// So the `ignored` list is RENDERED, not merely retained. Each entry names the
// address that arrived, when, and on what path. That list is the only evidence a
// second link was ever seen, which is exactly why it is shown rather than
// cleaned up.
//
// ─── THE CHAIN OUTRANKS THIS CARD, AND SAYS SO ──────────────────────────────
//
// `referrerOf` is one-time and permanent (a second `setReferrer` reverts
// `AlreadyReferred`; the only escape is `updateReferrer` behind a 30-day
// cooldown). Once it is set, what this browser remembers is history, not a
// pending action — so the on-chain answer is rendered FIRST and the local record
// becomes a footnote. Anything else would offer a Link button that reverts.
//
// ─── AND `?r=` FAILURE IS ITS OWN STATE ─────────────────────────────────────
//
// A visitor who followed somebody's short link and silently arrived unattributed
// is the failure this whole slice is built around. A code that could not be
// resolved is reported as a code that could not be resolved — never as "you
// arrived with no referral".

interface Props {
  state: ReferralAttributionState;
  /** The connected wallet, for the self-referral check. */
  wallet: string | null;
  /** `referrerOf(wallet)` — the permanent on-chain answer, when there is one. */
  onChainReferrer: string | null;
  hasReferrer: boolean;
  /** Sends `setReferrer`. Absent when no write path is wired. */
  onLink?: (address: `0x${string}`) => void;
  busy?: boolean;
}

function when(at: number | null): string {
  // Null is a real answer, not a missing one — a record written by the legacy
  // HomePage capture genuinely has no timestamp, and any date printed here would
  // be invented. See attribution.ts.
  return at === null ? 'time not recorded' : new Date(at).toLocaleString();
}

export function ReferralAttributionCard({
  state,
  wallet,
  onChainReferrer,
  hasReferrer,
  onLink,
  busy,
}: Props) {
  const { attribution, codeResolution, forget } = state;
  const selfReferral = attribution ? isSelfReferral(attribution.address, wallet) : false;
  const canLink = !!onLink && !!attribution && !hasReferrer && !selfReferral && !!wallet;

  return (
    <section
      className="rounded-xl p-4"
      style={{ background: '#000', border: '1px solid var(--color-purple-75)' }}
      aria-label="Who referred you"
    >
      <h3 className="text-white text-[13px] font-medium">Who referred you</h3>

      {/* The chain is the authority the moment it has an answer. */}
      {hasReferrer && onChainReferrer && (
        <p className="mt-2 text-white/80 text-[12px] leading-relaxed">
          On-chain, this wallet is referred by{' '}
          <span className="font-mono text-purple-300">{shortenAddress(onChainReferrer)}</span>. That record is
          permanent — the splitter refuses a second <span className="font-mono">setReferrer</span>, and changing it
          needs <span className="font-mono">updateReferrer</span> after a 30-day cooldown.
        </p>
      )}

      {codeResolution.phase === 'resolving' && (
        <p className="mt-2 text-white/60 text-[12px]">Resolving the short link you arrived with…</p>
      )}

      {codeResolution.phase === 'failed' && (
        <p role="alert" className="mt-2 text-[12px] leading-relaxed" style={{ color: '#FFD37C' }}>
          You arrived with the short link <span className="font-mono">?r={codeResolution.code}</span> and it could not
          be resolved, so no referrer was recorded for this visit. {codeResolution.detail} Ask whoever shared it for
          their full <span className="font-mono">?ref=0x…</span> link, which needs no server.
        </p>
      )}

      {!attribution && codeResolution.phase !== 'failed' && (
        <p className="mt-2 text-white/60 text-[12px] leading-relaxed">
          {hasReferrer
            ? 'This browser is not carrying a referral link, which changes nothing — the on-chain record above is what pays.'
            : 'This browser is not carrying a referral link. Arriving through one stores it here until you link it on-chain.'}
        </p>
      )}

      {attribution && (
        <>
          <p className="mt-2 text-white/80 text-[12px] leading-relaxed">
            This browser is attributed to{' '}
            <span className="font-mono text-purple-300">{shortenAddress(attribution.address)}</span> — first seen{' '}
            {when(attribution.capturedAt)}
            {attribution.path ? (
              <>
                {' '}
                on <span className="font-mono">{attribution.path}</span>
              </>
            ) : null}
            .{' '}
            {attribution.source === 'legacy' && (
              <span className="text-white/50">
                Stored before this page recorded capture details, so its arrival time is genuinely unknown rather than
                missing.
              </span>
            )}
          </p>

          {/* ─── FIRST-TOUCH, SHOWN ────────────────────────────────────── */}
          {attribution.ignored.length > 0 && (
            <div className="mt-3 rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)' }}>
              <p className="text-white/80 text-[11px] font-medium">
                {attribution.ignored.length === 1
                  ? 'One later referral link was not applied'
                  : `${attribution.ignored.length} later referral links were not applied`}
              </p>
              <p className="mt-1 text-white/60 text-[11px] leading-relaxed">
                This page keeps the FIRST referrer a browser sees. A later link cannot overwrite it, because the
                on-chain record it feeds is permanent and the second link is the one anybody can make you click.
              </p>
              <ul className="mt-2 space-y-1">
                {attribution.ignored.map((entry) => (
                  <li key={`${entry.address}-${entry.at}`} className="text-white/50 text-[11px] font-mono">
                    {shortenAddress(entry.address)} · {when(entry.at)}
                    {entry.path ? ` · ${entry.path}` : ''}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-white/50 text-[11px] leading-relaxed">
                If one of these is the person who actually recruited you, clear the attribution below and follow their
                link again.
              </p>
            </div>
          )}

          {selfReferral && (
            <p role="alert" className="mt-2 text-[11px]" style={{ color: '#FFD37C' }}>
              This link points at the connected wallet. The splitter rejects a self-referral, so it cannot be linked.
            </p>
          )}

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            {canLink && (
              <button
                type="button"
                onClick={() => onLink!(attribution.address as `0x${string}`)}
                disabled={busy}
                className="btn-primary px-4 py-2.5 text-[12px] disabled:opacity-60"
              >
                {busy ? 'Linking…' : 'Link this referrer on-chain'}
              </button>
            )}
            <button
              type="button"
              onClick={forget}
              className="px-4 py-2.5 rounded-lg text-[12px] text-white bg-black/40 hover:bg-black/60 border border-white/20 transition-colors"
            >
              Forget this attribution
            </button>
          </div>

          {canLink && (
            <p className="mt-2 text-white/50 text-[11px] leading-relaxed">
              Linking is one permanent transaction. It costs you nothing beyond gas and gives you no discount — it
              directs a share of the fees you would pay anyway to the wallet above, if that wallet clears the staking
              threshold at the time each fee is recorded.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export default ReferralAttributionCard;
