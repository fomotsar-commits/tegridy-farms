import { useContext, useId, useLayoutEffect, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { BUNGALOWS } from '../../../lib/bungalows';
import { CardArt } from '../../ui/CardArt';
import { CARD, CARD_STYLE, SHADOW } from '../curve/uiFormat';
import { InDoorContext, LpDoorContext } from './lpDoor';

/**
 * Where the LP door lands (island, answer twenty-two): a room's Add SOL + coin opens its form
 * here, at the top of /pools, above the finder and every pool, and nothing scrolls. Until the
 * form, or why it did not open, is drawn in the slot, it says the pool is being read.
 * PoolsPage draws it before the LP section's chunk loads, so nothing here imports the wallet stack.
 */
export function LpDoorFrame({ mint, waiting, slotRef }: { mint: string; waiting: boolean; slotRef?: Ref<HTMLDivElement> }) {
  const id = useId();
  const room = BUNGALOWS.find((b) => b.chain === 'solana' && b.address === mint);
  return (
    <section
      data-testid="lp-door"
      aria-labelledby={room ? id : undefined}
      aria-label={room ? undefined : 'Add liquidity'}
      className={`${CARD} isolate mb-6`}
      style={CARD_STYLE}
    >
      <CardArt pageId="solana-lp" idx={7} />
      {room && (
        <h2 id={id} className="text-white font-semibold text-[15px] mb-1" style={SHADOW}>
          {room.name}
        </h2>
      )}
      {waiting && (
        <p role="status" className="text-white/70 text-[13px]">
          Reading this pool from the chain…
        </p>
      )}
      <div ref={slotRef} />
    </section>
  );
}

/** Draws its children in the door's slot when `when` holds, and holds the door open while it does. */
export function DoorPortal({ when = true, children }: { when?: boolean; children: ReactNode }) {
  const door = useContext(LpDoorContext);
  const hold = when ? door?.hold : undefined;
  useLayoutEffect(() => hold?.(), [hold]);
  if (!when || !door) return <>{children}</>;
  if (!door.slot) return null;
  return createPortal(<InDoorContext.Provider value>{children}</InDoorContext.Provider>, door.slot);
}
