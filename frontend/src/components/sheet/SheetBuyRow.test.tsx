// Island answer thirty-four: the picked coin is filled, so at a phone's width it reads as the choice and not
// as one more line. An edge alone read as faint. The row of room chips is gone (owner, 2026-11-11): the rooms
// are in the coin chip's list, and there the picked one is filled.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SheetRoomRow } from './SheetBuyRow';
import { sheetRooms } from '../../lib/sheet';

const rooms = sheetRooms();
const flat = (s: string) => s.replace(/\s+/g, '');
const open = () => {
  fireEvent.click(screen.getByTestId('sheet-coin-chip'));
  return within(screen.getByTestId('sheet-coin-list'));
};
const button = (o: HTMLElement) => within(o).getByRole('button');

describe('the coin list’s picked coin', () => {
  it('the picked coin is filled: its ground, a bright edge, its word at 700', () => {
    const picked = rooms[1]!;
    render(<SheetRoomRow room={picked} all={false} onPick={() => undefined} onAll={() => undefined} />);
    const option = open().getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')!;
    expect(option).toHaveTextContent(picked.symbol);
    const b = button(option);
    expect(flat(b.style.background)).toBe('rgba(139,92,246,0.24)');
    expect(flat(b.style.border)).toBe('1pxsolidrgba(167,139,250,0.95)');
    expect(b.style.fontWeight).toBe('700');
    expect(b).toHaveClass('text-white');
  });

  it('every other coin stays as it was: no ground, no edge, no weight of its own', () => {
    const picked = rooms[1]!;
    render(<SheetRoomRow room={picked} all={false} onPick={() => undefined} onAll={() => undefined} />);
    const others = open().getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'false');
    // Every other room, and Every pool.
    expect(others).toHaveLength(rooms.length);
    for (const o of others) {
      const b = button(o);
      expect(b.style.background).toBe('');
      expect(b.style.fontWeight).toBe('');
    }
  });

  it('no coin on the sheet yet: nothing is filled', () => {
    render(<SheetRoomRow room={null} all={false} onPick={() => undefined} onAll={() => undefined} />);
    for (const o of open().getAllByRole('option')) {
      expect(o).toHaveAttribute('aria-selected', 'false');
      expect(button(o).style.background).toBe('');
    }
  });
});
