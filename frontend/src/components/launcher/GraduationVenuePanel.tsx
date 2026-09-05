// Where a launch's liquidity ends up — the disclosure that did not exist.
//
// A creator signs a launch whose graduation destination, LP-lock terms and post-graduation
// fee split are all fixed at that signature and irreversible afterwards. None of it was
// rendered anywhere. This panel states all four, and states them as they are TODAY:
// graduation runs through Doppler's external migrator, the LP is escrowed rather than
// burned, and the protocol earns a share of someone else's pool.
//
// The venue-owned path is described only as a target, under its own heading, with the
// operator steps that would switch it on. Nothing here may read as though it is live —
// the honesty guard in GraduationVenuePanel.test.tsx asserts the external disclosure is
// present and that no "LP burned" claim appears while the venue migrator is unset.

import { useGraduationVenue } from '../../hooks/useGraduationVenue';
import { useGraduationFeeLine } from '../../hooks/useGraduationFeeLine';
import {
  resolveSolanaGraduationVenue,
  plannedVenueMigrator,
  feeLineStatement,
  claimAuthorityStatement,
  feePercent,
  type FeeCredit,
  type GraduationVenuePlan,
} from '../../lib/launcher/graduation';
import { TOWELI_ADDRESS, TOWELI_DECIMALS } from '../../lib/constants';
import { formatWei, shortenAddress } from '../../lib/formatting';

const NATIVE = '0x0000000000000000000000000000000000000000';

/** Months, when a duration was supplied. Null in, null out — never a default term. */
export function formatLockDuration(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const months = seconds / (365 * 24 * 3600 / 12);
  const rounded = Math.round(months * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'month' : 'months'}`;
}

/**
 * A credited balance, rendered only in units we can prove. Native ETH and TOWELI have
 * known decimals; anything else prints as exact base units rather than being divided by
 * an assumed 18, which would silently misstate a 6-decimal token by a factor of a
 * trillion. Pure; exported for tests.
 */
export function formatCredit(credit: FeeCredit): string {
  const key = credit.currency.toLowerCase();
  if (key === NATIVE) return `${formatWei(credit.amount, 18)} ETH`;
  if (key === TOWELI_ADDRESS.toLowerCase()) return `${formatWei(credit.amount, TOWELI_DECIMALS)} TOWELI`;
  return `${credit.amount.toString()} base units (decimals not read)`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap py-2 border-b border-white/10 last:border-b-0">
      <span className="text-[12px] text-white/55 shrink-0">{label}</span>
      <span className="text-[13px] text-white/90 font-mono text-right break-all min-w-0">{children}</span>
    </div>
  );
}

function RailBlock({ plan }: { plan: GraduationVenuePlan }) {
  const lockLabel = formatLockDuration(plan.lpLock.durationSeconds);
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-2">
      <Row label="Venue">{plan.pool.venue}</Row>
      <Row label="Migrator">
        {plan.migrator.address ? shortenAddress(plan.migrator.address) : '—'} · {plan.migrator.label}
      </Row>
      <Row label="Graduated pool fee">
        {plan.pool.feeHundredthsBips === null
          ? 'not yet determined'
          : `${feePercent(plan.pool.feeHundredthsBips)}%`}
      </Row>
      <Row label="Pool id">
        {plan.pool.poolId ? (
          shortenAddress(plan.pool.poolId, 8)
        ) : (
          // Not "none" and not a placeholder hash: the id is unknown until a token exists.
          <span className="text-white/60">not yet determined</span>
        )}
      </Row>
      <Row label="LP after graduation">
        {plan.lpLock.custodianLabel}
        {lockLabel ? ` · ${lockLabel}` : ''}
      </Row>
    </div>
  );
}

export function GraduationVenuePanel() {
  const { plan, moduleCheck, isChecking, checkSkipped } = useGraduationVenue();
  const feeLine = useGraduationFeeLine(true);
  const solana = resolveSolanaGraduationVenue();
  const planned = plannedVenueMigrator();
  const venueOwned = plan.migrator.ownership === 'venue-owned';

  return (
    <div className="glass-card p-6 rounded-2xl" aria-label="Graduation venue">
      <h2
        className="heading-luxury text-white text-[20px] tracking-tight mb-2"
        style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
      >
        Where launches graduate
      </h2>

      {/* The load-bearing sentence. Rendered FIRST and unconditionally, because every
          number below it is a number about someone else's pool while this is true. */}
      <div
        className={`rounded-xl border p-4 mb-5 ${
          venueOwned
            ? 'border-emerald-500/30 bg-emerald-500/10'
            : 'border-amber-500/40 bg-amber-500/10'
        }`}
      >
        {/* break-words is load-bearing, not cosmetic. This sentence embeds a full
            42-character migrator address, which is one unbreakable token: at
            iPhone/Pixel width (393px) it pushed the whole document to 412px, so
            /launch scrolled sideways and the fixed header, tab strip and bottom
            nav all stretched with it. Measured with Playwright, not inferred. */}
        <p className={`text-sm break-words ${venueOwned ? 'text-emerald-200' : 'text-amber-200'}`}>
          {plan.disclosure}
        </p>
      </div>

      <h3 className="text-[13px] uppercase tracking-wide text-white/50 mb-2">Ethereum rail</h3>
      <RailBlock plan={plan} />

      <p className="text-xs text-white/60 mt-2 leading-relaxed">{plan.lpLock.note}</p>

      {/* Whitelisting is what Airlock.create enforces, so this is the read that decides
          whether a launch can be created against this migrator at all. Three states. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-mono">
        {checkSkipped ? (
          <span className="px-2 py-1 rounded-md bg-white/5 text-white/60 border border-white/10">
            MODULE STATE NOT CHECKED — no RPC
          </span>
        ) : isChecking || moduleCheck === null ? (
          <span className="px-2 py-1 rounded-md bg-white/5 text-white/60 border border-white/10">
            CHECKING MODULE STATE…
          </span>
        ) : moduleCheck.unreadable ? (
          // Not "not whitelisted": we failed to look. A red badge here would be a finding
          // about a module nobody queried.
          <span className="px-2 py-1 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30">
            MODULE STATE UNREADABLE — not a negative result
          </span>
        ) : moduleCheck.whitelisted ? (
          <span className="px-2 py-1 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            WHITELISTED BY AIRLOCK (state 4)
          </span>
        ) : (
          <span className="px-2 py-1 rounded-md bg-red-500/15 text-red-300 border border-red-500/30">
            NOT WHITELISTED (state {moduleCheck.state}) — launches would fail at create
          </span>
        )}
      </div>

      <h3 className="text-[13px] uppercase tracking-wide text-white/50 mt-6 mb-2">
        Graduated-pool fee split
      </h3>
      <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-2">
        {plan.feeSplit.map((line) => (
          <Row key={`${line.role}-${line.recipient}`} label={line.recipient}>
            {(line.shareBps / 100).toFixed(2)}%{line.protocol ? ' · protocol' : ''}
          </Row>
        ))}
      </div>
      {/*
        The effective-rate sentence MULTIPLIES the pool fee, so with an unknown fee there
        is no product to state. Substituting 0 would render "0.0000% of traded value" —
        a precise-looking number for a pool whose fee nobody has set yet.
      */}
      {plan.pool.feeHundredthsBips === null ? (
        <p className="text-xs text-white/60 mt-2 leading-relaxed">
          Shares are of the graduated pool&rsquo;s trade fee, not of volume. That fee is{' '}
          <strong>not yet determined</strong> — it lives on an AMM config that has not been created —
          so the protocol&rsquo;s {(plan.protocolShareBps / 100).toFixed(2)}% of it cannot be expressed as a
          share of traded value yet.
        </p>
      ) : (
        <p className="text-xs text-white/60 mt-2 leading-relaxed">
          Shares are of the graduated pool&rsquo;s {feePercent(plan.pool.feeHundredthsBips)}% trade fee, not of
          volume. The protocol&rsquo;s {(plan.protocolShareBps / 100).toFixed(2)}% of that fee works out to{' '}
          {((plan.protocolShareBps / 10_000) * (plan.pool.feeHundredthsBips / 10_000)).toFixed(4)}% of traded
          value{venueOwned ? '.' : ', and it is a share of an external venue’s pool fee — not the pool fee itself.'}
        </p>
      )}

      <h3 className="text-[13px] uppercase tracking-wide text-white/50 mt-6 mb-2">
        Protocol fee line (read-only)
      </h3>
      {feeLine.error ? (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4">
          <p className="text-sm text-red-300">Could not read the fee line. {feeLine.error}</p>
          <p className="text-xs text-red-200/70 mt-1">This is a failed read, not a zero balance.</p>
        </div>
      ) : feeLine.read === null ? (
        <p className="text-sm text-white/70">{feeLine.isLoading ? 'Reading the fee sink…' : 'Fee line not read.'}</p>
      ) : (
        <>
          <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-2">
            <Row label="Sink">{shortenAddress(feeLine.read.sink)}</Row>
            {feeLine.read.destinations ? (
              <>
                <Row label="Locker (read back)">{shortenAddress(feeLine.read.destinations.locker)}</Row>
                <Row label="ETH leg → ">{shortenAddress(feeLine.read.destinations.revenueDistributor)}</Row>
                <Row label="Token leg → ">{shortenAddress(feeLine.read.destinations.treasury)}</Row>
              </>
            ) : (
              <Row label="Destinations">
                <span className="text-amber-300">could not be read on-chain</span>
              </Row>
            )}
            {feeLine.read.credits.map((c) => (
              <Row key={c.currency} label={c.currency === NATIVE ? 'native ETH' : shortenAddress(c.currency)}>
                {formatCredit(c)}
              </Row>
            ))}
          </div>

          <p className="text-xs text-white/70 mt-2 leading-relaxed">{feeLineStatement(feeLine.read)}</p>

          {feeLine.read.pointsAtOurLocker === false && (
            <p className="text-xs text-red-300 mt-2">
              The sink&rsquo;s locker does not match the locker our launches graduate into, so this fee
              line would never be credited.
            </p>
          )}
          {feeLine.assetsUnavailable && (
            <p className="text-xs text-amber-300/80 mt-2">
              Launch-asset discovery was unavailable — only base pairs were checked, so
              asset-denominated credits may be missing.
            </p>
          )}
          <p className="text-xs text-white/50 mt-2 leading-relaxed">{claimAuthorityStatement()}</p>
        </>
      )}

      <h3 className="text-[13px] uppercase tracking-wide text-white/50 mt-6 mb-2">Solana rail</h3>
      <RailBlock plan={solana} />
      <p className="text-xs text-white/60 mt-2 leading-relaxed">{solana.disclosure}</p>

      {plan.preconditions.length > 0 && (
        <>
          <h3 className="text-[13px] uppercase tracking-wide text-white/50 mt-6 mb-2">
            What venue graduation would require
          </h3>
          {/* Explicitly a target, not a roadmap promise: the address below is unset and the
              list is the operator's, in order. */}
          <p className="text-xs text-white/60 mb-2">
            Target venue: {planned.venue}. Migrator address is currently unset
            ({shortenAddress(planned.address)}), which is why the external path above is what runs.
          </p>
          <ol className="list-decimal ml-5 space-y-1 text-xs text-white/65">
            {plan.preconditions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

export default GraduationVenuePanel;
