import { useId } from 'react';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { PRICE_MOVE_TITLE, priceMoveNote } from '../../../lib/solana/lp/priceMove';

/**
 * "What if the price moves" on the Add form: the note's table and its one closing line
 * (priceMove.ts), and nothing of its own. It sits under Review and is never folded:
 * above Review, even folded, it pushed the button off the first screen at 1280x800
 * (measured 2026-10-10). Nothing at all for a pool the note cannot speak of.
 */
export function WhatIfPriceMoves({ view }: { view: PoolView }) {
  const id = useId();
  const note = priceMoveNote(view);
  if (!note) return null;
  return (
    <div data-testid="lp-price-move" className="rounded-lg p-3 space-y-2" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
      <h5 id={id} className="text-white/90 font-semibold">
        {PRICE_MOVE_TITLE}
      </h5>
      <table aria-labelledby={id} className="w-full text-left">
        <thead>
          <tr className="text-white/55">
            <th scope="col" className="font-normal pr-3 pb-1 align-bottom w-1/2">
              {note.priceHead}
            </th>
            <th scope="col" className="font-normal pb-1 align-bottom">
              {note.positionHead}
            </th>
          </tr>
        </thead>
        <tbody>
          {note.rows.map((r) => (
            <tr key={r.price} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <th scope="row" className="font-normal text-white/75 pr-3 py-1 align-top">
                {r.price}
              </th>
              <td className="text-white py-1 align-top">{r.position}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-white/65">{note.tail}</p>
    </div>
  );
}
