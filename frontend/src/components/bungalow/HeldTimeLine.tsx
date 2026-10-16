import { poolReadByIsland, type Bungalow } from '../../lib/bungalows';
import { FinePrint } from '../ui/FinePrint';

const READ = 'Staking keeps your held time.';
/** The unread case in one line (owner, 2026-10-14: fewer words); the full sentence sits one press away. */
const UNREAD_SHORT = 'Not counted as held time yet. Your clock is not reset.';
const UNREAD =
  'Heat reads wallets today. A bag locked here is not counted until the island reads this pool. Your clock is not reset.';

const LINE = 'm-0 text-[12px] leading-relaxed';
const TONE = { color: 'rgba(255,255,255,0.72)' } as const;

/**
 * One line under a staking card's headline figures: whether the island counts a bag
 * locked in this pool as held. The registry decides (poolReadByIsland); a card only
 * passes its chain and pool. A plain paragraph: no role, no modal, no alarm colour.
 * The unread case keeps its full explanation, word for word, in a closed FinePrint.
 */
export function HeldTimeLine({ chain, pool, className = '' }: {
  chain: Bungalow['chain'];
  pool: string | undefined;
  className?: string;
}) {
  const read = poolReadByIsland(chain, pool);
  if (read) {
    return (
      <p data-held-time="read" className={`${LINE} ${className}`} style={TONE}>
        {READ}
      </p>
    );
  }
  return (
    <div data-held-time="unread" className={`min-w-0 ${className}`}>
      <p className={LINE} style={TONE}>{UNREAD_SHORT}</p>
      <FinePrint summary="Held time">
        <p className="m-0">{UNREAD}</p>
      </FinePrint>
    </div>
  );
}
