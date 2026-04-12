/**
 * SIWE (Sign-In with Ethereum) Client Auth Module
 *
 * Manages the SIWE authentication flow:
 * 1. Request a one-time nonce from /api/auth/siwe
 * 2. Construct an EIP-4361 SIWE message
 * 3. Sign with wallet via wagmi/ethers
 * 4. Send message + signature to /api/auth/siwe for verification
 * 5. Receive and store JWT for Supabase authenticated requests
 */

import { SiweMessage } from "siwe";

const AUTH_API = "/api/auth/siwe";
const STORAGE_KEY_TOKEN = "siwe_token";
const STORAGE_KEY_WALLET = "siwe_wallet";
const STORAGE_KEY_EXP = "siwe_token_exp";

// ── Nonce Request ──

export async function requestNonce() {
  const res = await fetch(`${AUTH_API}?action=nonce`);
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

// ── Verify Signature + Get JWT ──

export async function verifySignature(message, signature) {
  const res = await fetch(AUTH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Verification failed");
  }
  const data = await res.json(); // { token, wallet, expiresAt }

  // Store in localStorage
  try {
    localStorage.setItem(STORAGE_KEY_TOKEN, data.token);
    localStorage.setItem(STORAGE_KEY_WALLET, data.wallet);
    localStorage.setItem(STORAGE_KEY_EXP, data.expiresAt);
  } catch { /* quota */ }

  return data;
}

// ── Token Management ──

export function getStoredToken() {
  try {
    const token = localStorage.getItem(STORAGE_KEY_TOKEN);
    const exp = localStorage.getItem(STORAGE_KEY_EXP);
    if (!token || !exp) return null;
    if (new Date(exp) <= new Date()) {
      clearStoredToken();
      return null;
    }
    return token;
  } catch {
    return null;
  }
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

export function clearStoredToken() {
  try {
    localStorage.removeItem(STORAGE_KEY_TOKEN);
    localStorage.removeItem(STORAGE_KEY_WALLET);
    localStorage.removeItem(STORAGE_KEY_EXP);
  } catch { /* noop */ }
}
