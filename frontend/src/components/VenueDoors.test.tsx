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
    expect(toweli.querySelector('img')).not.toHaveClass('grayscale');
  });

  it('exactly two doors are LIVE; every other resident door is SETTLED and greyed', () => {
    renderHall();
    expect(screen.getAllByText('LIVE').length).toBe(2);
    const settled = BUNGALOWS.filter((b) => b.chain !== 'tbd' && !['toweli', 'bayla'].includes(b.id));
    expect(screen.getAllByText('SETTLED').length).toBe(settled.length);
    for (const b of settled) {
      const door = screen.getByLabelText(new RegExp(`${b.name} bungalow \\(${b.symbol}\\), settled`, 'i'));
      // Greyed but still a walkable door to the plaque landing.
      expect(door).toHaveAttribute('href', `/${b.id}`);
      expect(door.className).toContain('opacity-75');
      expect(door.querySelector('img')).toHaveClass('grayscale');
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
