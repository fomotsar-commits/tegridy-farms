import { useEffect, useState, type ComponentType } from 'react';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { safeGetItem } from '../../lib/storage';
import { noteOwnSolanaFailed, solanaWasConnectedHere, useSolanaSurface, wantOwnSolana } from '../../lib/solanaSurface';

/**
 * The top bar's own Solana connection, on pages with no Solana section.
 *
 * On a Solana page the top bar borrows the page's connection. Everywhere else
 * there was none to borrow, so the top bar's Connect could only connect
 * Ethereum (owner, 2026-10-03: the home page, the Earn list and the doors
 * should connect Solana too). This mounts one, with nothing inside it but the
 * wallet list.
 *
 * THREE RULES
 *  1. LAZY, AND NEVER ON A FIRST VISIT. This file is in the entry chunk, so it
 *     reaches the Solana code only through the import() below, and only once
 *     Solana is wanted (lib/solanaSurface.ts `ownWanted`): the visitor picked
 *     Solana in the wallet sheet, a Solana wallet connected in this tab, or
 *     one was really connected here on an earlier visit and is still saved. A
 *     visitor who never touches Solana downloads none of it, and neither does
 *     a phone visitor who only ever tapped an "Open app" row. check-dist-graph.mjs cannot see an import() that
 *     runs at mount, so e2e/topbar-wallet-sheet.spec.ts watches the network.
 *  2. ONE LIVE CONNECTION PER PAGE. It is unmounted wherever the page has, or
 *     is about to have, its own Solana section (`solanaPage`, or a page's
 *     provider already mounted). A second WalletProvider reads the saved
 *     wallet only when it mounts, so two on one page would disagree. Its
 *     unmount disconnects nothing: the page's provider reads the same saved
 *     wallet as it mounts, and reconnects without a prompt.
 *  3. A FAILED LOAD IS SAID, NOT SPUN. Offline, or a deploy that rotated the
 *     chunk's name: the store is told, and the wallet sheet says so and offers
 *     to reload the page, the one retry that works (a browser does not fetch
 *     a failed chunk or stylesheet again in the same tab). A crash inside the
 *     provider is caught here too, so it can never take the top bar down.
 *
 * An approval still open in a wallet when the route swaps this connection for
 * a page's (or back) is lost with it, and needs one more pick.
 */

/** The wallet adapter's own key (WalletProvider `localStorageKey`): set while a Solana wallet is chosen. */
const SAVED_WALLET_KEY = 'walletName';
/** A returning visitor's connection is restored once the page has settled, never in its first paint. */
const RESTORE_DELAY_MS = 1500;

function ReportFailed() {
  useEffect(() => {
    noteOwnSolanaFailed();
  }, []);
  return null;
}

/** Loads the provider's chunk, then renders it. */
function OwnSolanaProviders() {
  const [Providers, setProviders] = useState<ComponentType | null>(null);
  useEffect(() => {
    let live = true;
    // try/await, not .then(ok, failed): the bundler wraps import() in a helper
    // that also loads the chunk's stylesheet, and that helper's rejection (a
    // stylesheet that did not load) has to land in the same catch.
    void (async () => {
      try {
        const module = await import('../solana/SolanaProviders');
        if (live) setProviders(() => module.TopBarSolanaProviders);
      } catch {
        if (live) noteOwnSolanaFailed();
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return Providers ? <Providers /> : null;
}

export function TopBarSolana({ solanaPage }: { solanaPage: boolean }) {
  const { page, ownWanted, ownFailed } = useSolanaSurface();

  // A wallet connected on an earlier visit: restore it here too, so the address
  // is in the top bar on every page and not only on the Solana ones.
  useEffect(() => {
    const saved = safeGetItem(SAVED_WALLET_KEY);
    if (!solanaWasConnectedHere() || !saved || saved === 'null') return;
    const timer = setTimeout(wantOwnSolana, RESTORE_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!ownWanted || ownFailed || solanaPage || page) return null;
  return (
    <ErrorBoundary fallback={<ReportFailed />}>
      <OwnSolanaProviders />
    </ErrorBoundary>
  );
}
