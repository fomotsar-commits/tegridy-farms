import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TokenDetail } from './TokenDetail';
import type { SolToken } from '../../lib/solanaTokenList';

// holderCount defined => TokenDetail's resolveMint effect short-circuits, so
// this renders with no network at all.
const TOKEN = {
  mint: 'So11111111111111111111111111111111111111112',
  symbol: 'SOL',
  name: 'Solana',
  decimals: 9,
  holderCount: 1,
} as unknown as SolToken;

/**
 * The parent passes a NEW inline arrow for onClose on every render — exactly
 * how TokenDetail is mounted (SolanaSwapPage.tsx renders it inline).
 */
function Harness() {
  const [n, setN] = useState(0);
  return (
    <>
      <button onClick={() => setN((v) => v + 1)}>rerender</button>
      <TokenDetail token={TOKEN} onClose={() => {}} />
    </>
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('TokenDetail: the open-dialog setup effect is mount-scoped', () => {
  // INVARIANT (not a literal): opening the dialog focuses it and locks body
  // scroll ONCE. A parent re-render must not tear that down and redo it —
  // pre-fix the effect listed `onClose` in its deps, so every parent render
  // ran cleanup (which restores focus to the opener) then setup (which
  // re-focuses the panel), yanking the caret away from whoever was typing.
  it('does not re-focus or re-lock scroll when the parent re-renders', () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    render(<Harness />);
    const focusesAfterMount = focusSpy.mock.calls.length;
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(screen.getByRole('button', { name: /rerender/i }));

    expect(focusSpy.mock.calls.length).toBe(focusesAfterMount);
    expect(document.body.style.overflow).toBe('hidden');
  });
});
