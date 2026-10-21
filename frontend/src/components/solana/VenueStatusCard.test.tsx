import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { VenueStatusCard } from './VenueStatusCard';
import { RECORDING, recordedTier } from '../../lib/solana/cpswap/mainnetVenueReplay.fixture';

// A Tailwind spacing class in px: `pt-3` is 12, `pt-[15px]` is 15. The first prefix found wins.
function px(el: Element, ...prefixes: string[]): number {
  for (const prefix of prefixes) {
    for (const cls of Array.from(el.classList)) {
      const m = cls.match(new RegExp(`^${prefix}-(?:\\[(\\d+(?:\\.\\d+)?)px\\]|(\\d+(?:\\.\\d+)?))$`));
      if (m) return m[1] !== undefined ? Number(m[1]) : Number(m[2]) * 4;
    }
  }
  return 0;
}

// One line of the copy button's 12px text, measured in a browser (jsdom lays nothing out);
// e2e/tab-target-size.spec.ts hit-tests the real boxes at 390, 820 and 1280.
const LINE = 18;
const FLOOR = 44;

describe('the live venue card\'s two copy buttons', () => {
  it('each take a press over 44px, and on a phone, where the chips wrap, neither reaches the other', () => {
    render(<VenueStatusCard status={{ kind: 'live', programId: RECORDING.program, config: recordedTier(0), publicTier: { kind: 'not-asked' } }} onRefresh={() => {}} lpMode="off" />);
    const card = screen.getByRole('region', { name: 'Venue status' });
    const [program, config] = within(card).getAllByTitle('Copy to clipboard');
    const chip = program.parentElement!;
    const row = chip.parentElement!;
    expect(row).toBe(config.parentElement!.parentElement);
    expect(row).toHaveClass('flex-wrap');
    // What a chip adds round its button: its own padding and its 1px border.
    const edge = px(chip, 'py') + 1;
    const reach = (button: Element) => {
      const top = px(button, 'pt', 'py');
      const bottom = px(button, 'pb', 'py');
      // The press area is padding taken back by the same negative margin, so nothing moves.
      expect([px(button, '-mt', '-my'), px(button, '-mb', '-my')]).toEqual([top, bottom]);
      expect(LINE + top + bottom, `${button.textContent} is shorter than a finger`).toBeGreaterThanOrEqual(FLOOR);
      return { above: top - edge, below: bottom - edge };
    };
    const [p, c] = [reach(program), reach(config)];
    // Wrapped, Config is the row under Program, later in the page: where the two areas met
    // it took Program's bottom, so a press there copied the config's address. 1px clear.
    expect(p.below + c.above, 'the two press areas meet between the wrapped rows').toBeLessThan(px(row, 'gap-y', 'gap'));
    // Above, the heading (earlier in the page, so the button would take a press on it).
    // Below, Details is a later button and would take the press: kept 1px clear.
    const heading = within(card).getByRole('heading', { level: 2 });
    const details = card.querySelector('details')!;
    for (const r of [p, c]) {
      expect(r.above, 'a copy button reaches over the heading').toBeLessThanOrEqual(px(heading, 'mb'));
      expect(r.below, 'a copy button reaches Details').toBeLessThan(px(details, 'mt'));
    }
  });
});
