import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

const BLOCKS = 'h3, p, li, div';

/**
 * What moves a line without the transaction changing, marked on the element with
 * `data-review-line` (or an ancestor): `market`, a row read against a market price;
 * `warning`, a warning that restates such a row; `fee`, a line the network's fees move;
 * `clock`, a line the chain's clock moves (a running reward owed).
 */
export type LineGroup = 'market' | 'warning' | 'fee' | 'clock';

/** A review as its reader sees it, sorted by what can move each line. */
export interface ReviewText {
  /** The transaction's own lines: the pool, the token, the amounts, the bounds, the shares. */
  lines: string[];
  market: string[];
  warnings: string[];
  fees: string[];
  clock: string[];
}

/** Where a line goes. A mark this file does not know is the transaction's own. */
function groupOf(el: Element): keyof ReviewText {
  switch (el.closest('[data-review-line]')?.getAttribute('data-review-line')) {
    case 'market':
      return 'market';
    case 'warning':
      return 'warnings';
    case 'fee':
      return 'fees';
    case 'clock':
      return 'clock';
    default:
      return 'lines';
  }
}

/**
 * A review as the lines its reader sees, in order: a row is "label: value", and the
 * heading, each notice and each list item is a line. Rendered off screen, so a
 * transaction that was prepared again can be compared with the review being read
 * (useTxFlow). Call it from an event or a promise, never while React is rendering.
 */
export function reviewLines(review: ReactElement): ReviewText {
  const host = document.createElement('div');
  const root = createRoot(host);
  const out: ReviewText = { lines: [], market: [], warnings: [], fees: [], clock: [] };
  try {
    flushSync(() => root.render(review));
    for (const el of Array.from(host.querySelectorAll(BLOCKS))) {
      if (el.querySelector(BLOCKS) !== null) continue;
      const parts = Array.from(el.childNodes);
      const row = parts.length === 2 && parts.every((n) => n.nodeType === Node.ELEMENT_NODE);
      const line = (row ? `${parts[0]!.textContent}: ${parts[1]!.textContent}` : (el.textContent ?? '')).trim();
      if (line !== '') out[groupOf(el)].push(line);
    }
    return out;
  } finally {
    root.unmount();
  }
}
