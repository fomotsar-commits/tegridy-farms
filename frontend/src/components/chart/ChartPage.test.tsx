import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils/render';
import { isIndexerConfigured } from '../../lib/indexer/client';
import ChartPage from './ChartPage';

// The state this build actually ships in. VITE_INDEXER_URL is unset, so every
// read on this page fails closed — and the failure mode a price chart has is
// uniquely bad: an axis with no candles on it is read as a pool that did not
// trade. These tests pin that no plot is drawn at all, and that the page says
// why in words a reader can act on.

describe('ChartPage with no indexer configured', () => {
  it('is testing the state the deployment is in (guards the guard)', () => {
    expect(isIndexerConfigured()).toBe(false);
  });

  it('draws no SVG whatsoever', () => {
    const { container } = renderWithProviders(<ChartPage />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('says nothing was asked and why, rather than blaming the reader for not picking a pool', () => {
    renderWithProviders(<ChartPage />);
    expect(screen.getByText('No pool to chart')).toBeInTheDocument();
    expect(screen.getByText(/No pool could be read, so no candles were requested/)).toBeInTheDocument();
    expect(
      screen.getByText(/neither statement is about whether this venue trades/),
    ).toBeInTheDocument();
  });

  it('offers no pool rather than an empty pool list that reads as "no pools exist"', () => {
    renderWithProviders(<ChartPage />);
    expect(
      screen.getByText(/This says nothing about which pools exist|no indexer configured/i),
    ).toBeInTheDocument();
    // No pool buttons at all — an empty picker with a heading over it reads as
    // a venue with no pools, which is a claim about the whole factory.
    expect(within(screen.getByRole('region', { name: 'Pool' })).queryAllByRole('button')).toEqual([]);
  });

  it('states up front that a bucket with no trade is drawn as a gap', () => {
    renderWithProviders(<ChartPage />);
    expect(
      screen.getByText(/will never draw a candle for a price that was not paid/i),
    ).toBeInTheDocument();
  });

  it('does not imply anything refreshes on its own — the venue runs no keeper', () => {
    renderWithProviders(<ChartPage />);
    expect(screen.getByText(/there is no keeper and no stream behind it/i)).toBeInTheDocument();
  });
});
