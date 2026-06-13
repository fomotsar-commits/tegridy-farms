import { describe, it, expect } from "vitest";
import { buildOrderComponents } from "./seaportCancel";

const PARAMS = {
  offerer: "0x1111111111111111111111111111111111111111",
  zone: "0x0000000000000000000000000000000000000000",
  offer: [
    { itemType: 2, token: "0xNFT", identifierOrCriteria: "123", startAmount: "1", endAmount: "1" },
  ],
  consideration: [
    { itemType: 1, token: "0xWETH", identifierOrCriteria: "0", startAmount: "1000", endAmount: "1000", recipient: "0x1111111111111111111111111111111111111111" },
  ],
  orderType: 0,
  startTime: "100",
  endTime: "200",
  zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  salt: "999",
  conduitKey: "0x00000000000000000000000000000000000000000000000000000000000000aa",
  // the parameters' trailing field — must NOT end up in the counter slot
  totalOriginalConsiderationItems: 2,
};

describe("buildOrderComponents (Seaport cancel)", () => {
  it("puts the live counter in the trailing slot — never totalOriginalConsiderationItems (the bug)", () => {
    const c = buildOrderComponents(PARAMS, 5n);
    expect(c.counter).toBe(5n);
    expect("totalOriginalConsiderationItems" in c).toBe(false);
  });

  it("coerces a number/string counter to BigInt", () => {
    expect(buildOrderComponents(PARAMS, 7).counter).toBe(7n);
    expect(buildOrderComponents(PARAMS, "9").counter).toBe(9n);
    expect(buildOrderComponents(PARAMS, 0n).counter).toBe(0n);
  });

  it("maps offer/consideration amounts to BigInt and keeps recipient", () => {
    const c = buildOrderComponents(PARAMS, 0n);
    expect(c.offer[0].identifierOrCriteria).toBe(123n);
    expect(c.offer[0].startAmount).toBe(1n);
    expect(c.consideration[0].startAmount).toBe(1000n);
    expect(c.consideration[0].recipient).toBe(PARAMS.offerer);
  });

  it("preserves the order's own conduitKey / zone / salt (must match the signed hash)", () => {
    const c = buildOrderComponents(PARAMS, 0n);
    expect(c.conduitKey).toBe(PARAMS.conduitKey);
    expect(c.zone).toBe(PARAMS.zone);
    expect(c.salt).toBe(999n);
    expect(c.orderType).toBe(0);
  });
});
