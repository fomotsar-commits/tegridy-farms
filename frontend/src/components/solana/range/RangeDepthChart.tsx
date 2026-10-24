import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { EDITORIAL_INK } from '../../../lib/editorial';
import { liquidityAt, moveCost, runAmounts, walkDepth, type BandsWindow, type Depth, type DepthGap, type MoveCost, type RestingOrder } from '../../../lib/solana/clmm/depth';
import type { Read, RangePool } from '../../../lib/solana/clmm/read';
import { priceAtSqrt, priceNumber, type Pair, type TickRange } from '../../../lib/solana/clmm/rangeMath';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { usableTickBounds } from '../../../lib/solana/clmm/math';
import { CardArt } from '../../ui/CardArt';
import { FinePrint } from '../../ui/FinePrint';
import { Card, Notice } from '../curve/ui';
import { chipCls } from './editorialUi';
import { coinAmount, tokenAmount } from './rangeText';
import {
  axisSign,
  fitLiquidity,
  fitRange,
  moveEdge,
  orderSellsToken,
  orderWords,
  priceWords,
  roughAmount,
  spanPrices,
  stampWords,
  stepWords,
  summaryWords,
  tickOfPrice,
  tickOfSqrt,
  toU,
  tokenUnit,
  unitText,
  type View,
} from './depthView';

const GREEN = '#22c55e';
const TOP = 16;

/**
 * Card 03, Liquidity: where the pool's money sits, by price, walked from the chain
 * (clmm/depth.ts), with resting orders, this pool's and the market's price, your range and
 * your positions. From 768px the range's two edges are handles; under it the chart takes
 * no drag (the page scrolls) and two sliders with one-step buttons sit under it.
 */
export function RangeDepthChart(p: {
  pool: RangePool;
  pair: Pair;
  read: Read<BandsWindow> | null;
  onReadAgain: () => void;
  range: TickRange | null;
  onRange: (r: TickRange) => void;
  onStart: () => void;
  /** A deposit is under review or on its way: the range stays put. */
  locked: boolean;
  /** The market's price, coin per token, when it was read. */
  market: number | null;
  positions: TickRange[];
}) {
  return (
    <Card title="Liquidity" testId="range-depth" index={3} art={<CardArt pageId="range-pools" idx={4} />}>
      <p className="text-white/85">Where the pool’s money sits, by price. Your range is the green band.</p>
      {p.read === null ? (
        <p className="text-white/70">Reading the pool…</p>
      ) : p.read.kind === 'unread' ? (
        <div className="space-y-2" data-testid="range-depth-unread">
          <Notice tone="warn">{`The pool’s liquidity could not be read just now (${p.read.detail}). This does not mean it is empty.`}</Notice>
          <button type="button" className="btn-secondary min-h-[44px] px-4 text-[12px]" onClick={p.onReadAgain}>
            Read again
          </button>
        </div>
      ) : (
        <DepthBody {...p} w={p.read.value} />
      )}
    </Card>
  );
}

type BodyProps = Omit<Parameters<typeof RangeDepthChart>[0], 'read'> & { w: BandsWindow };

function DepthBody(p: BodyProps) {
  const depth = useMemo(() => walkDepth(p.w), [p.w]);
  if (depth.empty) return <Notice>Nothing is in this pool yet.</Notice>;
  return <Chart {...p} depth={depth} />;
}

/** A tick span `[from, to)`, as the view keeps it whichever way the price is shown. */
interface Span {
  from: number;
  to: number;
}
const spanOf = (v: View, sign: 1 | -1): Span => (sign > 0 ? { from: v.lo, to: v.hi } : { from: -v.hi, to: -v.lo });

function Chart(p: BodyProps & { depth: Depth }) {
  const { pair, w, depth, range } = p;
  const s = depth.spacing;
  const [flipped, setFlipped] = useState(false);
  const sign = axisSign(pair, flipped);
  const [span, setSpan] = useState<Span>(() => spanOf(range ? fitRange(range, w.pool.tickCurrent, s, sign) : fitLiquidity(depth, w.pool, sign), sign));
  const view = toU(sign, span.from, span.to);
  const [showMine, setShowMine] = useState(true);
  const [table, setTable] = useState(false);
  const [inspect, setInspect] = useState<number | null>(null);
  const [dragging, setDragging] = useState<'lo' | 'hi' | null>(null);

  // A range picked in card 04 that lies outside the view brings the view to it; one moved here does not.
  const rangeKey = range ? `${range.tickLower}:${range.tickUpper}` : '';
  const [seen, setSeen] = useState(rangeKey);
  const [mine, setMine] = useState('');
  const [fitNext, setFitNext] = useState(false);
  if (seen !== rangeKey) {
    setSeen(rangeKey);
    const outside = range && (range.tickLower < span.from || range.tickUpper > span.to);
    if (range && rangeKey !== mine && (outside || fitNext)) setSpan(spanOf(fitRange(range, w.pool.tickCurrent, s, sign), sign));
    if (range && fitNext) setFitNext(false);
  }
  const setRange = (r: TickRange) => {
    setMine(`${r.tickLower}:${r.tickUpper}`);
    p.onRange(r);
  };

  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 343, h: 180 });
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (width > 0 && height > 0) setSize((o) => (o.w === width && o.h === height ? o : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const W = size.w;
  const H = size.h;
  const plotH = H - TOP - 2;
  const width = view.hi - view.lo;
  const x = (u: number) => ((u - view.lo) / width) * W;
  const uAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const wpx = rect && rect.width > 0 ? rect.width : W;
    return view.lo + ((clientX - left) / wpx) * width;
  };

  const runsInView = depth.runs.map((r) => ({ r, u: toU(sign, r.from, r.to) })).filter(({ u }) => u.hi > view.lo && u.lo < view.hi);
  const maxL = runsInView.reduce((m, { r }) => (r.liquidity > m ? r.liquidity : m), 0n);
  const stepPx = (s / width) * W;
  const bars: { x: number; w: number; h: number; key: string }[] = [];
  for (const { r, u } of runsInView) {
    if (r.liquidity <= 0n || maxL === 0n) continue;
    const h = Math.max(1, (Number(r.liquidity) / Number(maxL)) * plotH);
    const a = Math.max(u.lo, view.lo);
    const b = Math.min(u.hi, view.hi);
    if (stepPx >= 4) {
      for (let k = Math.floor(a / s); k * s < b; k++) {
        const from = Math.max(k * s, a);
        const to = Math.min((k + 1) * s, b);
        if (to > from) bars.push({ x: x(from) + 0.5, w: Math.max(0.5, x(to) - x(from) - 1), h, key: `${k}` });
      }
    } else {
      bars.push({ x: x(a), w: Math.max(0.5, x(b) - x(a)), h, key: `${r.from}` });
    }
  }
  const gapsInView = depth.gaps.map((g) => ({ g, u: toU(sign, g.from, g.to) })).filter(({ u }) => u.hi > view.lo && u.lo < view.hi);
  const hatch = `depth-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const nowU = sign * tickOfSqrt(w.pool.sqrtPriceX64);
  const marketTick = p.market === null ? null : tickOfPrice(pair, p.market);
  const marketU = marketTick === null ? null : sign * marketTick;
  const edges = range ? toU(sign, range.tickLower, range.tickUpper) : null;
  const ordersInView = depth.orders.filter((o) => sign * o.tick >= view.lo && sign * o.tick <= view.hi);

  const nowNumber = priceNumber(priceAtSqrt(pair, w.pool.sqrtPriceX64));
  const nowWords = formatSolPrice(flipped ? 1 / nowNumber : nowNumber);
  const summary = summaryWords({ pair, flipped, depth, pool: w.pool, range, nowWords });
  const unit = unitText(pair, flipped);

  const stepAt = (clientX: number) => Math.floor((sign * uAt(clientX)) / s) * s;
  const inspected = inspect === null ? null : stepWords(pair, flipped, inspect, inspect + s, liquidityAt(depth, inspect), depth.orders.filter((o) => o.tick >= inspect && o.tick < inspect + s));
  const inspectU = inspect === null ? null : toU(sign, inspect, inspect + s);

  const move = (which: 'lo' | 'hi', u: number) => {
    if (!range || p.locked) return;
    const next = moveEdge(range, which, u, s, sign);
    if (next.tickLower !== range.tickLower || next.tickUpper !== range.tickUpper) setRange(next);
  };
  const keyMove = (which: 'lo' | 'hi') => (e: KeyboardEvent) => {
    if (!edges) return;
    const step = (e.shiftKey ? 10 : 1) * s;
    const by: Record<string, number> = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -10 * s, PageUp: 10 * s };
    if (!(e.key in by)) return;
    e.preventDefault();
    move(which, (which === 'lo' ? edges.lo : edges.hi) + by[e.key]!);
  };
  const drag = (which: 'lo' | 'hi') => ({
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (p.locked) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDragging(which);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dragging === which) move(which, uAt(e.clientX));
    },
    onPointerUp: () => setDragging(null),
    onPointerCancel: () => setDragging(null),
  });

  // 2% on the price as shown: when it is shown upside down, that is 1/1.02 on the pool's own.
  const config = p.pool.config;
  const costs = useMemo(() => {
    const up = sign > 0 ? { num: 102n, den: 100n } : { num: 100n, den: 102n };
    const down = sign > 0 ? { num: 98n, den: 100n } : { num: 100n, den: 98n };
    return [moveCost(w, config, up), moveCost(w, config, down)] as const;
  }, [w, config, sign]);
  const costWords = (c: MoveCost) => {
    if (c.kind === 'ok') {
      const isToken = c.inIsToken0 === pair.tokenIsToken0;
      return `${roughAmount(c.amountIn, isToken ? pair.tokenDecimals : pair.quoteDecimals)} ${isToken ? tokenUnit(pair) : pair.quote.symbol} in`;
    }
    if (c.kind === 'free') return 'next to nothing in, as no liquidity is in use there';
    if (c.kind === 'none-that-way') return 'no swap can, as nothing is in use that way';
    if (c.kind === 'unread') return `could not be worked out (${c.detail})`;
    return '';
  };
  const moveLine =
    costs[0].kind === 'paused'
      ? 'Swaps are switched off in this pool, so no swap moves its price.'
      : costs[0].kind === 'not-open'
        ? 'This pool does not take swaps yet.'
        : `Moves the price 2% up: ${costWords(costs[0])}. 2% down: ${costWords(costs[1])}.`;

  const fitMine = () => range && setSpan(spanOf(fitRange(range, w.pool.tickCurrent, s, sign), sign));
  const fitAll = () => setSpan(spanOf(fitLiquidity(depth, w.pool, sign), sign));
  const zoom = (by: number) =>
    setSpan((o) => {
      const { min, max } = usableTickBounds(s);
      const mid = (o.from + o.to) / 2;
      const half = Math.max(((o.to - o.from) / 2) * by, 4 * s);
      return { from: Math.max(min, mid - half), to: Math.min(max, mid + half) };
    });
  // A part not known that lies off the view is named at that edge, so the view never reads as all there is.
  const offLeft = depth.gaps.filter((g) => toU(sign, g.from, g.to).lo < view.lo);
  const offRight = depth.gaps.filter((g) => toU(sign, g.from, g.to).hi > view.hi);
  const offWords = (gs: DepthGap[]) => (gs.some((g) => g.kind === 'unread') ? 'a band could not be read' : gs.some((g) => g.kind === 'not-known') ? 'not known' : 'not read');
  const [loWords, hiWords] = spanPrices(pair, flipped, span.from, span.to);
  const edgeWords = (u: number) => `${priceWords(pair, flipped, sign * u)} ${unit}`;
  const bandsLine = `${unit} · log scale · ${depth.bandsRead} ${depth.bandsRead === 1 ? 'band' : 'bands'} read ${stampWords(w.at)}${depth.bandsUnread ? ` · ${depth.bandsUnread} could not be read` : ''}`;

  return (
    <div className="space-y-2" data-testid="range-depth-body" data-flipped={flipped ? '1' : '0'}>
      <figure className="!mt-3 !mb-0" data-testid="range-depth-chart">
        <div
          ref={box}
          className="relative h-[180px] md:h-[220px] lg:h-[260px] border-y border-white/[0.14] select-none"
          style={{ background: 'rgba(5,8,15,0.92)', backgroundImage: 'linear-gradient(to right, rgba(245,228,184,0.06) 1px, transparent 1px)', backgroundSize: '10% 100%' }}
        >
          <div
            role="img"
            aria-label={summary}
            data-testid="range-depth-picture"
            className="absolute inset-0"
            onPointerMove={(e) => e.pointerType === 'mouse' && setInspect(stepAt(e.clientX))}
            onPointerLeave={(e) => e.pointerType === 'mouse' && setInspect(null)}
            onClick={(e) => setInspect(stepAt(e.clientX))}
          >
            <svg width={W} height={H} aria-hidden="true" className="absolute inset-0 overflow-visible">
              <defs>
                <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(251,191,36,0.55)" strokeWidth="1.5" />
                </pattern>
              </defs>
              {gapsInView.map(({ g, u }) => (
                <rect
                  key={`g${g.from}`}
                  data-gap={g.kind}
                  x={x(Math.max(u.lo, view.lo))}
                  y={0}
                  width={Math.max(0.5, x(Math.min(u.hi, view.hi)) - x(Math.max(u.lo, view.lo)))}
                  height={H}
                  fill={g.kind === 'unread' ? `url(#${hatch})` : 'rgba(245,228,184,0.05)'}
                />
              ))}
              {bars.map((b) => (
                <rect key={b.key} data-testid="range-depth-bar" x={b.x} y={H - 1 - b.h} width={b.w} height={b.h} fill={EDITORIAL_INK} fillOpacity={0.55} />
              ))}
              {edges && <rect data-testid="range-depth-band" x={x(edges.lo)} y={0} width={Math.max(0, x(edges.hi) - x(edges.lo))} height={H} fill="rgba(34,197,94,0.24)" />}
              {inspectU && <rect x={x(inspectU.lo)} y={TOP - 2} width={Math.max(1, x(inspectU.hi) - x(inspectU.lo))} height={H - TOP + 1} fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.55)" strokeWidth={1} />}
              {showMine &&
                p.positions.map((r) => {
                  const u = toU(sign, r.tickLower, r.tickUpper);
                  return <rect key={`${r.tickLower}:${r.tickUpper}`} data-testid="range-depth-position" x={x(u.lo)} y={TOP + 4} width={Math.max(1, x(u.hi) - x(u.lo))} height={H - TOP - 5} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={1} strokeDasharray="2 2" />;
                })}
              {ordersInView.map((o) => (
                <OrderMark key={o.tick} x={x(sign * o.tick)} sells={orderSellsToken(pair, o)} />
              ))}
              <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} stroke="rgba(245,228,184,0.25)" />
              {edges && (
                <>
                  <line x1={x(edges.lo)} x2={x(edges.lo)} y1={0} y2={H} stroke={GREEN} strokeWidth={1.5} />
                  <line x1={x(edges.hi)} x2={x(edges.hi)} y1={0} y2={H} stroke={GREEN} strokeWidth={1.5} />
                </>
              )}
              {marketU !== null && <line x1={x(marketU)} x2={x(marketU)} y1={0} y2={H} stroke={EDITORIAL_INK} strokeDasharray="3 3" strokeOpacity={0.8} />}
              <line x1={x(nowU)} x2={x(nowU)} y1={0} y2={H} stroke={GREEN} strokeWidth={1} />
            </svg>
            {gapsInView.map(({ g, u }) => (
              <GapLabel key={`l${g.from}`} gap={g} left={x(Math.max(u.lo, view.lo))} right={x(Math.min(u.hi, view.hi))} />
            ))}
            {offLeft.length > 0 && (
              <span data-testid="range-depth-off-left" className="absolute left-1 bottom-1 font-mono text-[10px] px-1 bg-black/80 text-amber-200/90">{`← ${offWords(offLeft)}`}</span>
            )}
            {offRight.length > 0 && (
              <span data-testid="range-depth-off-right" className="absolute right-1 bottom-1 font-mono text-[10px] px-1 bg-black/80 text-amber-200/90">{`${offWords(offRight)} →`}</span>
            )}
            <LineLabel at={(x(nowU) / W) * 100} color={GREEN} text="this pool" row={0} />
            {marketU !== null && <LineLabel at={(x(marketU) / W) * 100} color={EDITORIAL_INK} text="market (Jupiter)" row={1} />}
          </div>
          {edges &&
            (['lo', 'hi'] as const).map((which) => {
              const u = which === 'lo' ? edges.lo : edges.hi;
              const left = x(u);
              if (left < -22 || left > W + 22) return null;
              return (
                <div
                  key={which}
                  role="slider"
                  tabIndex={0}
                  data-testid={`range-depth-handle-${which}`}
                  aria-label={which === 'lo' ? 'Lowest price of your range' : 'Highest price of your range'}
                  aria-valuemin={Math.round(view.lo)}
                  aria-valuemax={Math.round(view.hi)}
                  aria-valuenow={u}
                  aria-valuetext={edgeWords(u)}
                  aria-disabled={p.locked || undefined}
                  className="hidden md:block absolute top-0 bottom-0 w-11 -ml-[22px] cursor-ew-resize outline-none group"
                  style={{ left, touchAction: 'none' }}
                  onKeyDown={keyMove(which)}
                  {...drag(which)}
                >
                  <span aria-hidden="true" className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-8 w-2.5 border bg-black group-focus-visible:ring-2 group-focus-visible:ring-white" style={{ borderColor: GREEN }} />
                  <span aria-hidden="true" className={`absolute bottom-1 whitespace-nowrap font-mono text-[10px] px-1 bg-black/80 ${which === 'lo' ? 'right-1/2 mr-2' : 'left-1/2 ml-2'}`} style={{ color: GREEN }}>
                    {priceWords(pair, flipped, sign * u)}
                  </span>
                </div>
              );
            })}
        </div>
        <div aria-hidden="true" className="mt-1 flex justify-between gap-3 font-mono text-[10px] text-[#f5e4b8]/55 tabular-nums">
          <span>{loWords}</span>
          <span>{hiWords}</span>
        </div>
        <figcaption data-testid="range-depth-caption" className="mt-1 font-mono text-[10px] tracking-[0.08em] text-[#f5e4b8]/60">
          {bandsLine}
        </figcaption>
      </figure>
      {(depth.beyond.below || depth.beyond.above) && (
        <p data-testid="range-depth-beyond" className="font-mono text-[10px] tracking-[0.08em] text-[#f5e4b8]/60">
          Bands beyond this window were not read.
        </p>
      )}
      <p data-testid="range-depth-move" className="text-white/85">
        {moveLine}
      </p>
      <p data-testid="range-depth-inspect" aria-live="polite" className="text-white/70 min-h-[1.5em]">
        {inspected ?? 'Tap or point at a bar to see what would trade there.'}
      </p>

      {range ? (
        <div className="md:hidden space-y-2" data-testid="range-depth-steps">
          <EdgeControl label="Lowest price" which="lo" u={edges!.lo} view={view} spacing={s} words={edgeWords} onMove={move} disabled={p.locked} />
          <EdgeControl label="Highest price" which="hi" u={edges!.hi} view={view} spacing={s} words={edgeWords} onMove={move} disabled={p.locked} />
        </div>
      ) : (
        <button
          type="button"
          className={chipCls(false)}
          disabled={p.locked}
          onClick={() => {
            setFitNext(true);
            p.onStart();
          }}
        >
          Start a range near this pool’s price
        </button>
      )}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Chart view">
        <button type="button" className={chipCls(false)} disabled={!range} onClick={fitMine}>
          Fit my range
        </button>
        <button type="button" className={chipCls(false)} onClick={fitAll}>
          Fit all liquidity
        </button>
        <span className="inline-flex items-stretch" role="group" aria-label="Zoom">
          <span aria-hidden="true" className="self-center pr-2 font-mono text-[11px] tracking-[0.06em] text-[#f5e4b8]/60">
            Zoom
          </span>
          <button type="button" className={`${chipCls(false)} min-w-[44px]`} aria-label="Zoom out" onClick={() => zoom(2)}>
            −
          </button>
          <button type="button" className={`${chipCls(false)} min-w-[44px] -ml-px`} aria-label="Zoom in" onClick={() => zoom(1 / 2)}>
            +
          </button>
        </span>
        <button type="button" className={chipCls(flipped)} aria-pressed={flipped} onClick={() => setFlipped((f) => !f)}>
          {`Flip to ${unitText(pair, !flipped)}`}
        </button>
        {p.positions.length > 0 && (
          <button type="button" className={chipCls(showMine)} aria-pressed={showMine} onClick={() => setShowMine((v) => !v)}>
            Show my positions
          </button>
        )}
        <button type="button" className={chipCls(table)} aria-expanded={table} onClick={() => setTable((v) => !v)}>
          Show as a table
        </button>
      </div>
      {table && <DepthTable pair={pair} flipped={flipped} depth={depth} span={span} sign={sign} />}
      <FinePrint summary="How this is drawn">
        <div className="space-y-2 text-white/70 text-[11px]">
          <p>Each bar is one price step of this pool. Its height is the liquidity in use there, worked out from the pool’s own liquidity at its price and each price’s change in liquidity, as read from the chain.</p>
          <p>{`Marks along the top are orders resting at one price: cream ones sell ${tokenUnit(pair)}, green outlines buy it. They fill when a swap reaches that price.`}</p>
          <p>The 2% figures are a swap run through the range program’s own maths with that price as its limit, the pool’s fee and resting orders included.</p>
          <p>Only the bands nearest the price are read: the one at the price and 8 in use on each side. Striped parts could not be read, and nothing past them is drawn.</p>
        </div>
      </FinePrint>
    </div>
  );
}

function OrderMark({ x, sells }: { x: number; sells: boolean }) {
  return sells ? (
    <rect data-testid="range-depth-order" data-sells="1" x={x - 1} y={2} width={3} height={11} fill={EDITORIAL_INK} />
  ) : (
    <rect data-testid="range-depth-order" data-sells="0" x={x - 1.5} y={2.5} width={3} height={10} fill="none" stroke={GREEN} strokeWidth={1} />
  );
}

function LineLabel({ at, color, text, row }: { at: number; color: string; text: string; row: number }) {
  if (!(at >= -1 && at <= 101)) return null;
  const right = at > 66;
  return (
    <span
      aria-hidden="true"
      className={`absolute whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] px-1 bg-black/70 ${right ? '-translate-x-full -ml-1' : 'ml-1'}`}
      style={{ left: `${at}%`, top: TOP + row * 16, color }}
    >
      {text}
    </span>
  );
}

const GAP_WORDS: Record<DepthGap['kind'], string> = { unread: 'could not be read', 'not-read': 'not read', 'not-known': 'not known' };

function GapLabel({ gap, left, right }: { gap: DepthGap; left: number; right: number }) {
  if (right - left < 64) return null;
  return (
    <span
      data-testid={`range-depth-gap-${gap.kind}`}
      className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] tracking-[0.1em] px-1 bg-black/80 ${gap.kind === 'unread' ? 'text-amber-200' : 'text-[#f5e4b8]/55'}`}
      style={{ left: (left + right) / 2 }}
    >
      {GAP_WORDS[gap.kind]}
    </span>
  );
}

/** Under 768px: an edge's price, a slider and one-step buttons. The chart itself takes no drag there. */
function EdgeControl(p: { label: string; which: 'lo' | 'hi'; u: number; view: View; spacing: number; words: (u: number) => string; onMove: (which: 'lo' | 'hi', u: number) => void; disabled: boolean }) {
  const s = p.spacing;
  const min = Math.min(Math.floor(p.view.lo / s) * s, p.u);
  const max = Math.max(Math.ceil(p.view.hi / s) * s, p.u);
  const btn = 'min-h-[44px] min-w-[44px] border border-white/20 bg-black/20 font-mono text-[16px] text-[#f5e4b8] disabled:opacity-60';
  return (
    <div>
      <div className="flex justify-between gap-3 font-mono text-[10.5px] tracking-[0.06em] text-[#f5e4b8]/70">
        <span>{p.label}</span>
        <span className="text-white tabular-nums">{p.words(p.u)}</span>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className={btn} disabled={p.disabled} aria-label={`${p.label}, one step lower`} onClick={() => p.onMove(p.which, p.u - s)}>
          −
        </button>
        <input
          type="range"
          className="flex-1 min-w-0 h-11 accent-[#22c55e]"
          aria-label={p.label}
          aria-valuetext={p.words(p.u)}
          min={min}
          max={max}
          step={s}
          value={p.u}
          disabled={p.disabled}
          onChange={(e) => p.onMove(p.which, Number(e.target.value))}
        />
        <button type="button" className={btn} disabled={p.disabled} aria-label={`${p.label}, one step higher`} onClick={() => p.onMove(p.which, p.u + s)}>
          +
        </button>
      </div>
    </div>
  );
}

/** The bars in view as rows: each run of one liquidity, each part not known, and the orders in it. */
function DepthTable({ pair, flipped, depth, span, sign }: { pair: Pair; flipped: boolean; depth: Depth; span: Span; sign: 1 | -1 }) {
  type Row = { from: number; to: number; what: string; orders: RestingOrder[] };
  const rows: Row[] = [];
  const clip = (from: number, to: number) => ({ from: Math.max(from, span.from), to: Math.min(to, span.to) });
  const ordersIn = (from: number, to: number) => depth.orders.filter((o) => o.tick >= from && o.tick < to);
  for (const r of depth.runs) {
    const c = clip(r.from, r.to);
    if (c.to <= c.from) continue;
    const orders = ordersIn(c.from, c.to);
    if (r.liquidity <= 0n && orders.length === 0) continue;
    const { amount0, amount1 } = runAmounts(c.from, c.to, r.liquidity);
    const [token, coin] = pair.tokenIsToken0 ? [amount0, amount1] : [amount1, amount0];
    rows.push({ ...c, orders, what: r.liquidity > 0n ? `${tokenAmount(pair, token)} and ${coinAmount(pair, coin)}` : 'no liquidity in use' });
  }
  for (const g of depth.gaps) {
    const c = clip(g.from, g.to);
    if (c.to > c.from) rows.push({ ...c, orders: [], what: GAP_WORDS[g.kind] });
  }
  rows.sort((a, b) => sign * (a.from - b.from));
  return (
    <div className="overflow-x-auto" data-testid="range-depth-table">
      <table className="w-full text-left text-[11px]">
        <caption className="sr-only">{`Liquidity in view, by price, in ${unitText(pair, flipped)}`}</caption>
        <thead>
          <tr className="font-mono text-[10px] tracking-[0.08em] text-[#f5e4b8]/60">
            <th scope="col" className="py-1.5 pr-3 font-normal">{`Prices (${unitText(pair, flipped)})`}</th>
            <th scope="col" className="py-1.5 pr-3 font-normal">Would trade there</th>
            <th scope="col" className="py-1.5 font-normal">Resting orders</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const [a, b] = spanPrices(pair, flipped, r.from, r.to);
            return (
              <tr key={`${r.from}:${r.to}`} className="border-t border-white/[0.12] align-top">
                <td className="py-1.5 pr-3 font-mono tabular-nums text-white/85">
                  {`${a} to ${b}`}
                  <span className="block text-[10px] text-[#f5e4b8]/45">{`ticks ${r.from.toLocaleString('en-US')} to ${r.to.toLocaleString('en-US')}`}</span>
                </td>
                <td className="py-1.5 pr-3 text-white/80">{r.what}</td>
                <td className="py-1.5 text-white/70">{r.orders.length ? r.orders.map((o) => orderWords(pair, flipped, o)).join('; ') : 'none'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
