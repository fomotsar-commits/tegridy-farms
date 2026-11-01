// @vitest-environment jsdom
/**
 * One Connection for the life of SolanaProviders. ConnectionProvider makes a new Connection
 * whenever its `config` is a new object, and every card's reads re-run on a new Connection, so
 * a page that re-renders must keep handing out the same one. Written inline, it did not: the
 * home's ladder card read its pool and vaults every few seconds instead of every 45, and phones
 * and iPads got "Couldn't read" from the proxy's per-minute limit (2026-10-31).
 */
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { Connection } from '@solana/web3.js';
import { SolanaProviders } from './SolanaProviders';
import { resetSolanaSurfaceForTests } from '../../lib/solanaSurface';
import { stopLeftoverIntervals } from '../../test/stopLeftoverIntervals';

stopLeftoverIntervals();
afterEach(() => {
  cleanup();
  act(() => resetSolanaSurfaceForTests());
  vi.unstubAllEnvs();
});

it('hands every card the same Connection however often the page around it re-renders', () => {
  vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', '');
  const seen: Connection[] = [];
  function Card() {
    seen.push(useConnection().connection);
    return null;
  }
  let rerender = () => {};
  function Page() {
    const [n, setN] = useState(0);
    rerender = () => setN((x) => x + 1);
    return (
      <SolanaProviders>
        <Card />
        <span>{n}</span>
      </SolanaProviders>
    );
  }
  render(<Page />);
  act(() => rerender());
  act(() => rerender());
  expect(seen.length).toBeGreaterThanOrEqual(3);
  expect(new Set(seen).size).toBe(1);
});
