import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LaunchSimulator } from './LaunchSimulator';
import { DistributionReport } from './DistributionReport';
import { BandDeltaPanel } from './BandDeltaPanel';
import { simulate, DEFAULT_STRUCTURAL, type SimInput } from '../../lib/launchSim/simulate';

const NOW = 1_800_000_000;

function simOf(rows: SimInput['rows']): ReturnType<typeof simulate> {
  return simulate({ rows, structural: { ...DEFAULT_STRUCTURAL }, bundlesModeled: false, snipersModeled: false, now: NOW });
}

describe('LaunchSimulator (render)', () => {
  it('self-gates to the instructional empty state with no allocations and shows NO band', () => {
    render(<LaunchSimulator />);
    expect(screen.getByText(/Nothing to measure yet/i)).toBeTruthy();
    // No band chip is rendered while empty.
    expect(screen.queryByText('Well-distributed')).toBeNull();
    expect(screen.queryByText('Concentrated')).toBeNull();
  });

  /**
   * A11Y-R05. The route sweep audits /launch-simulator in its RESTING state,
   * where the allocation list is empty — so four placeholder-only fields and a
   * 20px remove button sat on the first screen a real user reaches (one click
   * on "+ Add allocation") and were reported by nothing. This is that click.
   */
  it('names every field in an added allocation row', () => {
    render(<LaunchSimulator />);
    fireEvent.click(screen.getByRole('button', { name: /Add allocation/i }));
    expect(screen.getByRole('textbox', { name: 'Allocation label' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Token amount' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Allocation category' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Cluster tag' })).toBeTruthy();
    const remove = screen.getByRole('button', { name: /Remove allocation row/i });
    expect(remove.className).toContain('min-h-[44px]');
    expect(remove.className).toContain('min-w-[44px]');
  });

  it('loading an example populates rows and renders a distribution band', () => {
    render(<LaunchSimulator />);
    fireEvent.click(screen.getByRole('button', { name: 'Fair launch' }));
    // The empty state is gone and a report is now shown.
    expect(screen.queryByText(/Nothing to measure yet/i)).toBeNull();
    expect(screen.getByText(/Effective holders/i)).toBeTruthy();
  });
});

describe('DistributionReport (render)', () => {
  it('renders the effective-holder headline and self-gates behavioural signals to "not measured"', () => {
    const r = simOf([{ id: 'a', label: 'x', amount: '100', category: 'auto' }, { id: 'b', label: 'y', amount: '100', category: 'auto' }]);
    render(<DistributionReport analysis={r.analysis} />);
    expect(screen.getByText(/effective holder count|equally-sized holders/i)).toBeTruthy();
    // bundles/snipers were not modelled → shown as not measured, never a fake 0%.
    expect(screen.getAllByText(/not measured/i).length).toBeGreaterThan(0);
  });
});

describe('BandDeltaPanel (render)', () => {
  it('surfaces a hard blocker with its fix when a live mint authority forces a worse floor', () => {
    const r = simulate({
      rows: Array.from({ length: 40 }, (_, i) => ({ id: String(i), label: 'h', amount: '100', category: 'auto' as const })),
      structural: { ...DEFAULT_STRUCTURAL, knownSafeTemplate: false, canMint: true },
      bundlesModeled: false,
      snipersModeled: false,
      now: NOW,
    });
    render(<BandDeltaPanel targets={r.bandTargets} />);
    const blockers = screen.getAllByText(/Hard blockers/i);
    expect(blockers.length).toBeGreaterThan(0);
    // the fix line is present
    expect(screen.getAllByText(/renounce the mint authority/i).length).toBeGreaterThan(0);
  });
});
