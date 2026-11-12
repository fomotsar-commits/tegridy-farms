// Island answer thirty-four: on the Buy sheet's bungalow row the picked coin is filled, so at a
// phone's width it reads as the choice and not as one more chip. An edge alone read as faint.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BungalowRow } from './SheetBuyRow';
import { sheetRooms } from '../../lib/sheet';

const rooms = sheetRooms();
const chips = () => within(screen.getByTestId('sheet-bungalow-row')).getAllByRole('button');
const flat = (s: string) => s.replace(/\s+/g, '');

describe('the bungalow row’s lit chip', () => {
  it('the picked coin is filled: its ground, a bright edge, its word at 700', () => {
    const picked = rooms[1]!;
    render(<BungalowRow lit={picked.address} onPick={() => undefined} />);
    const chip = screen.getByRole('button', { name: picked.symbol });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(flat(chip.style.background)).toBe('rgba(139,92,246,0.24)');
    expect(flat(chip.style.border)).toBe('1pxsolidrgba(167,139,250,0.95)');
    expect(chip.style.fontWeight).toBe('700');
    expect(chip).toHaveClass('text-white');
  });

  it('every other chip stays as it was: the input’s ground, the quiet edge, no weight of its own', () => {
    const picked = rooms[1]!;
    render(<BungalowRow lit={picked.address} onPick={() => undefined} />);
    const others = chips().filter((c) => c.getAttribute('aria-pressed') === 'false');
    expect(others).toHaveLength(rooms.length - 1);
    for (const chip of others) {
      expect(chip.style.background).toBe('var(--color-bg-input)');
      expect(chip.style.border).toBe('1px solid var(--color-border)');
      expect(chip.style.fontWeight).toBe('');
    }
  });

  it.each([
    ['no coin on the sheet yet (Buy over the home)', null],
    ['a row that lights nothing (Add with no room)', undefined],
  ] as const)('%s: nothing is filled', (_name, lit) => {
    render(<BungalowRow lit={lit} onPick={() => undefined} />);
    for (const chip of chips()) {
      expect(chip.style.background).toBe('var(--color-bg-input)');
      expect(chip.style.fontWeight).toBe('');
    }
  });
});
