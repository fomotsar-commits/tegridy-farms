import { SolanaConnectButton } from '../SolanaConnectButton';
import { CopyButton } from '../../ui/CopyButton';
import { Notice, Row } from './ui';
import type { CurveSignerState } from './useCurveSigner';

/**
 * The wallet line every action panel carries. The connect button sits INSIDE the
 * panel, not only in the top nav: between 640 and 790px wide the nav has no
 * reachable Connect at all.
 */
export function WalletNeeded({ state }: { state: CurveSignerState }) {
  if (state.kind === 'ready') {
    return <Row label="Your wallet" value={state.address} />;
  }
  if (state.kind === 'cannot-sign') {
    return (
      <div className="space-y-2">
        <Row label="Your wallet" value={state.address} />
        <Notice tone="warn">
          {state.walletName ? `${state.walletName} cannot` : 'This wallet cannot'} sign transactions here. Pick another
          wallet.
        </Notice>
        <SolanaConnectButton />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <SolanaConnectButton />
      <WalletAppHint />
    </div>
  );
}

/**
 * Under a Connect button, for a phone or tablet whose own browser has no wallet in it:
 * what to do, and this page's link to carry into the wallet app.
 */
export function WalletAppHint() {
  const here = typeof window !== 'undefined' ? window.location.href : '';
  return (
    <p className="text-white/40 text-[10px] leading-relaxed">
      On a phone or tablet with no wallet in this browser: open this page inside your wallet app&apos;s own browser
      (Phantom, Solflare or Backpack), then connect there.
      {here && (
        <>
          {' '}
          <CopyButton text={here} display="Copy this page's link" className="underline text-white/60" />
        </>
      )}
    </p>
  );
}
