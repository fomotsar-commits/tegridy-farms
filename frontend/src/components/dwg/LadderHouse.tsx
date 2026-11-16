import { useId, type CSSProperties } from 'react';
import type { Bungalow } from '../../lib/bungalows';
import { doorArt } from '../../lib/doorArt';
import { EDITORIAL_BG, EDITORIAL_GREEN, EDITORIAL_INK, mixHex } from '../../lib/editorial';
import { pts, type Pt } from '../../lib/iso';
import { gableFrame, muralFrame } from '../../lib/isoBungalow';
import { muralSrc, pictureFacts, restDim, usePictures } from '../../lib/isoMural';
import { useLadderPick, type LadderPick } from '../../lib/ladderPick';
import { BungalowDefs, IsoBungalow } from '../farm/IsoBungalow';
import { DIM_OFF, METER, PLINTH_V, TAG_ROOM, heldMark, ladderScene } from './ladderScene';

/** The sheet's brass (styles/dwg.css, --dwg-spot under data-sheet S). */
const SPOT = '#e3b341';
const COS30 = 0.866;
const SIN30 = 0.5;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * S-01's drawing (owner, 2026-11-15): the pool's own brick bungalow, as on Earn's model, drawn
 * large, with its lock ladder to scale and the picked lock measured from the ground. It reads no
 * chain: the rungs and the pick come from the staircase that owns them (lib/ladderPick.ts), given
 * as `pick` by the ladder card or read from the store in the hero. Before a staircase publishes,
 * only the two rungs the contract fixes. Decoration to a reader: aria-hidden, no <text>, every
 * word drawn from data-t.
 */
export function LadderHouse({ room, place, pick: own }: {
  room: Bungalow;
  place: 'hero' | 'rail';
  /** The ladder card's own pick; the hero passes none and reads what the card published. */
  pick?: LadderPick | null;
}) {
  const published = useLadderPick(room.id);
  const pick = own ?? published;
  const id = `lh${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  // The room's own picture on the walls, at the larger copy: the house is drawn large here.
  const door = doorArt(room);
  const src = door?.src ? muralSrc(door.src, 480, import.meta.env.PROD) : undefined;
  usePictures(src ? [src] : []);
  const read = src ? pictureFacts(src) : undefined;
  const facts = read && read !== 'failed' ? read : null;

  const held = pick?.held ?? null;
  // Lit only for a wallet read to hold a position here: not read is neither.
  const lit = held !== null && held.length > 0;
  const meter = pick?.meter ?? 'idle';
  const accent = room.accent ?? EDITORIAL_GREEN;
  const scene = ladderScene({ rungs: pick?.rungs ?? null, picked: pick?.picked ?? null, held, tagRoom: TAG_ROOM[place] });
  const { box } = scene;
  const at = ([x, y]: Pt) => ({ left: `${r2(((x - box.x) / box.w) * 100)}%`, top: `${r2(((y - box.y) / box.h) * 100)}%` });
  const chain = room.chain === 'solana' ? 'Solana' : room.chain === 'base' ? 'Base' : 'Ethereum';
  const mid = METER.u + METER.w / 2;

  return (
    <div className="s01-house" data-place={place} aria-hidden="true" style={{ '--s01-ratio': r2(box.w / box.h) } as CSSProperties}>
      <div className="s01-figbox" style={{ aspectRatio: `${box.w} / ${box.h}` }}>
        <svg className="dwg-fig s01-fig" viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} focusable="false" data-lit={lit ? '1' : '0'}>
          <defs>
            <radialGradient id={`${id}-fade`} cx="50%" cy="56%" r="56%">
              <stop offset="52%" stopColor="#fff" stopOpacity="1" />
              <stop offset="100%" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
            <mask id={`${id}-m`} maskUnits="userSpaceOnUse" x={box.x} y={box.y} width={box.w} height={box.h}>
              <rect x={box.x} y={box.y} width={box.w} height={box.h} fill={`url(#${id}-fade)`} />
            </mask>
            <BungalowDefs id={id} />
          </defs>

          <g className="s01-ground">
            <g mask={`url(#${id}-m)`} stroke={EDITORIAL_INK} strokeOpacity="0.1" strokeWidth="1">
              {scene.grid.map(([a, b], k) => (
                <line key={k} x1={r2(a[0])} y1={r2(a[1])} x2={r2(b[0])} y2={r2(b[1])} />
              ))}
            </g>
            <polygon points={pts(scene.plot)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.05)} fillOpacity="0.9" stroke={EDITORIAL_INK} strokeOpacity="0.3" strokeWidth="1" />
            <polygon points={pts(scene.path)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.1)} stroke={EDITORIAL_INK} strokeOpacity="0.22" strokeWidth="1" />
          </g>

          <IsoBungalow
            defs={id}
            x={0}
            y={0}
            art={facts ? src : undefined}
            frames={facts ? { front: muralFrame(facts, door?.objectPosition), gable: gableFrame(facts, door?.objectPosition) } : null}
            dim={restDim(facts?.luma)}
            accent={accent}
            lit={lit}
            lifted={false}
            ladder={false}
            symbol={room.symbol}
          />

          {/* The meter on the gable wall, in that wall's plane: its needle turns only while the wallet's meter runs. */}
          <g className="s01-meterbox" data-meter={meter} transform={scene.meter.matrix}>
            <line x1={mid} y1={METER.v + METER.h} x2={mid} y2={PLINTH_V} stroke={EDITORIAL_INK} strokeOpacity="0.7" strokeWidth="1" />
            <rect x={METER.u} y={METER.v} width={METER.w} height={METER.h} fill={EDITORIAL_BG} stroke={EDITORIAL_INK} strokeOpacity="0.9" strokeWidth="1" />
            <circle cx={mid} cy={METER.v + 4.4} r="2.5" fill="none" stroke={EDITORIAL_INK} strokeOpacity="0.9" strokeWidth="1" />
            <line className="s01-needle" x1={mid} y1={METER.v + 4.4} x2={mid} y2={METER.v + 2.3} stroke={meter === 'live' ? EDITORIAL_GREEN : EDITORIAL_INK} strokeWidth="1.2" />
            <rect x={METER.u + 1.6} y={METER.v + 8.4} width={METER.w - 3.2} height="1.9" fill={meter === 'live' ? EDITORIAL_GREEN : mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.35)} />
          </g>

          <g className="s01-ladder" stroke={EDITORIAL_INK} strokeLinecap="round" data-ladder="">
            {scene.rails.map(([a, b], k) => (
              <line key={`r${k}`} className="s01-rail" x1={r2(a[0])} y1={r2(a[1])} x2={r2(b[0])} y2={r2(b[1])} />
            ))}
            {scene.climbed.map(([a, b], k) => (
              <line key={`c${k}`} className="s01-rail" data-climbed="" stroke={SPOT} x1={r2(a[0])} y1={r2(a[1])} x2={r2(b[0])} y2={r2(b[1])} />
            ))}
            {scene.rungs.map((r, k) => (
              <line key={`g${k}`} className="s01-rung" data-climbed={r.climbed ? '' : undefined} stroke={r.climbed ? SPOT : undefined} x1={r2(r.a[0])} y1={r2(r.a[1])} x2={r2(r.b[0])} y2={r2(r.b[1])} />
            ))}
            {scene.held.map((q, k) => {
              const mark = heldMark(q);
              return <rect key={`h${k}`} className="s01-held" x={r2(mark.x)} y={r2(mark.y)} width={mark.size} height={mark.size} fill={EDITORIAL_GREEN} stroke="none" />;
            })}
          </g>

          {/* The pick: one group moved to the rung's left end; its foot and its run move with it. */}
          {scene.pick && (
            <g className="s01-pick" style={{ transform: `translate(${r2(scene.pick.at[0])}px, ${r2(scene.pick.at[1])}px)` }} stroke={SPOT} fill="none">
              <line className="s01-pick-rung" x1="0" y1="0" x2={r2(scene.pick.span[0])} y2={r2(scene.pick.span[1])} strokeLinecap="round" />
              <line x1="-2.4" y1="0" x2={-DIM_OFF} y2="0" />
              <circle cx={-DIM_OFF} cy="0" r="0.85" fill={SPOT} stroke="none" />
              <line className="s01-pick-run" x1={-DIM_OFF} y1="0" x2={-DIM_OFF} y2="1" style={{ transform: `scaleY(${r2(scene.pick.run)})` }} />
              <g className="s01-pick-foot" style={{ transform: `translateY(${r2(scene.pick.run)}px)` }}>
                <line x1="2.5" y1="0" x2={-DIM_OFF} y2="0" strokeOpacity="0.6" strokeDasharray="2 3" />
                <circle cx={-DIM_OFF} cy="0" r="0.85" fill={SPOT} stroke="none" />
              </g>
              <rect className="s01-pick-mark" x="-1.6" y="-1.6" width="3.2" height="3.2" fill={SPOT} stroke="none" />
            </g>
          )}

          <g className="s01-leaders" stroke={EDITORIAL_INK} strokeOpacity="0.6" fill="none">
            {scene.leaders.map(([a, b], k) => (
              <line key={k} x1={r2(a[0])} y1={r2(a[1])} x2={r2(b[0])} y2={r2(b[1])} />
            ))}
          </g>
        </svg>

        {/* The figure's words, laid over it: each at a point of the drawing, drawn from data. */}
        <span className="dwg-figlabel s01-bub" data-t="1" style={at(scene.bubbles[0])} />
        <span className="dwg-figlabel s01-bub" data-t="2" style={at(scene.bubbles[1])} />
        {scene.pick && <span className="dwg-figlabel s01-tag" data-t={scene.pick.rung.weight} data-u={scene.pick.rung.lock} style={at(scene.pick.tag)} />}
        <span
          className="dwg-figlabel s01-plate"
          data-t={`${room.symbol} · ${chain}`}
          style={{ ...at(scene.plate), transform: `matrix(${COS30}, ${-SIN30}, ${COS30}, ${SIN30}, 0, 0)` }}
        />
      </div>
      <p className="s01-vt">
        <span data-t="Fig. 01" />
        <b />
        <span data-t="Rung height = weight" />
      </p>
    </div>
  );
}
