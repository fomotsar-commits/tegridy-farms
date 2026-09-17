/**
 * WAVE SEVEN, answer ten, rulings 3 and 4, on the venue's own hero.
 *
 * NOTHING RENDERED THIS HERO IN A TEST BEFORE, which is how a period after
 * FINANCE stood on the largest words of the venue for sixteen days. The e2e
 * checks used toContainText('MEMETICS.FINANCE'), a substring that passes with
 * the period and without it, so they could never have seen it.
 *
 * RULING 3. The H1 is title, <br />, line. A <br> is not text, so with the
 * period gone the H1's text reads "MEMETICS.FINANCEHeld time counts here." to
 * anything that reads text rather than pixels: a screen reader, a search engine,
 * a link unfurl. So the test reads textContent, which sees the join exactly, and
 * not an accessible-name helper, some of which pad a <br> with spaces and would
 * pass the defect.
 *
 * RULING 4. The launch floor is read (heatLaunchFloor) and the tier word beside
 * it must be derived from it, never typed: at 123 no tier is named, at 150 the
 * sentence says Builder. The island's own mutation for this is "retype Resident
 * and the 150 fixture goes red".
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The instrument is element B's and has its own suite; here it would only drag
// in wagmi and a network read that this test is not about.
vi.mock('./HeatCard', () => ({ HeatCard: () => null }));

const { VenueHero } = await import('./VenueHero');

function mount() {
  return render(
    <MemoryRouter>
      <VenueHero />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the title (ruling 3)', () => {
  it('reads MEMETICS.FINANCE with no period, and a real space before the line', () => {
    mount();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('MEMETICS.FINANCE Held time counts here.');
  });

  it('keeps the sentence its own period: only the domain lost one', () => {
    mount();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent?.endsWith('Held time counts here.')).toBe(true);
    expect(h1.textContent).not.toContain('FINANCE.');
  });
});

describe('the launch floor sentence (ruling 4)', () => {
  it('names no tier when the floor sits between rungs', () => {
    vi.stubEnv('VITE_HEAT_LAUNCH_FLOOR', '123');
    const { container } = mount();
    expect(screen.getByText('The launch door opens at 123 degrees.')).toBeTruthy();
    // tierFor(123) is Resident, because a floor BETWEEN rungs still sits above
    // one. That is exactly the word that must not appear beside 123.
    expect(container.textContent).not.toMatch(/you reach/);
  });

  it('names the tier the floor sits exactly on, derived and never typed', () => {
    vi.stubEnv('VITE_HEAT_LAUNCH_FLOOR', '150');
    const { container } = mount();
    expect(
      screen.getByText('At 150 degrees you reach Builder, the tier that may plant a launch here.'),
    ).toBeTruthy();
    expect(container.textContent).not.toContain('reach Resident');
  });

  it('reads today’s sentence at the default floor', () => {
    mount();
    expect(
      screen.getByText('At 80 degrees you reach Resident, the tier that may plant a launch here.'),
    ).toBeTruthy();
  });
});
