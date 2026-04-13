// ═══ SIWE (Sign-In with Ethereum) AUTH ENDPOINT ═══
// Implements EIP-4361 authentication for Supabase.
// GET  ?action=nonce    → generate single-use nonce
// POST { message, sig } → verify signature, set httpOnly JWT cookie
// DELETE                 → clear auth cookie (logout)
//
// The JWT is stored in an httpOnly cookie — never exposed to client JS.
// It contains a `wallet` claim used by Supabase RLS policies
// to enforce row-level ownership (e.g., wallet = jwt.wallet).

import { createClient } from "@supabase/supabase-js";
import { SiweMessage } from "siwe";
import { SignJWT } from "jose";
import { randomUUID } from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TOKEN_EXPIRY_HOURS = 24;

const ALLOWED_ORIGINS = new Set([
  "https://nakamigos.gallery",
  "https://www.nakamigos.gallery",
]);
if (process.env.NODE_ENV !== "production") {
  ALLOWED_ORIGINS.add("http://localhost:8742");
  ALLOWED_ORIGINS.add("http://localhost:3000");
  ALLOWED_ORIGINS.add("http://localhost:5173");
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.has(origin) ? origin : "https://nakamigos.gallery");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
}

/**
 * Build a Set-Cookie header value for the SIWE JWT.
 * httpOnly + Secure + SameSite=Lax prevents XSS token theft while allowing
 * same-site navigations to send the cookie automatically.
 */
function buildAuthCookie(token, maxAgeSeconds) {
  // SECURITY FIX: Default to Secure=true, only disable for explicit localhost development.
  // Previously relied on NODE_ENV=production which could be misconfigured on the deployment
  // platform, causing the JWT cookie to be sent over plain HTTP (MITM risk).
  const isLocalDev = process.env.DISABLE_SECURE_COOKIE === "true";
  const parts = [
    `siwe_jwt=${token}`,
    `HttpOnly`,
    `Path=/`,
    `Max-Age=${maxAgeSeconds}`,
    `SameSite=Lax`,
  ];
  if (!isLocalDev) parts.push("Secure");
  return parts.join("; ");
}

function buildClearAuthCookie() {
  const isLocalDev = process.env.DISABLE_SECURE_COOKIE === "true";
  const parts = [
    `siwe_jwt=`,
    `HttpOnly`,
    `Path=/`,
    `Max-Age=0`,
    `SameSite=Lax`,
  ];
  if (!isLocalDev) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Parse the siwe_jwt cookie from the Cookie header.
 */
function parseSiweJwt(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)siwe_jwt=([^;]*)/);
  return match ? match[1] : null;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!supabase || !JWT_SECRET) {
    return res.status(503).json({ error: "Auth service not configured" });
  }

  // ── GET: Generate nonce ──
  if (req.method === "GET" && req.query.action === "nonce") {
    const nonce = randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS).toISOString();

    // Store nonce in DB (service_role only table)
    const { error } = await supabase.from("siwe_nonces").insert({ nonce, expires_at: expiresAt });
    if (error) {
      console.error("Nonce storage error:", error.message);
      return res.status(500).json({ error: "Failed to generate nonce" });
    }

    // Clean up expired nonces opportunistically
    await supabase.from("siwe_nonces").delete().lt("expires_at", new Date().toISOString()).catch(() => {});

    return res.json({ nonce, expiresAt });
  }

  // ── POST: Verify signature + issue JWT ──
  if (req.method === "POST") {
    const { message, signature } = req.body || {};
    if (!message || !signature) {
      return res.status(400).json({ error: "Missing message or signature" });
    }

    let siweMessage;
    try {
      siweMessage = new SiweMessage(message);
    } catch {
      return res.status(400).json({ error: "Invalid SIWE message format" });
    }

    // Validate domain
    const origin = req.headers.origin || "";
    const allowedDomains = [...ALLOWED_ORIGINS].map(u => new URL(u).host);
    if (!allowedDomains.includes(siweMessage.domain)) {
      return res.status(403).json({ error: "Domain mismatch" });
    }

    // Validate chain (mainnet only)
    if (siweMessage.chainId !== 1) {
      return res.status(400).json({ error: "Only Ethereum mainnet (chainId 1) is supported" });
    }

    // Check nonce exists and is not expired
    const { data: nonceRow, error: nonceErr } = await supabase
      .from("siwe_nonces")
      .select("nonce, expires_at")
      .eq("nonce", siweMessage.nonce)
      .single();

    if (nonceErr || !nonceRow) {
      return res.status(400).json({ error: "Invalid or expired nonce" });
    }
    if (new Date(nonceRow.expires_at) < new Date()) {
      // Delete expired nonce
      await supabase.from("siwe_nonces").delete().eq("nonce", siweMessage.nonce).catch(() => {});
      return res.status(400).json({ error: "Nonce expired" });
    }

    // Verify the SIWE signature
    let verifyResult;
    try {
      verifyResult = await siweMessage.verify({ signature });
    } catch (err) {
      return res.status(400).json({ error: "Signature verification failed" });
    }

    if (!verifyResult.success) {
      return res.status(403).json({ error: "Invalid signature" });
    }

    // Delete used nonce (single-use)
    await supabase.from("siwe_nonces").delete().eq("nonce", siweMessage.nonce).catch(() => {});

    // Issue custom JWT for Supabase
    const wallet = siweMessage.address.toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + TOKEN_EXPIRY_HOURS * 3600;

    const secret = new TextEncoder().encode(JWT_SECRET);
    const token = await new SignJWT({
      sub: wallet,
      wallet,
      role: "authenticated",
      aud: "authenticated",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setIssuer("supabase")
      .sign(secret);

    // Set JWT as httpOnly cookie — never exposed to client-side JS
    const maxAge = TOKEN_EXPIRY_HOURS * 3600;
    res.setHeader("Set-Cookie", buildAuthCookie(token, maxAge));

    // Return wallet + expiry (non-sensitive) but NOT the token itself
    return res.json({
      wallet,
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  }

  // ── DELETE: Logout — clear the auth cookie ──
  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", buildClearAuthCookie());
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
