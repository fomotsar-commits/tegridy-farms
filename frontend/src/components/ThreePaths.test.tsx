// The three paths. Small surface, three load-bearing properties:
//
//  1. THE FLOOR IS READ, NEVER TYPED. This is the one that can rot silently. A
//     hardcoded 80 renders identically to a read 80 on every screenshot and in every
//     review, and only diverges the day an operator moves the dial — at which point
//     the home page promises one number and the gate enforces another. So the test
//     moves the dial and insists the card follows.
//  2. EXACTLY THREE DOORS, to the three routes the hero's CTAs used to cover.
//  3. ZERO EM DASHES, because this component is new venue voice and element I's
//     rendered guard will walk it.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThreePaths } from './ThreePaths';
import { LAUNCH_FLOOR } from '../lib/heat/heatOracle';

function mount() {
  return render(
    <MemoryRouter>
      <ThreePaths />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the launch floor is read, never typed', () => {
  it('follows the operator dial rather than a constant', () => {
    vi.stubEnv('VITE_HEAT_LAUNCH_FLOOR', '123');
    const { container } = mount();
    expect(container.textContent).toContain('123°');
    // And the island's real floor is NOT on screen, so a hardcode cannot hide here.
    expect(container.textContent).not.toContain(`${LAUNCH_FLOOR}°`);
  });

  it('falls back to the island’s published floor with no override', () => {
    const { container } = mount();
    expect(container.textContent).toContain(`${LAUNCH_FLOOR}°`);
  });

  it('ignores a nonsense dial instead of opening the door to everyone', () => {
    // positiveNumberEnv refuses 0 and non-numerics; the card must show the fallback,
    // never "The floor is 0°".
    vi.stubEnv('VITE_HEAT_LAUNCH_FLOOR', '0');
    const { container } = mount();
    expect(container.textContent).toContain(`${LAUNCH_FLOOR}°`);
    // Anchored on the sentence, not the bare glyphs: the fallback "The floor is 80°."
    // legitimately ends in "0°.", so a looser assertion fails on correct output.
    expect(container.textContent).not.toContain('The floor is 0°');
  });
});

describe('the doors', () => {
  it('offers exactly three, to the hall, liquidity and launch', () => {
    mount();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/#hall', '/liquidity', '/launch']);
  });

  it('states each requirement at the point of intent', () => {
    const { container } = mount();
    const text = container.textContent ?? '';
    expect(text).toContain('Your clock starts at your first buy.');
    expect(text).toContain('Withdraw any time. No lock.');
    expect(text).toContain('Residents may plant.');
  });

  it('names all three paths', () => {
    mount();
    for (const title of ['Hold', 'Provide LP', 'Launch']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
  });
});

describe('venue voice', () => {
  it('carries zero em dashes in its rendered text', () => {
    const { container } = mount();
    // U+2014. Element I's rendered leg walks the whole page for these; this component
    // is new copy, so it is pinned at its own source rather than caught downstream.
    expect(container.textContent ?? '').not.toContain('—');
  });
});
