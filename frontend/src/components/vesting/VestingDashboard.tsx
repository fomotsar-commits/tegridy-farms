import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import { useVestingStreams, type VestingStream } from '../../hooks/useVestingStreams';
import { shortenAddress } from '../../lib/formatting';
import { FeatureNotDeployed } from '../ui/FeatureNotDeployed';
import { NoData, UnavailableNotice } from './NoData';
import { VestingScheduleBar } from './VestingScheduleBar';

/**
 * Streams in and out for the connected wallet.
 *
 * Two honesty rules run through this panel:
 *
 *   1. A stream whose own `vestingInfo()` read failed is listed with its address and an
 *      explicit no-data row. It is never dropped from the list — a missing row would
 *      understate what the wallet has, silently.
 *   2. Amounts render only when the token's decimals were actually read. A balance
 *      scaled by an assumed 18 is a wrong number wearing a right number's clothes, and
 *      the decimals read is cheap enough that guessing has no excuse.
 */

function StreamCard({ stream, now }: { stream: VestingStream; now: number }) {
  const { info, tokenDecimals, tokenSymbol } = stream;

  return (
    <li className="rounded-2xl border border-white/10 bg-black/20 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-white/85 text-sm font-semibold font-mono">{shortenAddress(stream.wallet, 6)}</p>
          <p className="text-white/40 text-[11px] mt-0.5">
            {stream.direction === 'incoming' ? 'You are the beneficiary' : 'You funded this stream'}
          </p>
        </div>
        {info?.fullyVested && (
          <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
            FULLY VESTED
          </span>
        )}
      </div>

      {!info ? (
        <div className="mt-3">
          <UnavailableNotice
            title="No data"
            detail="This wallet is in the registry, but its own read did not return. Its balance, schedule and releasable amount are unknown — this row is shown rather than hidden so the list stays complete."
          />
        </div>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
            <div>
              <dt className="text-white/45 text-[11px]">Token</dt>
              <dd className="text-white/80 font-mono text-[12px]">
                {tokenSymbol ?? shortenAddress(info.token, 4)}
              </dd>
            </div>
            <div>
              <dt className="text-white/45 text-[11px]">In wallet</dt>
              <dd>
                {tokenDecimals === null ? (
                  <NoData label="Token decimals could not be read, so this balance cannot be scaled correctly." />
                ) : (
                  <span className="text-white/85 tabular-nums">{formatUnits(info.balance, tokenDecimals)}</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-white/45 text-[11px]">Releasable now</dt>
              <dd>
                {tokenDecimals === null ? (
                  <NoData />
                ) : (
                  <span className="text-emerald-300/90 tabular-nums">
                    {formatUnits(info.releasable, tokenDecimals)}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-white/45 text-[11px]">Already released</dt>
              <dd>
                {tokenDecimals === null ? (
                  <NoData />
                ) : (
                  <span className="text-white/70 tabular-nums">{formatUnits(info.released, tokenDecimals)}</span>
                )}
              </dd>
            </div>
          </dl>

          <VestingScheduleBar info={info} now={now} />

          <p className="text-white/35 text-[11px] mt-3 leading-relaxed">
            No clawback exists on this rail: the creator cannot revoke or shorten the schedule, and the protocol has no
            path to these funds. Releases pay {shortenAddress(info.beneficiary, 4)} whoever sends the transaction.
          </p>
        </>
      )}
    </li>
  );
}

export function VestingDashboard() {
  const { isConnected } = useAccount();
  const streams = useVestingStreams();
  // Ticked rather than read at render: a schedule bar that only advances when some
  // unrelated state changes would show a stale vested position for as long as the page
  // sits idle, which on a cliff boundary is the difference between "not reached" and
  // "reached". Same 1-Hz shape as useCountdown / HeatCard.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const iv = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(iv);
  }, []);

  if (!streams.deployed) {
    return (
      <FeatureNotDeployed
        pageId="vesting"
        idx={1}
        title="The vesting registry isn't deployed yet."
        subtitle="VestingFactory is written but has no address on this deployment, so there is no registry to read. Streams created elsewhere are not visible here, and this page does not pretend otherwise."
      />
    );
  }

  if (!isConnected) {
    return (
      <p className="text-white/50 text-[13px]">
        Connect a wallet to see the streams it receives and the streams it funded. Nothing has been read yet.
      </p>
    );
  }

  const incoming = streams.streams.filter((s) => s.direction === 'incoming');
  const outgoing = streams.streams.filter((s) => s.direction === 'outgoing');

  return (
    <div className="space-y-6">
      {streams.registryIncomplete && (
        <UnavailableNotice
          title="Registry read incomplete"
          detail={`One or more registry calls to ${streams.factoryAddress} did not return. The lists below may be missing streams — treat this page as partial until it reloads cleanly.`}
        />
      )}
      {streams.streamReadIncomplete && (
        <UnavailableNotice
          title="Some streams did not report"
          detail="At least one vesting wallet in the registry did not answer its own read. Those rows are listed with a no-data marker rather than dropped."
        />
      )}

      <section>
        <h2 className="text-white/80 font-semibold text-sm mb-3">
          Streams in <span className="text-white/40 font-normal">({incoming.length})</span>
        </h2>
        {incoming.length === 0 ? (
          <p className="text-white/45 text-[13px]">
            {streams.registryIncomplete
              ? 'Unknown — the registry read did not complete.'
              : 'The registry answered: this wallet is the beneficiary of no streams from this factory.'}
          </p>
        ) : (
          <ul className="space-y-3">
            {incoming.map((s) => (
              <StreamCard key={s.wallet} stream={s} now={now} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-white/80 font-semibold text-sm mb-3">
          Streams out <span className="text-white/40 font-normal">({outgoing.length})</span>
        </h2>
        {outgoing.length === 0 ? (
          <p className="text-white/45 text-[13px]">
            {streams.registryIncomplete
              ? 'Unknown — the registry read did not complete.'
              : 'The registry answered: this wallet has funded no streams through this factory.'}
          </p>
        ) : (
          <ul className="space-y-3">
            {outgoing.map((s) => (
              <StreamCard key={s.wallet} stream={s} now={now} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
