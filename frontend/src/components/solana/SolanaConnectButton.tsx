// Polyfill MUST load before any @solana/* import — keep this first.
import '../../lib/solanaPolyfill';
import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useSolanaConnect } from './useSolanaConnect';
import { waitedOnWalletLabel } from '../../lib/solanaWalletOrder';
import { SOLANA_CONNECT_WAIT_NOTICE_MS } from '../../lib/solanaSurface';

/**
 * The connect CTA for the swap and limit tabs. Click behavior comes from
 * useSolanaConnect (connect() when a wallet is already selected — that call
 * carries the install-page and iOS deep-link flows; the picker modal
 * otherwise). The hint below the button names the one state that would
 * otherwise read as "I clicked Phantom and nothing happened": a selected
 * wallet whose extension is not installed in this browser.
 *
 * NEVER SWITCHED OFF WHILE IT WAITS (owner, 2026-10-03: "it won't even
 * recognize my phantom wallet"). A connect lasts as long as the wallet takes to
 * answer, and a locked wallet, or an approval window that opened where nobody
 * saw it, takes for ever. This button was disabled for that whole wait and said
 * only "Connecting…", so nothing on the page could reach the wallet list. A
 * press while it waits now opens the list (useSolanaConnect does that when a
 * connect is in flight), and after a few seconds the line below names the
 * wallet and says what to do. The wait itself is never cancelled: a person
 * reading an approval prompt must not have it pulled away
 * (components/ui/WalletConnectWatchdog.tsx is the Ethereum side of this).
 */
export function SolanaConnectButton() {
  const { wallet, connecting, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const openConnect = useSolanaConnect();
  const notInstalled =
    !connected && !connecting && wallet?.readyState === WalletReadyState.NotDetected;

  // The wait in progress: the wallet's name while a connect runs, null otherwise.
  // The wallet is part of it because `connecting` alone does not mark a new
  // wait: a wallet picked while another is being waited on takes over with
  // `connecting` true throughout (WalletProvider ends one wait and starts the
  // next in the same pass), and this line then said "Still waiting for
  // Backpack" the instant Backpack was picked.
  const wait = connecting ? (wallet?.adapter.name ?? '') : null;
  const [slow, setSlow] = useState(false);
  const [tracked, setTracked] = useState(wait);
  // Reset during render (as the watchdog does): each wait starts from nothing.
  if (wait !== tracked) {
    setTracked(wait);
    setSlow(false);
  }
  useEffect(() => {
    if (wait === null) return;
    const timer = window.setTimeout(() => setSlow(true), SOLANA_CONNECT_WAIT_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [wait]);
  // Named as its row in the list names it. Null for WalletConnect, which has
  // no app to open and nothing to unlock: no notice then, as in the list.
  const waitingFor = wallet ? waitedOnWalletLabel(wallet.adapter.name) : 'your wallet';

  return (
    <>
      <button
        type="button"
        onClick={openConnect}
        aria-busy={connecting || undefined}
        className={`btn-primary w-full py-2.5 text-[14px]${connecting ? ' opacity-60' : ''}`}
      >
        {connecting ? 'Connecting…' : 'Connect Solana Wallet'}
      </button>
      {connecting && slow && waitingFor && (
        <p role="status" className="mt-2 text-center text-[11px] text-amber-300">
          Still waiting for {waitingFor}. Open {waitingFor}: it may be locked, or waiting for you to approve
          this site. Or{' '}
          <button type="button" onClick={() => setVisible(true)} className="underline font-semibold">
            pick another wallet
          </button>
          .
        </p>
      )}
      {notInstalled && (
        <p className="mt-2 text-center text-[11px] text-amber-300">
          {wallet.adapter.name} isn&apos;t installed in this browser.{' '}
          <a
            href={wallet.adapter.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline font-semibold"
          >
            Get {wallet.adapter.name}
          </a>{' '}
          or{' '}
          <button type="button" onClick={() => setVisible(true)} className="underline font-semibold">
            pick another wallet
          </button>
          .
        </p>
      )}
    </>
  );
}
