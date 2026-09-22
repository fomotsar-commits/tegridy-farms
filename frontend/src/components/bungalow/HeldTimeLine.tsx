import { poolReadByIsland, type Bungalow } from '../../lib/bungalows';

const READ = 'Staking keeps your held time.';
const UNREAD =
  'Heat reads wallets today. A bag locked here is not counted until the island reads this pool. Your clock is not reset.';

/**
 * One line under a staking card's headline figures: whether the island counts a bag
 * locked in this pool as held. The registry decides (poolReadByIsland); a card only
 * passes its chain and pool. A plain paragraph: no role, no modal, no alarm colour.
 */
export function HeldTimeLine({ chain, pool, className = '' }: {
  chain: Bungalow['chain'];
  pool: string | undefined;
  className?: string;
}) {
  const read = poolReadByIsland(chain, pool);
  return (
    <p
      data-held-time={read ? 'read' : 'unread'}
      className={`m-0 text-[12px] leading-relaxed ${className}`}
      style={{ color: 'rgba(255,255,255,0.72)' }}
    >
      {read ? READ : UNREAD}
    </p>
  );
}
