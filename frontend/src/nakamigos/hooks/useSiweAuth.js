/**
 * useSiweAuth — React hook for SIWE authentication
 *
 * Provides wallet-based sign-in/sign-out with JWT lifecycle management.
 * Integrates with wagmi for wallet signatures and Supabase for auth headers.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useWalletState } from "../contexts/WalletContext";
import {
  requestNonce,
  buildSiweMessage,
  verifySignature,
  getStoredToken,
  getStoredWallet,
  isTokenExpired,
  clearStoredToken,
} from "../lib/siweAuth";
import { getProvider } from "../api";

export function useSiweAuth() {
  const { address, isConnected } = useWalletState();
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authenticatedWallet, setAuthenticatedWallet] = useState(() => getStoredWallet());
  const [token, setToken] = useState(() => getStoredToken());

  // Check stored auth on mount and when wallet changes
  useEffect(() => {
    const storedWallet = getStoredWallet();
    const storedToken = getStoredToken();

    // Clear auth if wallet changed or token expired
    if (!isConnected || !address) {
      if (storedToken) {
        clearStoredToken();
        setToken(null);
        setAuthenticatedWallet(null);
      }
      return;
    }

    if (storedWallet && storedWallet !== address.toLowerCase()) {
      // Wallet changed — clear old auth
      clearStoredToken();
      setToken(null);
      setAuthenticatedWallet(null);
      return;
    }

    if (storedToken && !isTokenExpired()) {
      setToken(storedToken);
      setAuthenticatedWallet(storedWallet);
    } else if (storedToken) {
      // Token expired
      clearStoredToken();
      setToken(null);
      setAuthenticatedWallet(null);
    }
  }, [address, isConnected]);

  // Sign in flow
  const signIn = useCallback(async () => {
    if (!address || !isConnected) throw new Error("Wallet not connected");
    setIsAuthenticating(true);

    try {
      // 1. Get nonce
      const { nonce } = await requestNonce();

      // 2. Build SIWE message
      const siweMessage = buildSiweMessage(address, nonce);
      const messageString = siweMessage.prepareMessage();

      // 3. Sign with wallet
      const ethProvider = getProvider();
      if (!ethProvider) throw new Error("No wallet provider");
      const { ethers } = await import("ethers");
      const provider = new ethers.BrowserProvider(ethProvider);
      const signer = await provider.getSigner();
      const signature = await signer.signMessage(messageString);

      // 4. Verify and get JWT
      const result = await verifySignature(messageString, signature);

      setToken(result.token);
      setAuthenticatedWallet(result.wallet);

      return result;
    } catch (err) {
      if (err.code === 4001 || err.code === "ACTION_REJECTED") {
        throw new Error("Sign-in cancelled");
      }
      throw err;
    } finally {
      setIsAuthenticating(false);
    }
  }, [address, isConnected]);

  // Sign out
  const signOut = useCallback(() => {
    clearStoredToken();
    setToken(null);
    setAuthenticatedWallet(null);
  }, []);

  const isAuthenticated = useMemo(
    () => !!token && !!authenticatedWallet && !isTokenExpired(),
    [token, authenticatedWallet]
  );

  return {
    isAuthenticated,
    isAuthenticating,
    authenticatedWallet,
    token,
    signIn,
    signOut,
  };
}
