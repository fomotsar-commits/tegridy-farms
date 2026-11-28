// The Liquidity Room: one range pool as a place you can look around. A PROTOTYPE, shown only
// with `?room=1` on /range-pools, and it only looks: it sends nothing and changes no form.
//
// Left to right is price. The hills are the liquidity in use at each price, as far as the
// bands read reach. The green sheet is the pool's price. Each spark is one real swap from the
// pool's last page of transactions; at the price it splits the way that fee tier splits a fee
// today, part into the hills (the positions in range) and part up to the venue's mark.
//
// Every figure is a chain read with its own unread state. A read that failed says so and
// draws no hills: an empty floor here always means the chain said "nothing".
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { EDITORIAL_BG, EDITORIAL_GREEN, EDITORIAL_INK } from '../../../lib/editorial';
import type { DepthProfile } from '../../../lib/solana/clmm/depthProfile';
import { feeSplit, poolFeeCeiling } from '../../../lib/solana/clmm/feeText';
import type { PoolStateView } from '../../../lib/solana/clmm/program';
import { priceAtSqrt } from '../../../lib/solana/clmm/rangeMath';
import type { RangePool, Read, WalletPosition } from '../../../lib/solana/clmm/read';
import { roomLayout, roomSparks } from '../../../lib/solana/clmm/roomLayout';
import type { RoomReaders } from '../../../lib/solana/clmm/roomRead';
import type { RoomSwapsRead } from '../../../lib/solana/clmm/roomSwaps';
import { pausedText } from '../../../lib/solana/lp/rpcBudget';
import { priceText, tokenWord, type NamedPair } from '../range/rangeText';
import type { RoomScene } from './roomScene';

/** How often the pool's price is read again while the room is on screen. */
const READ_EVERY_MS = 20_000;

type Engine = { kind: 'starting' } | { kind: 'ready'; scene: RoomScene } | { kind: 'failed' };

interface RoomData {
  pool: PoolStateView;
  depth: Read<DepthProfile | null> | null;
  swaps: RoomSwapsRead | null;
}

/** The pool's price, depth and swaps: read once, then again whenever the pool's own account has moved. */
function useRoomData(readers: RoomReaders, first: PoolStateView, pair: NamedPair, live: boolean): RoomData {
  const [data, setData] = useState<RoomData>({ pool: first, depth: null, swaps: null });
  const pairRef = useRef(pair);
  // The pool as last read, and the newest read asked for: an older answer never lands over a newer one.
  const poolRef = useRef(first);
  const asked = useRef(0);
  useEffect(() => {
    pairRef.current = pair;
  });
  const readAll = useRef(async (p: PoolStateView) => {
    const mine = ++asked.current;
    const [depth, swaps] = await Promise.all([readers.depth(p), readers.swaps(p, pairRef.current)]);
    if (mine === asked.current) setData({ pool: p, depth, swaps });
  });
  // Once per pool (the room is keyed by its pool's address), whether or not it is on screen yet.
  useEffect(() => {
    const read = readAll.current;
    const count = asked;
    void read(poolRef.current);
    return () => {
      // Leaving: whatever is still in flight answers nobody.
      count.current++;
    };
  }, []);
  // The price again every 20 seconds, only while the room is on screen; the rest only when the pool moved.
  useEffect(() => {
    if (!live) return;
    let on = true;
    const timer = setInterval(async () => {
      const again = await readers.poolNow(poolRef.current.address);
      if (!on || again.kind !== 'ok') return;
      const next = again.value;
      const was = poolRef.current;
      // Any swap, deposit or withdrawal moves one of these three.
      if (next.sqrtPriceX64 === was.sqrtPriceX64 && next.liquidity === was.liquidity && next.tickCurrent === was.tickCurrent) return;
      poolRef.current = next;
      void readAll.current(next);
    }, READ_EVERY_MS);
    return () => {
      on = false;
      clearInterval(timer);
    };
  }, [readers, live]);
  return data;
}

export default function LiquidityRoom(p: {
  readers: RoomReaders;
  pool: RangePool;
  pair: NamedPair;
  /** The wallet's positions, when a wallet is connected and they read. */
  positions: WalletPosition[] | null;
}) {
  const still = useReducedMotion() === true;
  const box = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const nowMark = useRef<HTMLSpanElement | null>(null);
  const venueMark = useRef<HTMLSpanElement | null>(null);
  const [engine, setEngine] = useState<Engine>({ kind: 'starting' });
  const [onScreen, setOnScreen] = useState(true);
  const [tabShown, setTabShown] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const live = onScreen && tabShown;

  const data = useRoomData(p.readers, p.pool.pool, p.pair, live && !still);
  const pool = data.pool;
  const address = pool.address;

  // The engine: fetched and started once per pool, torn down when the room leaves.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let made: RoomScene | null = null;
    let gone = false;
    // A label follows its mark but stays whole inside the room: on a phone the price is wider than the space beside it.
    const place = (mark: HTMLSpanElement | null, at: { x: number; y: number }) => {
      if (!mark) return;
      const label = mark.firstElementChild as HTMLElement | null;
      const half = (label?.offsetWidth ?? 0) / 2 + 8;
      const width = box.current?.clientWidth ?? 0;
      const x = width > half * 2 ? Math.max(half, Math.min(width - half, at.x)) : at.x;
      const y = Math.max((label?.offsetHeight ?? 0) + 4, at.y);
      mark.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    import('./roomScene')
      .then((mod) => mod.createRoomScene(el, { still, onFrame: (marks) => (place(nowMark.current, marks.now), place(venueMark.current, marks.venue)) }))
      .then((scene) => {
        if (gone) return scene.dispose();
        made = scene;
        setEngine({ kind: 'ready', scene });
      })
      .catch(() => !gone && setEngine({ kind: 'failed' }));
    return () => {
      gone = true;
      made?.dispose();
      setEngine({ kind: 'starting' });
    };
  }, [address, still]);

  const scene = engine.kind === 'ready' ? engine.scene : null;

  // Size: the canvas is as large as its box, redrawn at the screen's own pixel density.
  useEffect(() => {
    const el = box.current;
    if (!scene || !el) return;
    const fit = () => scene.resize(el.clientWidth, el.clientHeight, window.devicePixelRatio || 1);
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [scene]);

  // Nothing is drawn while the room is scrolled away or the tab is in the background.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const watch = new IntersectionObserver(([entry]) => entry && setOnScreen(entry.isIntersecting));
    watch.observe(el);
    const tab = () => setTabShown(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', tab);
    return () => {
      watch.disconnect();
      document.removeEventListener('visibilitychange', tab);
    };
  }, []);
  useEffect(() => {
    scene?.setRunning(live);
  }, [scene, live]);

  const profile = data.depth?.kind === 'ok' ? data.depth.value : null;
  const mine = useMemo(
    () => (p.positions ?? []).filter((w) => w.pool.address === address && w.position.liquidity > 0n).map((w) => ({ lower: w.position.tickLowerIndex, upper: w.position.tickUpperIndex })),
    [p.positions, address],
  );
  const layout = useMemo(() => (profile ? roomLayout(profile, pool.tickCurrent, mine, !p.pair.tokenIsToken0) : null), [profile, pool.tickCurrent, mine, p.pair.tokenIsToken0]);
  const swaps = data.swaps?.kind === 'ok' ? data.swaps.swaps : null;
  const sparks = useMemo(() => (swaps ? roomSparks(swaps) : []), [swaps]);
  const venueShare = (p.pool.config.protocolFeeRate + p.pool.config.fundFeeRate) / 1_000_000;

  useEffect(() => {
    if (scene && layout) scene.set({ layout, sparks, venueShare });
  }, [scene, layout, sparks, venueShare]);

  // Drag sideways to look around. Up and down still scrolls the page (touch-action: pan-y).
  const drag = useRef<{ id: number; x: number } | null>(null);

  const token = tokenWord(p.pair);
  const coin = p.pair.quote.symbol;
  const price = priceText(p.pair, priceAtSqrt(p.pair, pool.sqrtPriceX64));
  const split = feeSplit(p.pool.config, poolFeeCeiling(pool, p.pool.config.tradeFeeRate));
  const looked = data.swaps?.kind === 'ok' ? `the pool’s last ${data.swaps.looked === 1 ? 'transaction' : `${data.swaps.looked} transactions`}` : '';
  const swapLine =
    data.swaps === null
      ? 'Reading its swaps…'
      : data.swaps.kind === 'paused'
        ? pausedText('Swap reads')
        : data.swaps.kind === 'unread'
          ? 'Its swaps could not be read just now.'
          : data.swaps.swaps.length === 0
            ? data.swaps.looked === 0
              ? 'This pool has no transactions yet.'
              : `No swaps in ${looked}.`
            : `${data.swaps.swaps.length} ${data.swaps.swaps.length === 1 ? 'swap' : 'swaps'} in ${looked}${still ? '.' : ', replayed.'}`;
  const depthLine =
    data.depth === null
      ? 'Reading its depth…'
      : data.depth.kind === 'unread'
        ? 'This pool’s depth could not be read just now. This does not mean it is empty.'
        : profile === null
          ? 'Nobody has a position in this pool yet.'
          : 'Hills: the liquidity in use at each price, as far as was read.';
  const drawn = engine.kind !== 'failed' && layout !== null;
  const spoken = `${token} with ${coin}. The pool’s price is ${price}. ${depthLine} ${swapLine}`;

  return (
    <section data-testid="liquidity-room" data-engine={scene?.engine ?? engine.kind} className="rounded-lg border border-white/[0.14] overflow-hidden" style={{ background: EDITORIAL_BG }}>
      <header className="flex items-baseline justify-between gap-3 px-4 pt-3 font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: EDITORIAL_INK }}>
        <span>
          The room · {token} / {coin}
        </span>
        <span className="opacity-55">prototype · look only</span>
      </header>

      <div
        ref={box}
        className="relative h-[280px] sm:h-[400px] select-none"
        style={{ touchAction: 'pan-y', cursor: drawn ? 'grab' : 'default' }}
        onPointerDown={(e) => {
          drag.current = { id: e.pointerId, x: e.clientX };
        }}
        onPointerMove={(e) => {
          if (!drag.current || drag.current.id !== e.pointerId) return;
          scene?.turn(e.clientX - drag.current.x);
          drag.current.x = e.clientX;
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
      >
        <canvas ref={canvas} role="img" aria-label={spoken} className="absolute inset-0 block h-full w-full" style={{ opacity: drawn ? 1 : 0 }} />
        {drawn && scene && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 font-mono text-[10px] uppercase tracking-[0.14em]">
            <span ref={nowMark} data-testid="room-mark-now" className="absolute left-0 top-0 whitespace-nowrap" style={{ color: EDITORIAL_GREEN }}>
              <span className="block -translate-x-1/2 -translate-y-full pb-1 text-center">
                price now
                <span className="block normal-case tracking-normal text-[11px]">{price}</span>
              </span>
            </span>
            <span ref={venueMark} data-testid="room-mark-venue" className="absolute left-0 top-0 whitespace-nowrap" style={{ color: EDITORIAL_INK }}>
              <span className="block -translate-x-1/2 -translate-y-[calc(100%+14px)]">venue</span>
            </span>
          </div>
        )}
        {!drawn && (
          <p data-testid="room-note" className="absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-white/75">
            {engine.kind === 'failed' ? 'This device cannot draw the room. The range picker below shows the same pool.' : data.depth === null || engine.kind === 'starting' ? 'Opening the room…' : depthLine}
          </p>
        )}
      </div>

      <footer className="space-y-1 px-4 pb-3 font-mono text-[10px] leading-relaxed tracking-[0.04em] text-[#f5e4b8]/70">
        <p data-testid="room-depth">{depthLine}</p>
        <p data-testid="room-swaps">{swapLine}</p>
        <p>
          <span style={{ color: EDITORIAL_GREEN }}>●</span> {split.lpOfFee} of each fee goes to the positions in range. <span style={{ color: EDITORIAL_INK }}>●</span> {split.venueOfFee} goes to the venue. Each swap pays {split.fee}.
        </p>
        {mine.length > 0 && <p>The outlined slab is your position.</p>}
        {drawn && <p className="opacity-70">Drag sideways to look around.</p>}
      </footer>
    </section>
  );
}
