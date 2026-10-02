/**
 * WAVE SEVEN, answer ten, ruling 6: THE ELEVEN SETTLED ROOMS SPEAK WITHOUT A PROSE DASH.
 *
 * Every settled room carried the same handful of prose em dashes from a few shared
 * source lines, so eleven rooms' budgets in e2e/em-dash-zero.spec.ts sat at 4, 5 or 6
 * while not one of those dashes was room-specific copy. The fix is punctuation only,
 * words unchanged, and the rendered ratchet is the real judge: it now holds all eleven
 * at zero.
 *
 * WHY A UNIT GUARD AS WELL. That ratchet runs only against a production build, on one
 * browser project. The sources below are pure functions of the registry, so they can
 * be checked on every push, for EVERY resident rather than the ones a walk happens to
 * visit - a twelfth room added tomorrow is covered without anyone editing this file.
 *
 * AND THE ONE THE INSTRUMENTS CANNOT SEE. The quote's attribution in BungalowHero was
 * `&mdash;` alone in its own text node, so both the venue's ratchet and the island's
 * raw count filed it as the unread placeholder, and it counted zero. To a reader it is
 * a prose dash in every room's hero. Only a rendered assertion on the byline can prove
 * it moved, so that is what the last test does.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BUNGALOWS, bungalowArtFor, bungalowTradeBlurb } from '../../lib/bungalows';
import { BungalowHero } from './BungalowHero';

const EM_DASH = '—';

/** The rooms ruling 6 is about: every live resident with its own identity. */
const SETTLED = BUNGALOWS.filter((b) => b.live && b.identity);

describe('the settled rooms carry no prose em dash (ruling 6)', () => {
  it('is judging all eleven rooms, not a sample', () => {
    // toweli is live but has no settled identity (it is the TOWELI room), and nb1
    // is the quiet slot. If this count moves, the ruling's "eleven" moved with it.
    expect(SETTLED.map((b) => b.id).sort()).toEqual(
      ['bayla', 'bnkr', 'bobo', 'brainlet', 'drb', 'jbm', 'mfer', 'pepe', 'qr', 'rizz', 'soy'],
    );
  });

  it('hero copy', () => {
    for (const b of SETTLED) expect(b.identity!.heroCopy, b.id).not.toContain(EM_DASH);
  });

  it('the footer trade line, on both swap branches', () => {
    // Both branches, because which one renders depends on the chain: the EVM rooms
    // take the chart line and the Solana rooms the trade line.
    for (const b of SETTLED) {
      expect(bungalowTradeBlurb(b, true), `${b.id} live`).not.toContain(EM_DASH);
      expect(bungalowTradeBlurb(b, false), `${b.id} not live`).not.toContain(EM_DASH);
    }
  });

  it('the art captions, the footer line’s twin', () => {
    for (const b of SETTLED) {
      for (const piece of bungalowArtFor(b.id, b.name) ?? []) {
        expect(piece.description, `${b.id} ${piece.id}`).not.toContain(EM_DASH);
      }
    }
  });

  it('the quote attribution in every room hero uses the venue hero’s middle dot', () => {
    for (const b of SETTLED) {
      const { container, unmount } = render(
        <MemoryRouter>
          <BungalowHero bungalow={b as Parameters<typeof BungalowHero>[0]['bungalow']} />
        </MemoryRouter>,
      );
      // The attribution span is the separator plus museBy and nothing else. Matching
      // on "includes museBy" alone is wrong: for most rooms museBy is "Jungle Bay
      // Island", which other spans on the hero also say.
      const museBy = b.identity!.museBy;
      const byline = Array.from(container.querySelectorAll('span')).find((s) => {
        const t = (s.textContent ?? '').trim();
        return t.endsWith(museBy) && t.length <= museBy.length + 2;
      });
      expect(byline, `${b.id} renders its attribution`).toBeTruthy();
      expect(byline!.textContent, b.id).not.toContain(EM_DASH);
      expect(byline!.textContent, b.id).toContain('·');
      unmount();
    }
  });
});
