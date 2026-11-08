import { useEffect, useEffectEvent, useRef } from 'react';
import { createPortal } from 'react-dom';
import { startShoreMoment } from '../lib/shoreMoment';
import { reducedMotion } from '../lib/heat/ticks';
import { tick } from '../lib/tick';

/**
 * The receipt card's head (island answer thirty, the owner's word of 11-07, replacing twenty-nine's
 * flame): the coin's shore at night across the card's top, the 56 px ring on its bottom edge. The
 * moment the card is up, the strike in the ring throws sparks, the fire roars past the card and
 * settles back into the ring, one light flies onto the shore and every light there takes its beat.
 * A sale never strikes: the wallet's light stays on the shore, cooling. The engine is the island's
 * own file (lib/shoreMoment.ts); this component hands it two canvases and the ring. The fire's
 * canvas lives on the body: a fixed canvas inside the card would ride the card's rise.
 */
export type FlameState =
  /** The card rising, or a sale: the ember in the ring. A sale draws its light on the shore, cooling. */
  | 'ember'
  /** A buy or an add, the card up: the moment plays, once. */
  | 'catching'
  /** Played already for this signature (Bayla's Receipt raising the same card): at rest at once. */
  | 'lit';

export function FlameCatch({
  state,
  waiting = false,
  wallet,
  holders,
  onLanded,
  onBeat,
}: {
  state: FlameState;
  /** The card is still rising: nothing is drawn or struck until it is up. */
  waiting?: boolean;
  wallet: string;
  holders: number | null;
  onLanded?: () => void;
  onBeat?: (n: number) => void;
}) {
  const shore = useRef<HTMLCanvasElement>(null);
  const fx = useRef<HTMLCanvasElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  // The card re-renders on every beat: the engine keeps running, and calls the card's latest.
  const landed = useEffectEvent(() => onLanded?.());
  const beat = useEffectEvent((n: number) => onBeat?.(n));
  useEffect(() => {
    if (waiting || !shore.current || !fx.current || !ring.current) return;
    return startShoreMoment({
      shore: shore.current,
      fx: fx.current,
      ring: ring.current,
      state,
      wallet,
      holders,
      reduced: reducedMotion(),
      onTick: tick,
      onLanded: () => landed(),
      onBeat: (n) => beat(n),
    });
  }, [state, waiting, wallet, holders]);

  return (
    <>
      <div aria-hidden="true" className="receipt-head">
        <canvas ref={shore} className="receipt-shore" />
        <div ref={ring} className="flame-ring" data-testid="flame-ring" data-flame={state}>
          <span className="flame-ember" />
          <span className="flame-css" />
        </div>
      </div>
      {createPortal(<canvas ref={fx} aria-hidden="true" className="receipt-fx" />, document.body)}
    </>
  );
}
