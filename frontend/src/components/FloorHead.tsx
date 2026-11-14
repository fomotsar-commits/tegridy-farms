import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { reducedMotion } from '../lib/heat/ticks';
import { tick } from '../lib/tick';
import { hueOf, startFloorMoment, type FloorMoment, type FloorState } from '../lib/floorMoment';
/**
 * THE FLASH's head on the receipt card (island answer thirty-two, the owner's word 11-07): after an
 * add of liquidity, any token, the card's head is the pool itself, seen from just under its surface,
 * and the seconds after the signature play in it (lib/floorMoment.ts: the pour, the bubble, the
 * flash, the brick of light sinking to the floor of every LP's bricks). The 56 px ring sits on the
 * head's bottom edge: a drop of water while the card rises, and from the flash on the pool's light,
 * in the token's own hue (`data-floor="lit"`, set by the engine). Never a flame. The screen-wide fx
 * canvas (the pour from above the card, the flash spilling past it) is portaled to the body above
 * the receipt layer: a fixed canvas inside the card would ride the card's transform.
 *
 * The moment plays once per card. A later LP count (the pool's holders are two RPC calls, often
 * after the card is up) lands through `setLps`, never a restart; new callbacks never restart it either.
 */
export function FloorHead({
  state,
  wallet,
  symbol,
  pairing,
  lps,
  onFlash,
  onLanded,
  onBeat,
}: {
  state: FloorState;
  wallet: string;
  symbol: string;
  /** The pool's pairing coin by its ticker (the receipt's own): the pour's other stream is its color. Absent: SOL. */
  pairing?: string | null;
  /** How many wallets hold a share of the pool (lib/solana/lp/holders.ts), null until read. */
  lps: number | null;
  onFlash?: () => void;
  onLanded?: () => void;
  onBeat?: (n: number) => void;
}) {
  const head = useRef<HTMLCanvasElement>(null);
  const fx = useRef<HTMLCanvasElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const moment = useRef<FloorMoment | null>(null);
  // The newest callbacks and count, read by the running moment: these two effects come first so they are current when it starts.
  const latest = useRef({ onFlash, onLanded, onBeat });
  useEffect(() => {
    latest.current = { onFlash, onLanded, onBeat };
  });
  const count = useRef(lps);
  useEffect(() => {
    count.current = lps;
    moment.current?.setLps(lps);
  }, [lps]);
  const hue = hueOf(symbol);
  useEffect(() => {
    if (!head.current || !fx.current || !ring.current) return;
    const m = startFloorMoment({
      head: head.current,
      fx: fx.current,
      ring: ring.current,
      state,
      wallet,
      symbol,
      pairing: pairing ?? null,
      lps: count.current,
      reduced: reducedMotion(),
      onTick: () => tick(),
      onFlash: () => latest.current.onFlash?.(),
      onLanded: () => latest.current.onLanded?.(),
      onBeat: (n) => latest.current.onBeat?.(n),
    });
    moment.current = m;
    return () => {
      m.stop();
      moment.current = null;
    };
  }, [state, wallet, symbol, pairing]);
  return (
    <>
      <div
        className="receipt-floor"
        data-testid="floor-head"
        style={{ ['--floor-hue' as string]: hue.rgb.join(','), ['--floor-hue-mid' as string]: hue.mid.join(',') }}
      >
        <canvas ref={head} aria-hidden="true" data-testid="floor-canvas" />
        <div ref={ring} aria-hidden="true" className="floor-ring" data-testid="floor-ring">
          <span className="floor-drop" />
          <span className="floor-orb" />
        </div>
      </div>
      {createPortal(<canvas ref={fx} aria-hidden="true" className="receipt-floor-fx" data-testid="floor-fx" />, document.body)}
    </>
  );
}

