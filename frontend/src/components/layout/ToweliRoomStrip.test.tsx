import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToweliRoomStrip } from './ToweliRoomStrip';

describe('ToweliRoomStrip (wave seven, row Q)', () => {
  it('names the room and hands over the way back', () => {
    const { container } = render(
      <MemoryRouter>
        <ToweliRoomStrip />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'TOWELI room' }).getAttribute('href')).toBe('/toweli');
    const back = screen.getByRole('link', { name: 'Back to memetics.finance' });
    expect(back.getAttribute('href')).toBe('/');
    expect(back.className).toContain('min-h-[44px]');
    // In the flow, never over the page.
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
      expect(el.className).not.toMatch(/(^|\s)(fixed|sticky)(\s|$)/);
    }
  });
});
