import { lazy, Suspense, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { noteOwnSolanaFailed } from '../lib/solanaSurface';

const HomeModules = lazy(() => import('./HomeModules'));

/** The pages the cards come from, when the cards' code did not load. */
function ModulesUnloaded() {
  // The cards' connection is the top bar's Solana one here (lib/routeVoice.ts hasMixedSolanaSection):
  // its wallet sheet says the load failed.
  useEffect(() => {
    noteOwnSolanaFailed();
  }, []);
  return (
    <p className="mt-2 mb-2 flex flex-wrap gap-x-4 text-[13px]">
      <Link to="/solana" className="underline underline-offset-4" style={{ color: 'var(--color-kyle)' }}>Swap</Link>
      <Link to="/earn/bayla" className="underline underline-offset-4" style={{ color: 'var(--color-kyle)' }}>Stake BAYLA</Link>
      <Link to="/solana-lp" className="underline underline-offset-4" style={{ color: 'var(--color-kyle)' }}>Add liquidity</Link>
    </p>
  );
}

/**
 * The venue's cards, swap, stake and add liquidity (owner, 2026-10-16), in their own row: under
 * the home's hero, under the island lobby's title, and under BAYLA's hero on her door (owner,
 * 2026-10-19: "put them there again", then "on here"). Lazy: the Solana wallet stack loads after
 * the page has painted. If its code cannot load, the pages they come from are linked. Its own
 * file, so the lobby does not load the home's heat reader with it.
 */
export function VenueCards() {
  return (
    <ErrorBoundary fallback={() => <ModulesUnloaded />}>
      <Suspense fallback={null}>
        <HomeModules />
      </Suspense>
    </ErrorBoundary>
  );
}
