// AUDIT R053 unit tests: seaport-verify helpers (price math, message
// builder, RPC failure → 503 in production).

import { describe, it, expect, beforeEach, vi } from "vitest";

const OFFERER = "0x" + "a".repeat(40);

describe("seaport-verify helpers", () => {
  // ── priceWeiToEthNumber ──
  describe("priceWeiToEthNumber", () => {
    let priceWeiToEthNumber;
    let MAX_PRICE_WEI;
    beforeEach(async () => {
      vi.resetModules();
      ({ priceWeiToEthNumber, MAX_PRICE_WEI } = await import("../_lib/seaport-verify.js"));
    });

    it("converts 1 ETH wei to 1.0", () => {
      expect(priceWeiToEthNumber(10n ** 18n, 18)).toBe(1);
    });

    it("converts 0.0001 ETH (8 dp precision)", () => {
      expect(priceWeiToEthNumber(10n ** 14n, 18)).toBe(0.0001);
    });

    it("converts 100 USDC (6 decimals) to 100", () => {
      expect(priceWeiToEthNumber(100_000_000n, 6)).toBe(100);
    });

    it("never returns Infinity within MAX_PRICE_WEI bound", () => {
      const result = priceWeiToEthNumber(MAX_PRICE_WEI, 18);
      expect(Number.isFinite(result)).toBe(true);
      // 10^24 / 10^18 = 10^6 = 1,000,000
      expect(result).toBe(1_000_000);
    });

    it("preserves precision for large but in-range values", () => {
      // 999,999.5 ETH
      const wei = 999_999_500_000_000_000_000_000n;
      const result = priceWeiToEthNumber(wei, 18);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeCloseTo(999_999.5, 1);
    });
  });

  // ── buildSeaportMessage ──
  describe("buildSeaportMessage", () => {
    let buildSeaportMessage;
    beforeEach(async () => {
      vi.resetModules();
      ({ buildSeaportMessage } = await import("../_lib/seaport-verify.js"));
    });

    it("coerces all numeric fields to BigInt and itemType to Number", () => {
      const params = {
        offerer: OFFERER,
        zone: "0x0000000000000000000000000000000000000000",
        offer: [{ itemType: "2", token: "0xabc", identifierOrCriteria: "42", startAmount: "1", endAmount: "1" }],
        consideration: [{ itemType: "0", token: "0x0", identifierOrCriteria: "0", startAmount: "1000", endAmount: "1000", recipient: OFFERER }],
        orderType: "2",
        startTime: "1700000000",
        endTime: "1700086400",
        zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        salt: "1",
        conduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      };
      const msg = buildSeaportMessage(params, 5n);
      expect(msg.offerer).toBe(OFFERER);
      expect(typeof msg.offer[0].itemType).toBe("number");
      expect(msg.offer[0].itemType).toBe(2);
      expect(typeof msg.offer[0].startAmount).toBe("bigint");
      expect(msg.offer[0].startAmount).toBe(1n);
      expect(typeof msg.consideration[0].startAmount).toBe("bigint");
      expect(msg.consideration[0].startAmount).toBe(1000n);
      expect(typeof msg.startTime).toBe("bigint");
      expect(msg.counter).toBe(5n);
    });
  });

  // ── verifySeaportSignature: RPC unavailable in production ──
  describe("verifySeaportSignature production policy", () => {
    let originalEnv;
    let originalAlchemyKey;

    beforeEach(() => {
      originalEnv = process.env.NODE_ENV;
      originalAlchemyKey = process.env.ALCHEMY_API_KEY;
    });

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
      if (originalAlchemyKey === undefined) delete process.env.ALCHEMY_API_KEY;
      else process.env.ALCHEMY_API_KEY = originalAlchemyKey;
    });

    it("fails closed (rpc-unavailable) in production with no ALCHEMY_API_KEY", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.ALCHEMY_API_KEY;
      vi.resetModules();
      const { verifySeaportSignature } = await import("../_lib/seaport-verify.js");
      const result = await verifySeaportSignature({
        parameters: { offerer: OFFERER },
        signature: "0xdeadbeef",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("rpc-unavailable");
    });

    it("fails closed (rpc-unavailable) in production with ALCHEMY_API_KEY=demo", async () => {
      process.env.NODE_ENV = "production";
      process.env.ALCHEMY_API_KEY = "demo";
      vi.resetModules();
      const { verifySeaportSignature } = await import("../_lib/seaport-verify.js");
      const result = await verifySeaportSignature({
        parameters: { offerer: OFFERER },
        signature: "0xdeadbeef",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("rpc-unavailable");
    });

    it("fails open (skipped) in test env so dev/CI doesn't need RPC", async () => {
      process.env.NODE_ENV = "test";
      delete process.env.ALCHEMY_API_KEY;
      vi.resetModules();
      const { verifySeaportSignature } = await import("../_lib/seaport-verify.js");
      const result = await verifySeaportSignature({
        parameters: { offerer: OFFERER },
        signature: "0xdeadbeef",
      });
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
    });
  });

  // ── verifyNftOwnership similar policy ──
  describe("verifyNftOwnership production policy", () => {
    let originalEnv;
    let originalAlchemyKey;

    beforeEach(() => {
      originalEnv = process.env.NODE_ENV;
      originalAlchemyKey = process.env.ALCHEMY_API_KEY;
    });

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
      if (originalAlchemyKey === undefined) delete process.env.ALCHEMY_API_KEY;
      else process.env.ALCHEMY_API_KEY = originalAlchemyKey;
    });

    it("skips ERC1155 (itemType 3) — ownership semantic differs", async () => {
      process.env.NODE_ENV = "test";
      process.env.ALCHEMY_API_KEY = "valid-key";
      vi.resetModules();
      const { verifyNftOwnership } = await import("../_lib/seaport-verify.js");
      const result = await verifyNftOwnership({
        parameters: { offer: [{ itemType: 3, token: "0xabc", identifierOrCriteria: "1" }], offerer: OFFERER },
      });
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
    });

    it("rejects when offer array is empty", async () => {
      process.env.NODE_ENV = "test";
      process.env.ALCHEMY_API_KEY = "valid-key";
      vi.resetModules();
      const { verifyNftOwnership } = await import("../_lib/seaport-verify.js");
      const result = await verifyNftOwnership({ parameters: { offer: [], offerer: OFFERER } });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("no-offer-item");
    });
  });
});

// vitest doesn't auto-import afterEach
import { afterEach } from "vitest";
