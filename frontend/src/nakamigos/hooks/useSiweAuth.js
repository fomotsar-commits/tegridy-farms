/**
 * useSiweAuth — React hook for SIWE authentication
 *
 * Provides wallet-based sign-in/sign-out with httpOnly cookie JWT.
 * The JWT never touches client-side JS — session status is validated
 * via the /api/auth/me endpoint.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useWalletState } from "../contexts/WalletContext";
import {
  requestNonce,
  buildSiweMessage,
  verifySignature,
  checkSession,
  getStoredWallet,
  isTokenExpired,
  logout,
  clearStoredAuth,
} from "../lib/siweAuth";
import { getProvider } from "../api";

export function useSiweAuth() {
  const { address, isConnected } = useWalletState();
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authenticatedWallet, setAuthenticatedWallet] = useState(() => getStoredWallet());
  const [isSessionValid, setIsSessionValid] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);

  // Validate session with server on mount and when wallet changes
  useEffect(() => {
    let cancelled = false;

    async function validateSession() {
      if (!isConnected || !address) {
        if (authenticatedWallet) {
          clearStoredAuth();
          setAuthenticatedWallet(null);
          setIsSessionValid(false);
        }
        setSessionChecked(true);
        return;
      }

      const storedWallet = getStoredWallet();

      // Wallet changed — clear old auth
      if (storedWallet && storedWallet !== address.toLowerCase()) {
        await logout();
        if (cancelled) return;
        setAuthenticatedWallet(null);
        setIsSessionValid(false);
        setSessionChecked(true);
        return;
      }

      // Quick local check — if metadata says expired, skip server round-trip
      if (!storedWallet || isTokenExpired()) {
        clearStoredAuth();
        if (cancelled) return;
        setAuthenticatedWallet(null);
        setIsSessionValid(false);
        setSessionChecked(true);
        return;
      }

      // Validate the httpOnly cookie with the server
      const session = await checkSession();
      if (cancelled) return;

      if (session && session.authenticated) {
        setAuthenticatedWallet(session.wallet);
        setIsSessionValid(true);
      } else {
        setAuthenticatedWallet(null);
        setIsSessionValid(false);
      }
      setSessionChecked(true);
    }

    validateSession();
    return () => { cancelled = true; };
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

      // 4. Verify — server sets httpOnly cookie, returns wallet + expiry
      const result = await verifySignature(messageString, signature);

      setAuthenticatedWallet(result.wallet);
      setIsSessionValid(true);

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

  // Sign out — clears httpOnly cookie via server + local metadata
  const signOut = useCallback(async () => {
    await logout();
    setAuthenticatedWallet(null);
    setIsSessionValid(false);
  }, []);

  const isAuthenticated = useMemo(
    () => isSessionValid && !!authenticatedWallet && !isTokenExpired(),
    [isSessionValid, authenticatedWallet]
  );

  return {
    isAuthenticated,
    isAuthenticating,
    authenticatedWallet,
    // token is no longer exposed — kept as null for backward compat
    token: null,
    signIn,
    signOut,
    sessionChecked,
  };
}
