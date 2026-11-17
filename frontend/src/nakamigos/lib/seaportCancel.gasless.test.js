import { describe, it, expect, vi } from "vitest";
import { ethers } from "ethers";
import { hashDomain, hashTypedData } from "viem";
import {
  GASLESS_CANCEL_DONE, gaslessCancelTypedData, gaslessCancelPath, seaportOrderHash, cancelSeaportOrderGasless,
} from "./seaportCancel";
import { buildBidParameters, isSeaport16SignedZoneOrder, SEAPORT_16_ADDRESS, OPENSEA_SIGNED_ZONE } from "./seaportOffer";

// The JBAC collection bid for 2 whose order hash Seaport 1.6 itself returned
// (getOrderHash via eth_call, 2026-11-16; lib/seaportOffer.test.js holds the same).
const BIDDER = "0xBd00483Ccb69C4fCc2F9f28E87FC29eeb308EFFA";
const JBAC = "0xd37264c71e9af940e49795F0d3a8336afAaFDdA9";
const PARAMS = buildBidParameters({
  chainId: 1, offerer: BIDDER, kind: "collection", collectionContract: JBAC, quantity: 2,
  unitPriceWei: 20_000_000_000_000_000n, feeLines: [{ recipient: "0x0000a26b00c1F0DF003000390027140000fAa719", bps: 100 }],
  build: {
    consideration: [{ itemType: 4, token: JBAC.toLowerCase(), identifierOrCriteria: "0", startAmount: "2", endAmount: "2", recipient: BIDDER.toLowerCase() }],
    zone: OPENSEA_SIGNED_ZONE.toLowerCase(), zoneHash: "0x" + "0".repeat(64),
  },
  startTime: 1763251200, endTime: 1763253000, salt: "0xbec43592d2dbea11d8fc3e3681600bd71076026dd0cde45c6e36453565b1a686",
});
const SEAPORT_ORDER_HASH = "0xa8afbcdfcb534e8c6dec7aa853f448b99c133ad3c7853403de30db7df06ec939";
// Seaport 1.6 information().domainSeparator, read on each chain 2026-11-16.
const SEPARATOR = { 1: "0xfce34bc6e1752c1117e5063116d25cad2fa2bdcf15ff2d2e275eece7dc31ba64", 8453: "0x1965c52d779fea3b2c530bc1bbedc135c9671ade2fa4748307d92dbcdb47b2e0" };
const SIG = "0x" + "ab".repeat(65);

describe("which orders get the gasless cancel", () => {
  it("a Seaport 1.6 order restricted to OpenSea's SignedZone, any address case", () => {
    expect(isSeaport16SignedZoneOrder(PARAMS, SEAPORT_16_ADDRESS)).toBe(true);
    expect(isSeaport16SignedZoneOrder({ zone: OPENSEA_SIGNED_ZONE.toLowerCase() }, SEAPORT_16_ADDRESS.toLowerCase())).toBe(true);
  });

  it("not a Seaport 1.5 order, a zone-less order, or an order on another zone", () => {
    expect(isSeaport16SignedZoneOrder(PARAMS, "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC")).toBe(false);
    expect(isSeaport16SignedZoneOrder({ ...PARAMS, zone: "0x" + "0".repeat(40) }, SEAPORT_16_ADDRESS)).toBe(false);
    expect(isSeaport16SignedZoneOrder({ ...PARAMS, zone: "0x004C00500000aD104D7DBd00e3ae0A5C00560C00" }, SEAPORT_16_ADDRESS)).toBe(false);
    expect(isSeaport16SignedZoneOrder(null, SEAPORT_16_ADDRESS)).toBe(false);
  });
});

describe("the message an offerer signs (opensea-js CancellationManager.getOffererSignature)", () => {
  it("is OrderHash(bytes32 orderHash) under Seaport 1.6's own domain", () => {
    const t = gaslessCancelTypedData(SEAPORT_ORDER_HASH, 1);
    expect(t.domain).toEqual({ name: "Seaport", version: "1.6", chainId: 1, verifyingContract: SEAPORT_16_ADDRESS });
    expect(t.types).toEqual({ OrderHash: [{ name: "orderHash", type: "bytes32" }] });
    expect(t.primaryType).toBe("OrderHash");
    expect(t.message).toEqual({ orderHash: SEAPORT_ORDER_HASH });
    const EIP712Domain = [
      { name: "name", type: "string" }, { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    ];
    for (const chainId of [1, 8453]) {
      expect(hashDomain({ domain: gaslessCancelTypedData(SEAPORT_ORDER_HASH, chainId).domain, types: { EIP712Domain } })).toBe(SEPARATOR[chainId]);
    }
    // viem and ethers sign the same digest for it.
    expect(hashTypedData(t)).toBe(ethers.TypedDataEncoder.hash(t.domain, t.types, t.message));
  });

  it("refuses anything that is not a 32-byte hash", () => {
    expect(() => gaslessCancelTypedData("0x1234", 1)).toThrow();
    expect(() => gaslessCancelTypedData(SEAPORT_ORDER_HASH, 137)).toThrow();
  });
});

describe("the path it is posted to", () => {
  it("is the one shape the proxy admits", () => {
    expect(gaslessCancelPath(1, SEAPORT_ORDER_HASH.toUpperCase().replace("0X", "0x")))
      .toBe(`orders/chain/ethereum/protocol/0x0000000000000068f116a894984e2db1123eb395/${SEAPORT_ORDER_HASH}/cancel`);
    expect(gaslessCancelPath(8453, SEAPORT_ORDER_HASH)).toMatch(/^orders\/chain\/base\/protocol\/0x0000000000000068f116a894984e2db1123eb395\//);
    expect(() => gaslessCancelPath(137, SEAPORT_ORDER_HASH)).toThrow();
    expect(() => gaslessCancelPath(1, "0xnope")).toThrow();
  });
});

describe("the order hash checked before signing", () => {
  it("is Seaport 1.6's own getOrderHash for the order", () => {
    expect(seaportOrderHash(ethers, PARAMS, 0n)).toBe(SEAPORT_ORDER_HASH);
    expect(seaportOrderHash(ethers, PARAMS, 1n)).not.toBe(SEAPORT_ORDER_HASH);
  });
});

describe("cancelSeaportOrderGasless", () => {
  function rig({ counter = 0n, signature = SIG, answer = { last_signature_issued_valid_until: "0" }, postError = null } = {}) {
    const signer = { signTypedData: vi.fn(async () => signature) };
    const fakeEthers = {
      TypedDataEncoder: ethers.TypedDataEncoder,
      Contract: class { constructor(target) { this.target = target; } async getCounter() { return counter; } },
    };
    const post = vi.fn(async () => { if (postError) throw postError; return answer; });
    const run = (over = {}) => cancelSeaportOrderGasless({ ethers: fakeEthers, signer, params: PARAMS, orderHash: SEAPORT_ORDER_HASH, chainId: 1, post, ...over });
    return { signer, post, run };
  }

  it("signs, posts exactly { offererSignature } and reports OpenSea's last-signature time", async () => {
    const r = rig({ answer: { last_signature_issued_valid_until: "2026-11-16T00:05:00Z" } });
    expect(await r.run()).toEqual({ ok: true, lastSignatureValidUntil: "2026-11-16T00:05:00Z" });
    expect(r.post.mock.calls).toEqual([[gaslessCancelPath(1, SEAPORT_ORDER_HASH), { offererSignature: SIG }]]);
    expect(GASLESS_CANCEL_DONE).toBe("Cancelled. OpenSea can still complete a sale it approved in the last 5 minutes.");
  });

  it("never signs for a hash that is not this order's at the live counter", async () => {
    const r = rig({ counter: 3n });
    expect(await r.run()).toEqual({ ok: false, reason: "hash-mismatch" });
    expect(r.signer.signTypedData).not.toHaveBeenCalled();
    expect(r.post).not.toHaveBeenCalled();
  });

  it("does not post a signature the proxy would refuse (not 65 bytes)", async () => {
    const r = rig({ signature: "0x" + "ab".repeat(64) });
    expect(await r.run()).toEqual({ ok: false, reason: "signature-shape" });
    expect(r.post).not.toHaveBeenCalled();
  });

  it("a refusal or an answer that confirms nothing is not a cancel", async () => {
    expect(await rig({ postError: Object.assign(new Error("400"), { status: 400 }) }).run()).toEqual({ ok: false, reason: "refused-400" });
    expect(await rig({ answer: {} }).run()).toEqual({ ok: false, reason: "unconfirmed" });
    expect(await rig({ answer: null }).run()).toEqual({ ok: false, reason: "unconfirmed" });
  });

  it("no order hash, or a chain without the gasless cancel, is left to the on-chain cancel", async () => {
    expect(await rig().run({ orderHash: null })).toEqual({ ok: false, reason: "no-order-hash" });
    expect(await rig().run({ chainId: 137 })).toEqual({ ok: false, reason: "chain" });
  });

  it("a wallet that refuses to sign throws, so the caller never reads 'no' as 'try on chain'", async () => {
    const r = rig();
    r.signer.signTypedData = vi.fn(async () => { throw Object.assign(new Error("user rejected"), { code: 4001 }); });
    await expect(r.run()).rejects.toMatchObject({ code: 4001 });
    expect(r.post).not.toHaveBeenCalled();
  });
});
