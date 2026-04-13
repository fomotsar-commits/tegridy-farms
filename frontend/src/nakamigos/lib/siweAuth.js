/**
 * SIWE (Sign-In with Ethereum) Client Auth Module
 *
 * Manages the SIWE authentication flow:
 * 1. Request a one-time nonce from /api/auth/siwe
 * 2. Construct an EIP-4361 SIWE message
 * 3. Sign with wallet via wagmi/ethers
 * 4. Send message + signature to /api/auth/siwe for verification
 * 5. Server sets an httpOnly cookie with the JWT (never exposed to JS)
 * 6. Wallet address + expiry stored in localStorage (non-sensitive metadata)
 *
 * The JWT is NEVER stored in localStorage — it lives in an httpOnly cookie
 * that the browser sends automatically with every request to our API.
 */

import { SiweMessage } from "siwe";

const AUTH_API = "/api/auth/siwe";
const ME_API = "/api/auth/me";
const STORAGE_KEY_WALLET = "siwe_wallet";
const STORAGE_KEY_EXP = "siwe_token_exp";

// ── Nonce Request ──

export async function requestNonce() {
  const res = await fetch(`${AUTH_API}?action=nonce`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to get nonce");
  return res.json(); // { nonce, expiresAt }
}

// ── Build SIWE Message ──

export function buildSiweMessage(address, nonce) {
  return new SiweMessage({
    domain: window.location.host,
    address,
    statement: "Sign in to Tegriddy Farms",
    uri: window.location.origin,
    version: "1",
    chainId: 1,
    nonce,
  });
}

// ── Verify Signature (server sets httpOnly cookie) ──

export async function verifySignature(message, signature) {
  const res = await fetch(AUTH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ message, signature }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Verification failed");
  }
  // Server returns { wallet, expiresAt } — JWT is in the httpOnly cookie
  const data = await res.json();

  // Store non-sensitive metadata in localStorage for quick UI checks
  try {
    localStorage.setItem(STORAGE_KEY_WALLET, data.wallet);
    localStorage.setItem(STORAGE_KEY_EXP, data.expiresAt);
  } catch { /* quota */ }

  return data;
}

// ── Session Check (validates httpOnly cookie server-side) ──

export async function checkSession() {
  try {
    const res = await fetch(ME_API, { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.authenticated) {
      // Server says not authenticated — clean up local metadata
      clearStoredAuth();
      return null;
    }
    // Keep local metadata in sync
    try {
      localStorage.setItem(STORAGE_KEY_WALLET, data.wallet);
      if (data.expiresAt) localStorage.setItem(STORAGE_KEY_EXP, data.expiresAt);
    } catch { /* quota */ }
    return data;
  } catch {
    return null;
  }
}

// ── Token Management ──

/**
 * @deprecated — JWT is no longer in localStorage. Use checkSession() for
 * server-validated auth status. This is kept temporarily for the Supabase
 * client integration which needs a token for the Authorization header.
 * It will be removed once Supabase queries go through a server proxy.
 */
export function getStoredToken() {
  // JWT is now in an httpOnly cookie — inaccessible to JS.
  // Return null so callers fall back to anon key.
  return null;
}

export function getStoredWallet() {
  try {
    return localStorage.getItem(STORAGE_KEY_WALLET) || null;
  } catch {
    return null;
  }
}

export function isTokenExpired() {
  try {
    const exp = localStorage.getItem(STORAGE_KEY_EXP);
    if (!exp) return true;
    return new Date(exp) <= new Date();
  } catch {
    return true;
  }
}

export async function logout() {
  try {
    await fetch(AUTH_API, { method: "DELETE", credentials: "include" });
  } catch { /* best effort */ }
  clearStoredAuth();
}

export function clearStoredAuth() {
  try {
    localStorage.removeItem(STORAGE_KEY_WALLET);
    localStorage.removeItem(STORAGE_KEY_EXP);
  } catch { /* noop */ }
}

// Legacy alias — some callers may still reference this
export const clearStoredToken = clearStoredAuth;
