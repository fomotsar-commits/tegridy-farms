/**
 * The host of the top bar's own Solana connection (TopBarSolana.tsx): when it
 * loads the Solana code, when it must not, and when it steps aside. The
 * provider itself is a stand-in here; the real one is covered by
 * components/solana/SolanaProviders.surface.test.tsx and the e2e.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const fake = vi.hoisted(() => ({ renders: 0, throwOnRender: false }));
vi.mock('../solana/SolanaProviders', () => {
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
  SOLANA_HANDOFF_PARAM,
  getSolanaSurfaceState,
  noteSolanaHandoffArrival,
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
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
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

  it('restores a wallet connected on an earlier visit, but only once the page has settled', async () => {
    vi.useFakeTimers();
    localStorage.setItem('walletName', JSON.stringify('Trust'));
    localStorage.setItem('tegridy-solana-restore', '1');
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

  // A page opened by an "Open app" press in another browser (lib/solanaSurface.ts):
  // that visitor is waiting on the connect, so the Solana code loads at once,
  // on a first visit, with nothing saved. MUTATION CHECK: drop the
  // solanaHandoffPending() branch in TopBarSolana's effect; this must fail.
  it('mounts at once on a page opened by a hand-off into a wallet app', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
    );
    window.history.replaceState(null, '', `/?${SOLANA_HANDOFF_PARAM}=1`);
    noteSolanaHandoffArrival();
    render(<TopBarSolana solanaPage={false} />);
    expect(getSolanaSurfaceState().ownWanted).toBe(true);
    await settle();
    expect(await screen.findByTestId('own-solana')).toBeTruthy();
  });

  it.each([
    ['no wallet is saved', null, '1'],
    ['the adapter saved "none"', 'null', '1'],
    // A phone visitor who tapped an "Open app" row: the name is saved, and
    // that wallet can never connect in this browser.
    ['a wallet name is saved but none ever connected here', JSON.stringify('Trust'), null],
    ['the wallet was disconnected', JSON.stringify('Trust'), '0'],
  ])('does not restore where %s, however long the page stays open', (_label, saved, connectedHere) => {
    vi.useFakeTimers();
    if (saved !== null) localStorage.setItem('walletName', saved);
    if (connectedHere !== null) localStorage.setItem('tegridy-solana-restore', connectedHere);
    render(<TopBarSolana solanaPage={false} />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(getSolanaSurfaceState().ownWanted).toBe(false);
    expect(screen.queryByTestId('own-solana')).toBeNull();
  });

  it('reports a crash inside it instead of taking the top bar down, and stays unmounted', async () => {
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
    expect(getSolanaSurfaceState()).toMatchObject({ ownFailed: true });
    expect(screen.getByText('the top bar')).toBeTruthy();
    expect(screen.queryByTestId('own-solana')).toBeNull();
    // Asking again in the same tab cannot fetch it again: nothing mounts.
    fake.throwOnRender = false;
    act(() => wantOwnSolana());
    await settle();
    expect(getSolanaSurfaceState().ownFailed).toBe(true);
    expect(screen.queryByTestId('own-solana')).toBeNull();
    // A Solana page that mounts its own section proves the code loads: once
    // that page is left, the top bar's own connection mounts again.
    const page = {};
    act(() => setSolanaSurface(page, { open: vi.fn(), address: null, connecting: false }));
    expect(getSolanaSurfaceState().ownFailed).toBe(false);
    act(() => setSolanaSurface(page, null));
    await settle();
    expect(await screen.findByTestId('own-solana')).toBeTruthy();
  });
});
