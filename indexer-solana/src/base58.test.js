import { describe, it, expect } from "vitest";
import { base58Decode, isSolanaAddress, isSolanaSignature } from "./base58.js";

// Real mainnet keys, already pinned elsewhere in this repo
// (frontend/src/lib/solana.ts, frontend/src/lib/launcher/solana/dbc.ts).
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

describe("base58Decode", () => {
  it("decodes known mainnet pubkeys to exactly 32 bytes", () => {
    for (const key of [SOL_MINT, USDC_MINT, DBC_PROGRAM, SYSTEM_PROGRAM]) {
      expect(base58Decode(key)?.length, key).toBe(32);
    }
  });

  it("keeps leading zero bytes, which is what makes the all-ones system program 32 bytes", () => {
    expect(Array.from(base58Decode(SYSTEM_PROGRAM))).toEqual(new Array(32).fill(0));
  });

  it("rejects characters outside the alphabet", () => {
    // 0, O, I and l are excluded precisely because they are confusable.
    for (const bad of ["0oO", "Il1", SOL_MINT.replace("S", "0")]) {
      expect(base58Decode(bad), bad).toBeNull();
    }
  });

  it("rejects the empty string rather than returning empty bytes", () => {
    expect(base58Decode("")).toBeNull();
  });
});

describe("isSolanaAddress", () => {
  it("accepts real addresses", () => {
    expect(isSolanaAddress(SOL_MINT)).toBe(true);
    expect(isSolanaAddress(DBC_PROGRAM)).toBe(true);
  });

  // THE GUARD THIS FILE EXISTS FOR. The shape regex used elsewhere in the repo
  // (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) accepts a 45-character string and any
  // 32–44 character string that decodes to the wrong byte length. A pool
  // address that is not 32 bytes returns empty signature pages forever, and an
  // empty page is exactly what a pool with no trades looks like.
  it("rejects base58 that is the right shape but the wrong byte length", () => {
    const thirtyThreeBytes = "1" + SOL_MINT; // a leading '1' adds a zero byte
    expect(base58Decode(thirtyThreeBytes)?.length).toBe(33);
    expect(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(thirtyThreeBytes)).toBe(true);
    expect(isSolanaAddress(thirtyThreeBytes)).toBe(false);
  });

  it("rejects a 64-byte signature offered where an address belongs", () => {
    const signature = "5".repeat(88);
    expect(isSolanaAddress(signature)).toBe(false);
  });
});

describe("isSolanaSignature", () => {
  it("separates 64-byte signatures from 32-byte addresses", () => {
    const bytes = base58Decode("5".repeat(88));
    expect(bytes?.length).toBe(64);
    expect(isSolanaSignature("5".repeat(88))).toBe(true);
    expect(isSolanaSignature(SOL_MINT)).toBe(false);
  });
});
