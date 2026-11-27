import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { bungalowLpDoor, type Bungalow } from '../../lib/bungalows';
import { formatCompactTokens } from '../../lib/bungalowBurn';
import { fetchBaylaFlip, flipPercent, flipShare, type BaylaFlip } from '../../lib/venueTvl';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';
import { HAIR, LEDGER_BG } from './ledger';

/** The one room with the bar: the pump.fun pool it measures against is hers (api/_lib/venueTvl.js PUMP_BAYLA_POOL). */
export const LIBERATION_ROOM = 'bayla';
const PUMP_POOL_URL = 'https://solscan.io/account/8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n';
const AMBER = '#f0b26b';

type Read = { state: 'loading' } | { state: 'unread' } | { state: 'read'; flip: BaylaFlip };

/** A count of whole BAYLA, short and rounded down: 20.44M. */
const short = (n: number) => formatCompactTokens(BigInt(n), 0);

/**
 * BAYLA's liberation bar (owner, 2026-11-26: "a health bar ... that fills as we move to flipping the
 * pump fun pool for Bayla"). It fills with the BAYLA in our pools, against the BAYLA in her graduated
 * pump.fun pool, and is full the day ours holds more. Read once on arrival, from the venue's own
 * count (lib/venueTvl.ts); a side that could not be read shows no bar at all, never an empty one.
 */
export function BaylaLiberation({ bungalow }: { bungalow: Bungalow }) {
  const [read, setRead] = useState<Read>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    void fetchBaylaFlip().then((flip) => {
      if (live) setRead(flip ? { state: 'read', flip } : { state: 'unread' });
    });
    return () => {
      live = false;
    };
  }, []);
  const { symbol } = bungalow;
  const door = bungalowLpDoor(bungalow);

  return (
    <section
      className="relative isolate rounded-2xl p-6"
      style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
      aria-label={`${symbol} liberation`}
      data-testid="bayla-liberation"
    >
      <CardArt pageId="bayla-liberation" idx={0} />
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <h2 className="heading-luxury text-xl text-white">Liberation</h2>
        <span className="text-[11px] text-white/45">{symbol} vs pump.fun</span>
      </div>

      {read.state === 'read' ? (
        <Bar flip={read.flip} symbol={symbol} />
      ) : read.state === 'loading' ? (
        <p className="text-[12px] text-white/55">Reading the pools…</p>
      ) : (
        <p role="status" className="text-[12px]" style={{ color: AMBER }}>
          The pools could not be read. An outage, not a zero.
        </p>
      )}

      {door && (
        <p className="text-[11px] text-white/60 mt-3">
          <Link to={door.to} className="underline underline-offset-2 text-white/80 hover:text-white" data-testid="bayla-liberation-add">
            {door.label}
          </Link>
        </p>
      )}

      {/* How it is counted, one press away (owner, 2026-10-13). */}
      <FinePrint summary="How it's counted" className="mt-1">
        <p>
          The bar fills with every {symbol} in our pools, against any coin, and measures it against the {symbol} in her
          graduated pump.fun pool on PumpSwap, the deepest of her pools outside this venue. It is full the day ours hold
          more: the flip. Counted in {symbol}, not dollars: at one price a pool is worth twice its {symbol}, so the bar is
          the depth of ours against theirs, and no price can move it. Read from Solana, at most a minute old.{' '}
          <a
            href={PUMP_POOL_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="The pump.fun pool on Solscan (opens in new tab)"
            className="underline underline-offset-2"
          >
            The pump.fun pool on Solscan{' '}↗
          </a>
        </p>
      </FinePrint>
    </section>
  );
}

function Bar({ flip, symbol }: { flip: BaylaFlip; symbol: string }) {
  const flipped = flip.ours >= flip.pump;
  const pct = flipPercent(flip);
  const width = flipShare(flip) * 100;
  return (
    <div className="overflow-hidden rounded-[14px]" style={{ background: LEDGER_BG, border: `1px solid ${HAIR}` }}>
      <div className="px-4 py-4 sm:px-5">
        <p className="m-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="text-white font-semibold tabular-nums leading-none text-[30px] sm:text-[36px]" data-testid="bayla-liberation-figure">
            {flipped ? 'Liberated' : pct}
          </span>
          {!flipped && <span className="text-[11px] uppercase tracking-[0.12em] text-white/60">of the way</span>}
        </p>
        {/* The health bar: ours fills it, what is left is pump.fun's lead. */}
        <div
          role="progressbar"
          aria-label={`${symbol} liberation`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(width)}
          aria-valuetext={flipped ? 'Liberated' : `${pct} of the way`}
          className="mt-3 h-4 overflow-hidden rounded-full"
          style={{ background: 'rgba(255,255,255,0.08)', border: `1px solid ${HAIR}` }}
          data-testid="bayla-liberation-bar"
        >
          <div
            className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-700"
            style={{
              width: `${width}%`,
              minWidth: flip.ours > 0 ? 6 : 0,
              // The gradient spans the whole track, so the fill's colour says how far it has come:
              // red while pump.fun holds most of her, green at the flip.
              background: 'linear-gradient(90deg, #ff6b4a, #f0b26b 45%, #4caf50)',
              backgroundSize: `${10_000 / Math.max(width, 1)}% 100%`,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35), 0 0 12px rgba(76,175,80,0.35)',
            }}
          />
        </div>
        <p className="m-0 mt-2 text-[13px] text-white/85 tabular-nums" data-testid="bayla-liberation-line">
          {short(flip.ours)} {symbol} in our pools · {short(flip.pump)} in pump.fun&apos;s
        </p>
      </div>
    </div>
  );
}
