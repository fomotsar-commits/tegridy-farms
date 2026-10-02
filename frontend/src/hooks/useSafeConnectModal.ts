import { useConnectModal } from '@rainbow-me/rainbowkit';

/**
 * RainbowKit's connect-modal opener, or `undefined` when there is none to call.
 *
 * Hoisted from nakamigos/contexts/WalletContext.jsx, where b19a2a59 ("Fix iPhone
 * Safari crash") added it because the raw hook "can throw on some mobile browsers".
 * The try/catch is kept as it was. In the pinned RainbowKit (2.2.11) the hook is a
 * bare useContext, so the undefined below is the case that actually occurs.
 *
 * `undefined` is not only the catch branch. RainbowKit types the opener
 * `(() => void) | undefined`: its ModalContext default carries no opener, so any
 * render outside a RainbowKitProvider gets none, and inside one it is set only
 * while the connection status is "disconnected" or "unauthenticated".
 *
 * So a caller that labels a button "Connect Wallet" must DISABLE it when this
 * returns undefined. `onClick={undefined}` on an enabled button is the same dead
 * control as a disabled one, except that it no longer looks dead.
 */
export function useSafeConnectModal(): (() => void) | undefined {
  try {
    return useConnectModal()?.openConnectModal;
  } catch {
    return undefined;
  }
}
