import { describe, it, expect, vi, beforeEach } from "vitest";

// Wrapping ETH and approving WETH spend from the wallet that signs. Until
// 2026-11-15 that was the first injected wallet, never compared with the
// account the site is connected as; both now refuse another account with the
// "Wrong wallet" answer (api.js assertSameWallet) before anything is sent.

const CONNECTED = "0x" + "a".repeat(40);
const OTHER = "0x" + "e".repeat(40);

const h = vi.hoisted(() => ({ signer: null, contractCalls: [] }));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal()),
  getProvider: () => ({ __injected: true }),
  getActiveWalletProvider: async () => ({ provider: { __connector: true }, address: "0x" + "a".repeat(40) }),
}));

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal();
  class MockBrowserProvider {
    async getNetwork() { return { chainId: 1n }; }
    async getSigner() { return h.signer; }
    async getBalance() { return 10n ** 20n; }
  }
  class MockContract {
    constructor() {
      return new Proxy({}, {
        get: (_o, prop) => (prop === "then" ? undefined : (...args) => {
          h.contractCalls.push(String(prop));
          return Promise.resolve({ hash: "0xtx", wait: async () => ({ status: 1 }), args });
        }),
      });
    }
  }
  return { ...actual, ethers: { ...actual.ethers, BrowserProvider: MockBrowserProvider, Contract: MockContract } };
});

function signerAs(address) {
  return { getAddress: async () => address, provider: { getBalance: async () => 10n ** 20n } };
}

beforeEach(() => {
  h.contractCalls = [];
  h.signer = signerAs(OTHER);
});

describe("WETH wrap and approve sign only as the connected account", () => {
  it("wrapping from another account is refused before the deposit", async () => {
    const { wrapEth } = await import("./weth");
    await expect(wrapEth(10n ** 16n)).rejects.toMatchObject({ code: "wallet-mismatch" });
    expect(h.contractCalls).toEqual([]);
  });

  it("approving from another account is refused before the approval", async () => {
    const { approveWeth } = await import("./weth");
    await expect(approveWeth(10n ** 16n)).rejects.toMatchObject({ code: "wallet-mismatch" });
    expect(h.contractCalls).toEqual([]);
  });

  it("control: the connected account wraps", async () => {
    h.signer = signerAs(CONNECTED);
    const { wrapEth } = await import("./weth");
    await wrapEth(10n ** 16n);
    expect(h.contractCalls).toEqual(["deposit"]);
  });
});
