/**
 * The host of the top bar's own Solana connection (TopBarSolana.tsx): when it
 * loads the Solana code, when it must not, and when it steps aside. The
 * provider itself is a stand-in here; the real one is covered by
 * components/solana/SolanaProviders.surface.test.tsx and the e2e.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const fake = vi.hoisted(() => ({ loads: 0, renders: 0, throwOnRender: false }));
vi.mock('../solana/SolanaProviders', () => {
  fake.loads += 1;
  return {
    TopBarSolanaProviders: () => {
      if (fake.throwOnRender) throw new Error('the Solana chunk did not load');
      fake.renders += 1;
      return <div data-testid="own-solana" />;
    },
  };
});
vi.mock('../../lib/errorReporting', () => ({ reportError: vi.fn() }));

import { TopBarSolana } from './TopBarSolana';
import {
  getSolanaSurfaceState,
  resetSolanaSurfaceForTests,
  setSolanaSurface,
  wantOwnSolana,
} from '../../lib/solanaSurface';

/** Lets the lazy import and its Suspense settle. */
const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

afterEach(() => {
  cleanup();
  act(() => resetSolanaSurfaceForTests());
  localStorage.clear();
  fake.throwOnRender = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TopBarSolana: the top bar's own Solana connection", () => {
  it('is not mounted on a first visit: nothing asked for Solana and no wallet is saved', async () => {
    const before = fake.renders;
    render(<TopBarSolana solanaPage={false} />);
    await settle();
    expect(screen.queryByTestId('own-solana')).toBeNull();
    expect(fake.renders).toBe(before);
    expect(getSolanaSurfaceState().ownWanted).toBe(false);
  });

  it('mounts once the visitor asks for Solana', async () => {
    render(<TopBarSolana solanaPage={false} />);
    act(() => wantOwnSolana());
    await settle();
    expect(await screen.findByTestId('own-solana')).toBeTruthy();
  });

  it('is never mounted on a Solana page: the page brings its own connection', async () => {
    act(() => wantOwnSolana());
    render(<TopBarSolana solanaPage />);
    await settle();
    expect(screen.queryByTestId('own-solana')).toBeNull();
  });

  // One live connection per page: two providers read the saved wallet at
  // different moments and disagree (SolanaPoolStack.tsx).
  it("steps aside the moment a page's own connection mounts, and comes back when it leaves", async () => {
    render(<TopBarSolana solanaPage={false} />);
    act(() => wantOwnSolana());
    await settle();
    expect(await screen.findByTestId('own-solana')).toBeTruthy();
    const page = {};
    act(() => setSolanaSurface(page, { open: vi.fn(), address: null, connecting: false }));
    expect(screen.queryByTestId('own-solana')).toBeNull();
    act(() => setSolanaSurface(page, null));
    await settle();
    expect(await screen.findByTestId('own-solana')).toBeTruthy();
  });

  it('restores a wallet saved on an earlier visit, but only once the page has settled', async () => {
    vi.useFakeTimers();
    localStorage.setItem('walletName', JSON.stringify('Trust'));
    render(<TopBarSolana solanaPage={false} />);
    act(() => {
      vi.advanceTimersByTime(1_499);
    });
    expect(getSolanaSurfaceState().ownWanted).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getSolanaSurfaceState().ownWanted).toBe(true);
  });

  it('does not restore where no wallet is saved, or where the adapter saved "none"', () => {
    vi.useFakeTimers();
    localStorage.setItem('walletName', 'null');
    render(<TopBarSolana solanaPage={false} />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(getSolanaSurfaceState().ownWanted).toBe(false);
  });

  it('reports a load that failed instead of taking the top bar down, and a retry loads it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.throwOnRender = true;
    render(
      <div>
        <span>the top bar</span>
        <TopBarSolana solanaPage={false} />
      </div>,
    );
    act(() => wantOwnSolana());
    await settle();
    expect(getSolanaSurfaceState()).toMatchObject({ ownFailed: true, ownAttempt: 0 });
    expect(screen.getByText('the top bar')).toBeTruthy();
    expect(screen.queryByTestId('own-solana')).toBeNull();
    // The wallet sheet's Solana row asks again.
    fake.throwOnRender = false;
    act(() => wantOwnSolana());
    await settle();
    expect(getSolanaSurfaceState()).toMatchObject({ ownFailed: false, ownAttempt: 1 });
    expect(await screen.findByTestId('own-solana')).toBeTruthy();
  });
});
