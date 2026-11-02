import { useEffect, useState } from 'react';
import { fetchVenueTvl, TVL_CHAINS, type TvlChain, type TvlStaking, type VenueTvl } from '../lib/venueTvl';
import { fetchVenueVolume, type VenueVolume } from '../lib/venueVolume';
import { FinePrint } from './ui/FinePrint';

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const whenFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** Both figures are asked for again every minute while the page is in view. */
export const POLL_MS = 60_000;
/** A TVL kept through failed refreshes says how old it is once it is older than this. */
const TVL_OLD_MS = 3 * 60_000;

/** One part of the TVL, chain by chain: "Solana $X · Base could not be read just now". */
const byChain = (rows: (TvlChain | TvlStaking)[]) =>
  rows.map((c) => (c.read ? `${TVL_CHAINS[c.chain]} ${usdFmt.format(c.usd)}` : `${TVL_CHAINS[c.chain]} could not be read just now`)).join(' · ');

/** A failed refresh keeps the last figure that was read; its own time then says how old it is. */
function keepRead<T extends { state: string }>(prev: T | null, next: T): T {
  return next.state === 'unread' && prev && prev.state !== 'unread' ? prev : next;
}

/**
 * The venue's TVL, read from every chain each minute, and its all-time volume, counted every
 * few minutes. A figure that could not be read says so; one that is partial or late says that.
 */
export function VenueStats() {
  const [tvl, setTvl] = useState<VenueTvl | null>(null);
  // When this page last received a TVL it could read, by its own clock (the server's may differ).
  const [tvlAt, setTvlAt] = useState(0);
  const [volume, setVolume] = useState<VenueVolume | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    const refresh = () => {
      setNow(Date.now());
      void fetchVenueTvl().then((t) => {
        if (!live) return;
        if (t.state !== 'unread') setTvlAt(Date.now());
        setTvl((prev) => keepRead(prev, t));
      });
      void fetchVenueVolume().then((v) => live && setVolume((prev) => keepRead(prev, v)));
    };
    refresh();
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, POLL_MS);
    // Back in view after a while: read at once instead of showing what was read before.
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const tvlRead = tvl?.state === 'current' || tvl?.state === 'partial' ? tvl : null;
  const tvlOld = tvlRead !== null && now - tvlAt > TVL_OLD_MS;
  const volumeRead = volume?.state === 'current' || volume?.state === 'behind' ? volume : null;

  return (
    <div className="mt-3 min-h-[20px] text-[13px] text-white/85" data-testid="venue-stats">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {tvl?.state === 'unread' && <span className="text-white/60">TVL could not be read</span>}
        {tvlRead && (
          <span data-testid="venue-tvl" className="inline-flex items-baseline gap-1.5">
            {tvlRead.state === 'current' && !tvlOld && (
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 self-center rounded-full motion-safe:animate-pulse"
                style={{ background: 'var(--color-success)' }}
                aria-hidden="true"
              />
            )}
            <span>
              {tvlRead.state === 'partial' ? 'TVL at least ' : 'TVL '}
              <span className="font-semibold text-white">{usdFmt.format(tvlRead.usd)}</span>
              {tvlOld && <span className="text-white/60"> as of {timeFmt.format(tvlRead.readAt)}</span>}
            </span>
          </span>
        )}
        {tvl && volume && <span className="text-white/40" aria-hidden="true">&middot;</span>}
        {volume?.state === 'unread' && <span className="text-white/60">All-time volume could not be read</span>}
        {volumeRead && (
          <span data-testid="venue-volume">
            All-time volume <span className="font-semibold text-white">{usdFmt.format(volumeRead.usd)}</span>
            {volumeRead.state === 'behind' && (
              <span style={{ color: 'var(--color-warning)' }}> &middot; not up to date, last counted {whenFmt.format(volumeRead.asOf)}</span>
            )}
          </span>
        )}
      </p>
      {(tvlRead || volumeRead) && (
        <FinePrint summary="What counts">
          {tvlRead && (
            <>
              <p data-testid="venue-tvl-chains">Pools: {byChain(tvlRead.chains)}</p>
              <p data-testid="venue-tvl-staking">Staked: {byChain(tvlRead.staking)}</p>
              {tvlRead.chains.some((c) => c.read && c.unvalued > 0) && (
                <p>Pools paired with BAYLA are left out while none of our pools gives BAYLA a price.</p>
              )}
              {tvlRead.staking.some((c) => c.read && c.unvalued > 0) && <p>A staked coin with no market price just now is left out.</p>}
              <p>
                TVL is what our pools hold plus what is staked in our staking pools, read from each chain every minute.
                A pool counts at twice its SOL, USDC, BAYLA or ETH; a range pool counts only those coins; other tokens in
                a pool never add to it. A staked coin counts at its market price: Jupiter's on Solana, DefiLlama's on
                Ethereum and Base.
              </p>
            </>
          )}
          {volumeRead && (
            <p>
              Volume: {volumeRead.swaps.toLocaleString('en-US')} swaps in our Solana pools, Jupiter swaps made here, and
              our pools on Ethereum, Base and Robinhood. Each is valued in dollars when it is counted. Last counted{' '}
              {whenFmt.format(volumeRead.asOf)}.
            </p>
          )}
        </FinePrint>
      )}
    </div>
  );
}
