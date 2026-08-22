import { useState } from 'react';
import { formatUnits, isAddress, type Address } from 'viem';
import { useVestingLockView } from '../../hooks/useVestingLockView';
import { FeatureNotDeployed } from '../ui/FeatureNotDeployed';
import { NoData, UnavailableNotice } from './NoData';

/**
 * The lock viewer: `LaunchLockView.snapshot` for one token, with the view's own
 * availability flags rendered as NO DATA rather than as zeros.
 *
 * The whole point of this surface is the distinction the contract encodes:
 *
 *   lockSourceAvailable === true, lockedTotal === 0   → nothing is locked. A fact.
 *   lockSourceAvailable === false                     → the lock rail is unset or
 *                                                       unreachable. Not a fact about
 *                                                       the token at all.
 *
 * A viewer that collapses those into "0 locked" hands a token an unearned clean bill
 * during an outage. Every number below therefore comes from a flag-guarded branch, and
 * there is no `?? 0` anywhere in this file.
 */

function unixToUtc(ts: number): string {
  return new Date(ts * 1000).toUTCString();
}

export function LockViewer() {
  const [input, setInput] = useState('');
  const [token, setToken] = useState<Address | null>(null);
  const view = useVestingLockView(token);

  if (!view.deployed) {
    return (
      <FeatureNotDeployed
        pageId="vesting"
        idx={1}
        title="The lock viewer has no contract to read yet."
        subtitle="LaunchLockView is written but undeployed, so there is no on-chain source to query. Until it ships, this page would have nothing to report — and reporting nothing as “nothing locked” is the exact mistake the view was built to prevent."
      />
    );
  }

  const snap = view.snapshot;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
        <label htmlFor="lock-token" className="block text-white/70 text-[13px] font-semibold mb-2">
          Token address
        </label>
        <div className="flex gap-2">
          <input
            id="lock-token"
            value={input}
            onChange={(e) => setInput(e.target.value.trim())}
            placeholder="0x…"
            className="flex-1 rounded-lg bg-black/40 border border-white/12 px-3 py-2 text-[13px] text-white/90 font-mono"
          />
          <button
            type="button"
            className="btn-primary px-4 py-2 text-[13px]"
            disabled={!isAddress(input)}
            onClick={() => setToken(input as Address)}
          >
            Read
          </button>
        </div>
        <p className="text-white/40 text-[11px] mt-2 leading-relaxed">
          Reads both #28 rails through LaunchLockView at {view.address}. The view reports each rail's availability
          separately, and this page renders an unavailable rail as “no data” — never as a zero.
        </p>
      </div>

      {token === null ? (
        <p className="text-white/45 text-[13px]">Enter a token address to read its vesting and lock rails.</p>
      ) : view.readFailed || !snap ? (
        <UnavailableNotice
          title="The view did not answer"
          detail={`LaunchLockView at ${view.address} could not be read for ${token}. Nothing is known about this token's locks or vesting from this page right now — this is not a report that it has none.`}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {/* ─── Vesting rail ─── */}
          <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
            <h2 className="text-white/85 font-semibold text-sm mb-3">Vesting rail</h2>
            {!snap.vestingSourceAvailable ? (
              <UnavailableNotice
                title="No data"
                detail="The view reports the vesting registry as unavailable — the rail is unset on this deployment, or the call reverted. The numbers it would carry are unknown, not zero."
              />
            ) : (
              <dl className="space-y-2 text-[13px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-white/50">Total vested to date</dt>
                  <dd className="text-white/85 tabular-nums">{formatUnits(snap.vestedInflow, 18)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-white/50">Vesting wallets</dt>
                  <dd className="text-white/85 tabular-nums">{snap.vestingWalletCount}</dd>
                </div>
                <p className="text-white/40 text-[11px] leading-relaxed pt-1">
                  Cumulative INFLOW, shown at 18 decimals because the view does not report the token's own scale. It
                  does not fall as beneficiaries release, so it is “total vested to date”, never “currently vesting”.
                </p>
              </dl>
            )}
          </div>

          {/* ─── Lock rail ─── */}
          <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
            <h2 className="text-white/85 font-semibold text-sm mb-3">Lock rail</h2>
            {!snap.lockSourceAvailable ? (
              <UnavailableNotice
                title="No data"
                detail="The view reports the lock vault as unavailable — the rail is unset on this deployment, or the call reverted. This is not a statement that nothing is locked."
              />
            ) : (
              <dl className="space-y-2 text-[13px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-white/50">Currently locked (this vault)</dt>
                  <dd className="text-white/85 tabular-nums">{formatUnits(snap.lockedTotal, 18)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-white/50">Active locks in scan</dt>
                  <dd className="text-white/85 tabular-nums">{snap.activeLockCount}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-white/50">Earliest unlock</dt>
                  <dd className="text-white/85">
                    {/* 0 means the scanned page held no active lock — a missing date, not 1970. */}
                    {snap.earliestUnlockAt === 0 ? <NoData /> : unixToUtc(snap.earliestUnlockAt)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-white/50">Latest unlock</dt>
                  <dd className="text-white/85">
                    {snap.latestUnlockAt === 0 ? <NoData /> : unixToUtc(snap.latestUnlockAt)}
                  </dd>
                </div>
                {snap.nextLockOffset !== 0 && (
                  <div className="pt-2">
                    <UnavailableNotice
                      title="Partial scan"
                      detail={`This token has more locks than one page of the scan covers (next offset ${snap.nextLockOffset}). The unlock dates above describe part of its locks only and must not be read as the token's lock expiry.`}
                    />
                  </div>
                )}
                <p className="text-white/40 text-[11px] leading-relaxed pt-1">
                  This vault only. Locks held anywhere else are outside what this view can see, so a low figure here is
                  not a claim about the token's total locked supply.
                </p>
              </dl>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
