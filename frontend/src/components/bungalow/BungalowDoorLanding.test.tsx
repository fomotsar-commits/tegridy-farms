import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BungalowDoorLanding } from './BungalowDoorLanding';
import { BUNGALOWS, BUNGALOW_COUNT } from '../../lib/bungalows';

// /nb1 is the island's next open lot, not an unmarked bungalow. The island labels a lot
// "Lot 13, for the next community" (the number after its bungalows) and heads its harbor
// "How a community gets a bungalow here."
const LOT = BUNGALOWS.find((b) => b.chain === 'tbd')!;

function renderLot() {
  return render(
    <MemoryRouter>
      <BungalowDoorLanding bungalow={LOT} />
    </MemoryRouter>,
  );
}

describe('the open lot speaks as the island’s lot', () => {
  it('describes itself with the island’s lot label, numbered after the bungalows', () => {
    renderLot();
    const description = document.querySelector('meta[name="description"]')?.getAttribute('content');
    expect(description).toBe(`Lot ${BUNGALOW_COUNT + 1}, for the next community.`);
    expect(description).toBe('Lot 13, for the next community.');
  });

  it('sends a visitor to the island’s harbor, in the island’s words', () => {
    renderLot();
    const link = screen.getByRole('link', { name: /How a community gets a bungalow here\./ });
    expect(link.getAttribute('href')).toBe('https://memetics.wtf/#p-harbor');
    expect(link.textContent?.trim()).toBe('How a community gets a bungalow here.');
    expect(document.body.textContent).not.toContain('one bungalow unmarked');
  });

  it('heads the lot with the island’s lot label, and says nobody is building on it', () => {
    renderLot();
    expect(document.querySelector('h1')?.textContent).toBe('Unmarked. Lot 13, for the next community.');
    expect(document.body.textContent).not.toMatch(/someone is building here/i);
    // The lot's paragraph is the harbor link alone.
    const link = screen.getByRole('link', { name: /How a community gets a bungalow here\./ });
    expect(link.parentElement?.textContent?.trim()).toBe('How a community gets a bungalow here.');
  });
});
