import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { useCityReads } from '../hooks/useCityReads';
import { CityCanvas, type CityHandle } from '../components/city/CityCanvas';
import { SheetRuler } from '../components/dwg/SheetRuler';
import { FinePrint } from '../components/ui/FinePrint';
import { HARVEST_CHAIN_LABEL, type HarvestChain } from '../lib/harvest/types';
import { rangePoolsVisible } from '../lib/solana/clmm/programId';
import { fmtUsd } from '../lib/wallet/walletRows';
import { PIECE_NAME, buildPlan, type CivicId, type Plot, type PoolRead } from '../lib/city/plan';
import type { SceneData } from '../lib/city/scene';
import { closeUpSrc } from '../lib/city/render';

/**
 * Sheet C-01: the island drawn as a city (owner, 2026-11-17: "a visualized city ... showcasing
 * our ecosystem"). The island is one night picture made in Blender (scripts/city-render/), every
 * room a building wrapped in its own art with its pool beside it; a press on one opens its close-up,
 * where the art is full size (owner, 2026-11-18: "museum level", "i cant see the art").
 *
 * WHAT IS REAL ON IT. A room's card gives its coin's market-pool dollars, or says they were not
 * read; the water in the picture is a picture. With a wallet connected, a line of people walks from every
 * pool holding staking pay for it to the wallet's door. Trades, the venue's cut and pool fees are
 * NOT drawn yet: they need a trade feed the site does not have, and nothing here moves without
 * a read (hooks/useCityReads.ts).
 *
 * FEW WORDS (owner, 2026-10-14): a heading, a line, the drawing. How to read it is small print.
 * The drawing is hidden from screen readers; the list under it names every plot and is how a
 * keyboard reaches one.
 */

/** One line for each of the city's own buildings: what it is, said once. */
const CIVIC_LINE: Record<CivicId, string> = {
  loans: 'Borrow or lend against NFTs.',
  keeper: 'Keeps our pools level with prices outside.',
  lot: 'Waiting for the next room.',
  station: 'Every swap on our own pools sets off from here.',
  treasury: 'Where the venue’s cut goes. Every move out waits 48 hours.',
  range: 'Pools that work inside a price band.',
  wallet: 'Your staking pay walks here.',
  launch: 'Launching is switched off for now.',
};

const clock = (unixSecs: number): string => new Date(unixSecs * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

/** A room's pool, in words: its dollars with where and when they were read, or that it was not read. */
function poolLine(read: PoolRead | undefined, readAt: number | null): string {
  if (!read || read.state === 'dry') return 'Pool not read.';
  if (read.state === 'still') return 'Pool read, with no dollar figure.';
  return `${fmtUsd(read.usd)} in its market pool${readAt === null ? '' : `, GeckoTerminal at ${clock(readAt)}`}.`;
}

function PlotCard({ plot, read, readAt }: { plot: Plot; read: PoolRead | undefined; readAt: number | null }) {
  const href = plot.civic === 'range' && !rangePoolsVisible() ? undefined : plot.href;
  const chain = plot.chain && plot.chain in HARVEST_CHAIN_LABEL ? HARVEST_CHAIN_LABEL[plot.chain as HarvestChain] : null;
  return (
    <article className="c01-card" aria-live="polite" data-testid="city-card">
      <img key={plot.id} className="c01-shot" src={closeUpSrc(plot.id)} alt={`${plot.name}, ${PIECE_NAME[plot.piece]}, close up`} width={1000} height={1250} decoding="async" />
      <span className="dwg-label dwg-t" data-t={PIECE_NAME[plot.piece]} aria-hidden="true" />
      <h2 className="dwg-name">{plot.name}</h2>
      {plot.kind === 'room' ? (
        <>
          <p className="dwg-fact"><b>{plot.tick}</b>{chain ? ` on ${chain}` : ''}</p>
          <p className="dwg-fact">{poolLine(read, readAt)}</p>
          {plot.addr && <p className="c01-addr">{plot.addr}</p>}
        </>
      ) : (
        <p className="dwg-fact">{CIVIC_LINE[plot.civic!]}</p>
      )}
      {href && <Link className="dwg-link c01-go" to={href}>Open {plot.kind === 'room' ? plot.name : plot.name.toLowerCase()}</Link>}
    </article>
  );
}

export default function CityPage() {
  usePageTitle('The city', 'Jungle Bay Island drawn as a city: every room a building, every pool its water.');
  const reads = useCityReads();
  const plan = useMemo(() => buildPlan(reads.rooms), [reads.rooms]);
  const canvas = useRef<CityHandle>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<string>(() => (plan.byId.has('bayla') ? 'bayla' : plan.plots[0]!.id));
  const [paused, setPaused] = useState(false);

  const paying = useMemo(() => reads.pay.rooms.filter((id) => plan.byId.get(id)?.walk), [reads.pay.rooms, plan]);
  const data = useMemo<SceneData>(
    () => ({ paying: paying.map((roomId) => ({ roomId })), walletLit: reads.wallet !== 'none' }),
    [paying, reads.wallet],
  );
  const plot = plan.byId.get(picked) ?? plan.plots[0]!;

  /** A plot picked from the list: show it on the drawing, and bring the drawing into view. */
  const show = (id: string): void => {
    setPicked(id);
    canvas.current?.show(id);
    stage.current?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <div className="relative min-h-screen dwg" data-sheet="C">
      <div className="relative z-10 page-column mx-auto px-4 md:px-6 pt-8 pb-16">
        <div className="dwg-sheet c01-sheet">
          <SheetRuler />
          <div className="c01-hero dwg-grain">
            <p className="dwg-cap" aria-hidden="true"><span className="dwg-t" data-t="Sheet C-01 · The island" /></p>
            <h1 className="dwg-word"><span data-echo="City.">City.</span></h1>
            <p className="dwg-lede">Every room on the island as a building, with its pool beside it.</p>
          </div>

          <div className="c01-stage" ref={stage}>
            <CityCanvas ref={canvas} plan={plan} data={data} selectedId={picked} onSelect={setPicked} paused={paused} />
          </div>
          <div className="dwg-band c01-toolbar">
            <div className="c01-tools" role="toolbar" aria-label="The drawing">
              <button type="button" className="dwg-chip" onClick={() => canvas.current?.zoomBy(1 / 1.3)} aria-label="Zoom out"><span aria-hidden="true">−</span></button>
              <button type="button" className="dwg-chip" onClick={() => canvas.current?.zoomBy(1.3)} aria-label="Zoom in"><span aria-hidden="true">+</span></button>
              <button type="button" className="dwg-chip" onClick={() => canvas.current?.fit()}>Whole island</button>
              <button type="button" className="dwg-chip" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>Pause</button>
            </div>
            <FinePrint summary="How to read it" className="c01-fine">
              <p>Each room’s building wears its own art. Its card gives its pool’s dollars, read from GeckoTerminal, or says they were not read.</p>
              <p>People carrying baskets are staking pay, walking from a pool that holds some for the connected wallet to that wallet’s door.</p>
              <p>Trades, pool fees and the venue’s cut are not drawn yet.</p>
            </FinePrint>
          </div>

          <section className="dwg-band" data-split="" aria-label="The plot you picked">
            <div className="dwg-band-head" data-n="01" aria-hidden="true" />
            <PlotCard plot={plot} read={reads.pools.get(plot.id)} readAt={reads.poolsReadAt} />
          </section>

          <section className="dwg-band" data-split="" data-testid="city-wallet">
            <div className="dwg-band-head" data-n="02"><h2 className="dwg-h2">Your staking pay</h2></div>
            <div className="c01-card">
              {reads.wallet === 'none' && <p className="dwg-fact">Connect a wallet at the top. Your pay then walks from each pool to your door.</p>}
              {reads.wallet === 'reading' && <p className="dwg-fact">Reading your pools.</p>}
              {reads.wallet === 'read' && paying.length > 0 && (
                <>
                  <ul className="c01-plots" aria-label="Pools holding pay for you">
                    {paying.map((id) => {
                      const p = plan.byId.get(id)!;
                      return (
                        <li key={id}>
                          <button type="button" className="dwg-chip" onClick={() => show(id)}>
                            <i className="c01-sq" style={{ background: p.pool?.water ?? p.acc }} aria-hidden="true" />{p.tick}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <Link className="dwg-link c01-go" to="/earn">Claim on Earn</Link>
                </>
              )}
              {reads.wallet === 'read' && paying.length === 0 && reads.pay.unread === 0 && (
                <>
                  <p className="dwg-fact">No staking pay is waiting for this wallet.</p>
                  <Link className="dwg-link c01-go" to="/earn">Stake on Earn</Link>
                </>
              )}
              {reads.wallet === 'read' && reads.pay.unread > 0 && (
                <p className="dwg-fact">{reads.pay.unread === 1 ? 'One pool was not read.' : `${reads.pay.unread} pools were not read.`}</p>
              )}
            </div>
          </section>

          <nav className="dwg-band" data-split="" aria-label="Every plot">
            <div className="dwg-band-head" data-n="03" aria-hidden="true" />
            <ul className="c01-plots">
              {plan.plots.map((p) => (
                <li key={p.id}>
                  <button type="button" className="dwg-chip" aria-pressed={p.id === plot.id} onClick={() => show(p.id)}>
                    <i className="c01-sq" style={{ background: p.pool?.water ?? p.acc }} aria-hidden="true" />{p.tick}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="dwg-title" aria-hidden="true">
            <div><div className="dwg-tcap" data-cap="Sheet" /><div className="dwg-sheetno" data-no="C-01" /></div>
            <div><div className="dwg-tcap" data-cap="Title" /><div className="dwg-tval" data-val="The island as a city" /></div>
            <div><div className="dwg-tcap" data-cap="Plots" /><div className="dwg-tval" data-val={String(plan.plots.length)} /></div>
            <div><div className="dwg-tcap" data-cap="Pools read" /><div className="dwg-tval" data-val={reads.poolsReadAt === null ? 'not yet' : clock(reads.poolsReadAt)} /></div>
          </div>
        </div>
      </div>
    </div>
  );
}
