import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

const BLOCKS = 'h3, p, li, div';

/**
 * One line of a review. `market` names a line read from the market just now (TxFlowView
 * marks it `data-market`: a price check, its cost, a warning restating them), which can read
 * differently or go on the next build while the transaction stays the same. Else null.
 */
export interface ReviewLine {
  text: string;
  market: string | null;
}

/**
 * A review as the lines its reader sees, in order: a row is "label: value", and the
 * heading, each notice and each list item is a line. Rendered off screen, so a
 * transaction that was prepared again can be compared with the review being read
 * (useTxFlow). Call it from an event or a promise, never while React is rendering.
 */
export function reviewLines(review: ReactElement): ReviewLine[] {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    flushSync(() => root.render(review));
    return Array.from(host.querySelectorAll(BLOCKS))
      .filter((el) => el.querySelector(BLOCKS) === null)
      .map((el) => {
        const parts = Array.from(el.childNodes);
        const row = parts.length === 2 && parts.every((n) => n.nodeType === Node.ELEMENT_NODE);
        const text = (row ? `${parts[0]!.textContent}: ${parts[1]!.textContent}` : (el.textContent ?? '')).trim();
        return { text, market: el.closest('[data-market]')?.getAttribute('data-market') ?? null };
      })
      .filter((line) => line.text !== '');
  } finally {
    root.unmount();
  }
}
