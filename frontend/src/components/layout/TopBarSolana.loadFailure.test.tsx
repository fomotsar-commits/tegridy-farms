/**
 * TopBarSolana when the Solana code does not load at all: offline, or a tab
 * left open across a deploy that renamed the chunk. The import() itself
 * rejects. (The bundler's wrapper around import() rejects the same way when
 * only the chunk's stylesheet fails, which is why the host awaits it in a
 * try: a `.then(ok, failed)` on the inner import never saw that one, and the
 * wallet sheet said "Loading Solana wallets…" for ever.)
 *
 * In its own file: the stand-in below rejects on EVERY import, and a module
 * mock is evaluated once per file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../solana/SolanaProviders', () => {
  throw new Error('the Solana chunk did not load');
});

import { TopBarSolana } from './TopBarSolana';
import { getSolanaSurfaceState, resetSolanaSurfaceForTests, wantOwnSolana } from '../../lib/solanaSurface';

afterEach(() => {
  cleanup();
  act(() => resetSolanaSurfaceForTests());
  localStorage.clear();
});

describe('TopBarSolana: the Solana code did not load', () => {
  it('reports the rejected import(), mounts nothing, and leaves the top bar up', async () => {
    render(
      <div>
        <span>the top bar</span>
        <TopBarSolana solanaPage={false} />
      </div>,
    );
    expect(getSolanaSurfaceState().ownFailed).toBe(false);
    act(() => wantOwnSolana());
    await waitFor(() => expect(getSolanaSurfaceState().ownFailed).toBe(true));
    expect(getSolanaSurfaceState()).toMatchObject({ surface: null, ownWanted: true });
    expect(screen.getByText('the top bar')).toBeTruthy();
  });
});
