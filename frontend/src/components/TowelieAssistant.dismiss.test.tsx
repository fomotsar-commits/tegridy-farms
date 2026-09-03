/**
 * A11Y-R12 — the floating assistant's dismiss control is tappable.
 *
 * It was `w-5 h-5` — a 20x20px target — on a control that sits in a `fixed`
 * overlay rendered on every route, and it is the only way to make the bubble go
 * away. The painted square must stay 20px (the bubble it sits in is barely
 * taller than that, and growing the box grows the hover fill with it), so the
 * fix grows the HIT AREA alone. Fails on the pre-change component.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { wagmiMock } from '../test-utils/wagmi-mocks';

vi.mock('./ArtImg', () => ({ ArtImg: () => null }));

import { TowelieAssistant } from './TowelieAssistant';
import { TowelieProvider } from '../hooks/useTowelie';

describe('TowelieAssistant — bubble dismiss', () => {
  beforeEach(() => {
    wagmiMock.reset();
    localStorage.clear();
  });

  it('gives the dismiss control a 44px tap target without repainting it', () => {
    render(
      <MemoryRouter>
        <TowelieProvider>
          <TowelieAssistant />
        </TowelieProvider>
      </MemoryRouter>,
    );
    // The avatar is the way a user summons the bubble, so it is the way this
    // test reaches the control rather than reaching into component state.
    fireEvent.click(screen.getByRole('button', { name: /towelie says hi/i }));

    const dismiss = screen.getByRole('button', { name: /dismiss towelie/i });
    expect(dismiss.className).toContain('w-5');
    expect(dismiss.className).toContain('h-5');
    expect(dismiss.className).toContain("before:content-['']");
    // 20px painted + 12px of transparent overlay each side = 44.
    expect(dismiss.className).toContain('before:-inset-[12px]');
  });
});
