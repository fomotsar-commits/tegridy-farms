import { useEffect, useState } from 'react';
import { fetchVenueVolume, type VenueVolume as Volume } from '../lib/venueVolume';
import { FinePrint } from './ui/FinePrint';

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const whenFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * The venue's all-time volume, counted hourly (venue-volume.yml). Says when it was counted,
 * and says so when that count is not up to date. A failed read says it could not be read.
 */
export function VenueVolume() {
  const [volume, setVolume] = useState<Volume | null>(null);
  useEffect(() => {
    let live = true;
    void fetchVenueVolume().then((v) => {
      if (live) setVolume(v);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="mt-3 min-h-[20px] text-[13px] text-white/85" data-testid="venue-volume">
      {volume?.state === 'unread' && <p className="text-white/60">All-time volume could not be read</p>}
      {(volume?.state === 'current' || volume?.state === 'behind') && (
        <>
          <p>
            All-time volume <span className="font-semibold text-white">{usdFmt.format(volume.usd)}</span>
            {' · '}
            {volume.state === 'current' ? (
              <span className="text-white/60">as of {whenFmt.format(volume.asOf)}</span>
            ) : (
              <span style={{ color: 'var(--color-warning)' }}>
                not up to date, last counted {whenFmt.format(volume.asOf)}
              </span>
            )}
          </p>
          <FinePrint summary="What counts">
            <p>
              {volume.swaps.toLocaleString('en-US')} swaps in our Solana pools, Jupiter swaps made here, and our
              Ethereum pool. Each is valued in dollars the hour it is counted. Counted hourly.
            </p>
          </FinePrint>
        </>
      )}
    </div>
  );
}
