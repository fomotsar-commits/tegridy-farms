/**
 * A11Y-R13 — the consent banner is a banner, and says so.
 *
 * It declared role="dialog" with aria-live="polite" and none of the dialog
 * contract: no aria-modal, no focus move, no trap, no Escape, no restore. A
 * screen-reader user was told a dialog had appeared and was never put inside
 * it. It is structurally a bottom strip over a fully usable page, and telemetry
 * stays off until a button is pressed, so the defect was the CLAIM, not the
 * missing trap — role="region" is the true one. Fails on the pre-change file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConsentBanner } from './ConsentBanner';

beforeEach(() => localStorage.clear());

describe('ConsentBanner', () => {
  it('announces itself as a named region, not as a dialog', () => {
    render(<ConsentBanner />);
    expect(screen.getByRole('region', { name: 'Privacy consent' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('gives both choices a 44px target', () => {
    render(<ConsentBanner />);
    for (const name of ['Decline', 'Accept']) {
      expect(screen.getByRole('button', { name }).className).toContain('min-h-[44px]');
    }
  });
});
