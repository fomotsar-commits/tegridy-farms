import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';

/**
 * WALLET-02 — surface a stalled wallet connection instead of spinning forever.
 *
 * RainbowKit renders "Opening MetaMask… / Confirm connection in the extension"
 * and then waits on the connector's promise with no timeout and no error path.
 * If the wallet never answers, that spinner runs until the user gives up —
 * which is exactly what a stuck extension looks like from the outside.
 *
 * Reproduced live on 2026-08-02: read-only calls (`eth_accounts`,
 * `wallet_getPermissions`) answered in ~7ms, but `wallet_requestPermissions` —
 * the one call that has to raise MetaMask's approval popup — never settled, on
 * two separate origins. MetaMask allows only ONE notification window at a time
 * and queues later requests behind it silently, so once that window is stuck
 * every subsequent attempt hangs with no error event to react to.
 *
 * This watchdog does NOT abort the connection: a user legitimately reading an
 * approval prompt should never have it cancelled out from under them. It only
 * adds an advisory notice once the wait has clearly stopped being normal, and
 * points at the fix. The connect promise is left alone to resolve if it ever
 * does.
 *
 * Watches `useAccount().status`, which is config-level shared state set by
 * wagmi's `connect` action, so it sees connections started by RainbowKit's
 * modal, by `<ConnectButton>`, or by any other caller. Deliberately ignores
 * `reconnecting` — that fires on every page load for a returning user and is
 * expected to be slow.
 */
export const WALLET_STALL_NOTICE_MS = 20_000;

/** Sits above RainbowKit's modal, which pins itself at 2147483646. */
const ABOVE_RAINBOWKIT_MODAL = 2147483647;

export function WalletConnectWatchdog() {
  const { status } = useAccount();
  const [stalled, setStalled] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [trackedStatus, setTrackedStatus] = useState(status);

  // R007 Pattern B — reset during render rather than from an effect, so a
  // status change doesn't cost a second render pass. Each fresh connection
  // attempt starts from a clean slate, including one the user dismissed.
  if (status !== trackedStatus) {
    setTrackedStatus(status);
    setStalled(false);
    setDismissed(false);
  }

  useEffect(() => {
    if (status !== 'connecting') return;
    const timer = window.setTimeout(() => setStalled(true), WALLET_STALL_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  if (status !== 'connecting' || !stalled || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-0 right-0 bottom-0 px-4 pb-4 md:pb-6"
      style={{
        zIndex: ABOVE_RAINBOWKIT_MODAL,
        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
        paddingRight: 'max(1rem, env(safe-area-inset-right))',
        paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
      }}
    >
      <div
        className="mx-auto max-w-2xl rounded-2xl border p-4 md:p-5 shadow-2xl backdrop-blur-md flex flex-col md:flex-row md:items-center gap-3 md:gap-4"
        style={{
          background: 'rgba(13, 21, 48, 0.96)',
          borderColor: 'var(--color-purple-20)',
        }}
      >
        <div className="flex-1 text-[13px] md:text-sm leading-relaxed text-white/90">
          <p className="font-semibold mb-1">Your wallet hasn&apos;t responded yet.</p>
          <p className="text-white/70">
            If no approval window opened, your wallet extension may have a stuck popup
            queued behind this one. Open the extension from your browser toolbar and
            clear any pending request — or disable and re-enable it, then reload this
            page and try again.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="btn-secondary shrink-0 text-[12px] md:text-[13px] px-3 md:px-4 py-1.5"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
