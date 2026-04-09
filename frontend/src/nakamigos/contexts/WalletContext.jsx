/**
 * WalletContext Bridge — delegates to the parent Tegriddy Farms wagmi/RainbowKit providers.
 * Nakamigos components call useWallet() / useWalletState() etc. as before,
 * but under the hood this reads from the already-mounted WagmiProvider.
 */
import { createContext, useContext, useMemo, useCallback } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { mainnet } from "wagmi/chains";
import { useConnectModal } from "@rainbow-me/rainbowkit";

// ═══ Wallet Contexts (same shape as the original) ═══
const WalletStateContext = createContext(undefined);
const WalletActionsContext = createContext(undefined);
const WalletUIContext = createContext(undefined);

// Safe wrapper for useConnectModal — can throw on some mobile browsers
function useSafeConnectModal() {
  try {
    const result = useConnectModal();
    return result?.openConnectModal || null;
  } catch {
    return null;
  }
}

/**
 * WalletProvider — no longer creates its own WagmiProvider/QueryClientProvider.
 * Simply reads from the parent and provides the same context API.
 */
export function WalletProvider({ children }) {
  const { address, isConnected, connector: activeConnector, chain } = useAccount();
  const { connect, connectors, isPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const openConnectModal = useSafeConnectModal();

  const walletName = activeConnector?.name || null;
  const isWrongNetwork = isConnected && chain?.id !== mainnet.id;

  const handleSwitchChain = useCallback(() => {
    switchChain({ chainId: mainnet.id });
  }, [switchChain]);

  const connectWallet = useCallback(
    (connectorId) => {
      // Prefer RainbowKit modal for a unified UX
      if (!connectorId && openConnectModal) {
        openConnectModal();
        return;
      }
      if (connectorId) {
        const c = connectors.find((cn) => cn.id === connectorId || cn.name === connectorId);
        if (c) {
          connect({ connector: c });
          return;
        }
      }
      // Fallback: open RainbowKit modal
      if (openConnectModal) {
        openConnectModal();
      } else {
        const inj = connectors.find((c) => c.id === "injected");
        if (inj) connect({ connector: inj });
        else if (connectors.length > 0) connect({ connector: connectors[0] });
      }
    },
    [connect, connectors, openConnectModal]
  );

  const availableConnectors = useMemo(
    () =>
      connectors.map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
      })),
    [connectors]
  );

  const stateValue = useMemo(
    () => ({
      address: address || null,
      isConnected,
      walletName,
      isWrongNetwork,
    }),
    [address, isConnected, walletName, isWrongNetwork]
  );

  const actionsValue = useMemo(
    () => ({
      connectWallet,
      disconnect,
      switchChain: handleSwitchChain,
    }),
    [connectWallet, disconnect, handleSwitchChain]
  );

  const uiValue = useMemo(
    () => ({
      isPending,
      connectError: connectError?.message || null,
      availableConnectors,
      isSwitching,
    }),
    [isPending, connectError, availableConnectors, isSwitching]
  );

  return (
    <WalletStateContext.Provider value={stateValue}>
      <WalletActionsContext.Provider value={actionsValue}>
        <WalletUIContext.Provider value={uiValue}>
          {children}
        </WalletUIContext.Provider>
      </WalletActionsContext.Provider>
    </WalletStateContext.Provider>
  );
}

// ═══ Granular hooks (same API as original) ═══

export function useWalletState() {
  const ctx = useContext(WalletStateContext);
  if (!ctx) throw new Error("useWalletState must be used within a WalletProvider");
  return ctx;
}

export function useWalletActions() {
  const ctx = useContext(WalletActionsContext);
  if (!ctx) throw new Error("useWalletActions must be used within a WalletProvider");
  return ctx;
}

export function useWalletUI() {
  const ctx = useContext(WalletUIContext);
  if (!ctx) throw new Error("useWalletUI must be used within a WalletProvider");
  return ctx;
}

// ═══ Legacy combined hook (backward compatible) ═══

export function useWallet() {
  return { ...useWalletState(), ...useWalletActions(), ...useWalletUI() };
}

// Re-export a dummy config for any imports that reference it
// (the real wagmi config is in the parent app)
export const config = null;
export const HAS_WC_PROJECT_ID = !!import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
