// The page-wide note that a staking write landed (lib/harvest/stakesChanged.ts), and the
// parts of the site that must hear it. Harvest sits on the Earn list, every pool's page and
// the dashboards (owner, 2026-10-30), beside cards that claim the same rewards: a part left
// off this list keeps showing what a harvest already paid.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderHook } from '@testing-library/react';
import { noteStakesChanged, useOnStakesChanged } from './stakesChanged';

describe('noteStakesChanged / useOnStakesChanged', () => {
  it('reaches every other listener, never the writer itself', () => {
    const a = {};
    const b = {};
    const heardA = vi.fn();
    const heardB = vi.fn();
    const ha = renderHook(() => useOnStakesChanged(a, heardA));
    const hb = renderHook(() => useOnStakesChanged(b, heardB));
    noteStakesChanged(a);
    expect(heardA).not.toHaveBeenCalled();
    expect(heardB).toHaveBeenCalledTimes(1);
    ha.unmount();
    hb.unmount();
    noteStakesChanged({});
    expect(heardB).toHaveBeenCalledTimes(1);
  });

  it('calls the newest callback, not the one from the first render', () => {
    const me = {};
    const first = vi.fn();
    const second = vi.fn();
    const h = renderHook(({ fn }) => useOnStakesChanged(me, fn), { initialProps: { fn: first } });
    h.rerender({ fn: second });
    noteStakesChanged({});
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    h.unmount();
  });
});

describe('who listens, and who says so', () => {
  const src = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf8');
  // Every part that shows a staking reward Harvest can claim re-reads when it runs.
  const LISTENERS = [
    'components/farm/HarvestCard.tsx',
    'components/bungalow/SolanaLadderPoolLive.tsx',
    'components/bungalow/LighthousePoolLive.tsx',
    'components/bungalow/EvmLadderPoolLive.tsx',
    'components/bungalow/EvmLighthousePoolLive.tsx',
    'components/bungalow/BungalowDashboardPanel.tsx',
    'components/bungalow/EvmBungalowDashboardPanel.tsx',
    'components/IslandDashboard.tsx',
  ];
  // The writers that have no 30 s poll of their own: Harvest and the Solana cards. The EVM
  // cards and Harvest's EVM reads each poll every 30 s (useEvmHarvest).
  const WRITERS = [
    'components/farm/HarvestCard.tsx',
    'components/bungalow/SolanaLadderPoolLive.tsx',
    'components/bungalow/LighthousePoolLive.tsx',
  ];

  it.each(LISTENERS)('%s re-reads on a staking write', (f) => {
    expect(src(f)).toMatch(/useOnStakesChanged\(me, /);
  });

  it.each(WRITERS)('%s says so after its own write', (f) => {
    expect(src(f)).toMatch(/noteStakesChanged\(me\)/);
  });

  it('the Streamflow card does it in both of its write paths: the full card and the members-only strip', () => {
    const s = src('components/bungalow/LighthousePoolLive.tsx');
    expect(s.match(/useOnStakesChanged\(me, reread\)/g)).toHaveLength(2);
    expect(s.match(/noteStakesChanged\(me\)/g)).toHaveLength(2);
  });

  it('Harvest’s EVM reads poll as the EVM cards do', () => {
    expect(src('hooks/useEvmHarvest.ts')).toMatch(/refetchInterval: 30_000/);
  });
});
