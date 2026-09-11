import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { VenueDoors } from './VenueDoors';
import { BUNGALOWS } from '../lib/bungalows';

/**
 * THE HALL OF DOORS — the venue arrival's island map (2026-08-31).
 *
 * Pins the island's presentation ruling: the venue home shows EVERY door;
 * exactly the open doors (TOWELI, BAYLA — the two finished experiences)
 * render lit and LIVE; settled residents render greyed but walkable to
 * their plaque landings; the unmarked spot is quiet and not a link; and
 * the hall carries zero Tegridy strings — the classic branding lives
 * behind the TOWELI door, never on the venue's own wall.
 */

function renderHall() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <VenueDoors />
    </MemoryRouter>,
  );
}

/**
 * Is this door's art desaturated?
 *
 * Asks about the RESULT rather than the mechanism, and it has now survived the
 * ruling it was written to pin being REVERSED, which is the argument for
 * writing it this way. It first read `toHaveClass('grayscale')`; the 2026-09-04
 * luminance pass moved the desaturation into an inline `filter` and reddened a
 * test whose subject had not changed. Wave seven's element H then took the
 * greying away entirely — and because this asks "is it grey", not "does it
 * carry this class", the same helper answers the new question by returning
 * false. Both CSS mechanisms stay listed on purpose: either one coming back is
 * the regression.
 */
function isDesaturated(img: HTMLImageElement | null): boolean {
  if (!img) return false;
  return img.classList.contains('grayscale') || /grayscale\(/u.test(img.style.filter);
}

describe('VenueDoors — the hall of doors', () => {
  it('shows one door per registry entry', () => {
    const { container } = renderHall();
    const grid = container.querySelector('.grid');
    expect(grid).toBeTruthy();
    expect(grid!.children.length).toBe(BUNGALOWS.length);
  });

  it('renders the open doors (toweli, bayla) as lit LIVE links', () => {
    renderHall();
    const toweli = screen.getByLabelText(/Enter the Toweli bungalow \(TOWELI, live\)/i);
    const bayla = screen.getByLabelText(/Enter the Bayla bungalow \(BAYLA, live\)/i);
    expect(toweli).toHaveAttribute('href', '/toweli');
    expect(bayla).toHaveAttribute('href', '/bayla');
    // Lit doors are never greyed.
    expect(toweli.className).not.toContain('opacity-75');
    expect(within(toweli).queryByText('LIVE')).toBeTruthy();
    // alt="" makes the art presentational — query the element, not the role.
    expect(isDesaturated(toweli.querySelector('img'))).toBe(false);
  });

  it('exactly two doors are LIVE; every other resident door is SETTLED, IN COLOUR, and walkable', () => {
    // WAVE SEVEN, element H: THE DOORS ARE IN COLOUR.
    //
    // This test asserted the opposite until now — that every settled door was
    // greyed, and that each carried its own measured brightness multiplier so
    // the greying landed evenly across paintings whose exposures varied 3.1x.
    // That apparatus was good engineering in service of a bad idea: it made a
    // resident's own art into a switched-off tile on the venue's front door.
    //
    // What a door IS still has to read at a glance, so the assertions below
    // pin the things that carry that meaning instead — the chip, the walkable
    // href, and the opacity STEP, which is depth rather than desaturation and
    // lifts to full on hover. Put `grayscale(` back on a settled door and this
    // reds.
    renderHall();
    expect(screen.getAllByText('LIVE').length).toBe(2);
    const settled = BUNGALOWS.filter((b) => b.chain !== 'tbd' && !['toweli', 'bayla'].includes(b.id));
    expect(screen.getAllByText('SETTLED').length).toBe(settled.length);
    for (const b of settled) {
      const door = screen.getByLabelText(new RegExp(`${b.name} bungalow \\(${b.symbol}\\), settled`, 'i'));
      // Still a walkable door to the plaque landing.
      expect(door).toHaveAttribute('href', `/${b.id}`);
      // Depth, not desaturation. It lifts to full on hover and on focus.
      expect(door.className).toContain('opacity-75');
      expect(door.className).toContain('hover:opacity-100');
      const img = door.querySelector('img');
      expect(isDesaturated(img), `${b.id} door is still greyed`).toBe(false);
      // And no leftover of the apparatus that served the greying: a per-image
      // brightness multiplier with nothing to normalise is a filter that only
      // darkens a resident's art for no stated reason.
      expect(img!.style.filter ?? '').not.toMatch(/brightness\(/u);
    }
  });

  it('keeps the quiet spot dark and not a link', () => {
    renderHall();
    const quiet = screen.getByLabelText(/quiet/i);
    expect(quiet.tagName).not.toBe('A');
    expect(screen.getAllByText('QUIET').length).toBe(1);
  });

  it('speaks zero Tegridy in the venue hall', () => {
    const { container } = renderHall();
    expect(container.textContent).not.toMatch(/tegridy/i);
    expect(container.innerHTML).not.toMatch(/Tegridy/);
  });

  it('names the island and the walk-in-where-you-hold line', () => {
    renderHall();
    expect(screen.getByText('The bungalows')).toBeInTheDocument();
    expect(screen.getByText(/Walk in where you hold/)).toBeInTheDocument();
  });
});
