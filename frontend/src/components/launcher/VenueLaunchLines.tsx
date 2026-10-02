import { PLANT_LINE, VENUE_LINE } from './venueLaunchCopy';

/**
 * Under the launch door, in every state of the door. The Solana rail says the plant,
 * then that this is a venue launch. The Ethereum rails say only the venue line: their
 * plant waits (ruling 4).
 */
export function VenueLaunchLines({ rail }: { rail: 'solana' | 'ethereum' }) {
  const lines = rail === 'solana' ? [PLANT_LINE, VENUE_LINE] : [VENUE_LINE];
  return (
    <div
      data-testid="venue-launch-lines"
      className="mt-3 rounded-xl px-4 py-3 space-y-1 text-[13px] text-white/80 leading-relaxed"
      style={{ background: 'rgba(6,12,26,0.78)', border: '1px solid rgba(255,255,255,0.10)' }}
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}
