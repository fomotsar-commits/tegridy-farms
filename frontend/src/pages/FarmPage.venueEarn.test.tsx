// The venue's own /farm header. "Held time" is the island's word for heat, and the island
// reads only two of the pools listed here, so the header speaks of lock length alone.
// Real storage with nothing chosen: the same predicate the app runs puts us in the venue.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

vi.mock('../components/farm/VenuePoolIndex', () => ({ VenuePoolIndex: () => <div data-testid="pool-index" /> }));
vi.mock('../components/farm/HarvestCard', () => ({ HarvestCard: () => null }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => undefined }));

import FarmPage from './FarmPage';
import { BUNGALOW_STORAGE_KEY } from '../lib/bungalows';
import { MAX_BOOST_BPS, MAX_LOCK_DURATION, MIN_BOOST_BPS, MIN_LOCK_DURATION } from '../lib/constants';
import { planAspect } from '../lib/isoPlan';
import { venuePoolRows } from '../lib/venuePools';

beforeEach(() => {
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
});

const renderPage = () => render(
  <MemoryRouter>
    <FarmPage />
  </MemoryRouter>,
);

describe("the venue's Earn header", () => {
  it('says what a lock earns, without calling it held time', () => {
    renderPage();
    const header = screen.getByRole('heading', { level: 1, name: 'Earn' }).closest('header')!;
    expect(header.textContent).toContain('The longer you lock, the larger your share of the same rewards.');
    expect(header.textContent).not.toMatch(/held time/i);
    expect(screen.getByTestId('pool-index')).toBeTruthy();
  });

  it('sizes the site model by the screen’s height as well as the sheet’s width, at the drawing’s own proportions', () => {
    renderPage();
    const model = screen.getByTestId('earn-site-model').parentElement!;
    expect(model.style.getPropertyValue('--model-w')).toBe(`min(84%, calc(66vh * ${planAspect(venuePoolRows()).toFixed(3)}))`);
    // And its width is that value from 768px up.
    expect(model.className.split(/\s+/)).toContain('md:w-[var(--model-w)]');
  });

  it('gives the small print a row of its own under the model and the title, so opening it never lifts the title onto the houses', () => {
    renderPage();
    const header = screen.getByRole('heading', { level: 1, name: 'Earn' }).closest('header')!;
    const fine = screen.getByText('How it works').closest('details')!;
    expect(fine.parentElement).toBe(header);
    expect(fine.className).toContain('md:[grid-area:2/1]');
    const title = screen.getByRole('heading', { level: 1, name: 'Earn' }).parentElement!;
    expect(title.contains(fine)).toBe(false);
    expect(title.className).toContain('md:[grid-area:1/1]');
    expect(screen.getByTestId('earn-site-model').parentElement!.className).toContain('md:[grid-area:1/1]');
  });

  it('a press on a house enters its bungalow, as its door on the front page does', () => {
    const at: string[] = [];
    function Where() {
      at.push(useLocation().pathname);
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/earn']}>
        <Routes>
          <Route path="/earn" element={<FarmPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    const room = venuePoolRows()[0]!;
    fireEvent.click(screen.getByTestId('earn-site-model').querySelector(`[data-pool="${room.id}"] [data-hit=""]`)!);
    expect(at.at(-1)).toBe(`/${room.id}`);
  });

  it('on a phone gives the model a row of its own under the title, the sheet’s full width, never behind the word', () => {
    renderPage();
    const model = screen.getByTestId('earn-site-model').parentElement!;
    const classes = model.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['max-md:order-2', 'max-md:-mx-4']));
    expect(classes.filter((c) => /^max-md:(absolute|-z-|opacity-|w-|\[mask)/.test(c))).toEqual([]);
    expect(screen.getByRole('heading', { level: 1, name: 'Earn' }).closest('header')!.className).toContain('max-md:flex-col');
    expect(screen.getByText('How it works').closest('details')!.className).toContain('max-md:order-3');
  });

  it('gives the ladder’s two ends in the small print as the contract sets them', () => {
    renderPage();
    expect(MIN_LOCK_DURATION).toBe(7 * 86_400);
    expect(MAX_LOCK_DURATION).toBe(4 * 365 * 86_400);
    const fine = screen.getByText('How it works').closest('details')!;
    const words = (fine.textContent ?? '').replace(/\s+/g, ' ');
    expect(words).toContain(`${(MIN_BOOST_BPS / 10_000).toFixed(2)}× at seven days to ${(MAX_BOOST_BPS / 10_000).toFixed(2)}× at four years`);
  });
});
