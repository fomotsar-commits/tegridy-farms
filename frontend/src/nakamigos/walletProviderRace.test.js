import { describe, it, expect, beforeEach, vi } from "vitest";

// ═══ REGRESSION: a stale in-flight resolution must not re-prime the cache ═══
//
// `getActiveWalletProvider()` awaits `connector.getProvider()`, which is slow
// for WalletConnect and Safe. WalletProvider fires a fresh resolution on every
// connect / account switch / disconnect, so two can be in flight at once.
//
// Without a sequence guard, last-write-wins: a slow resolution for the wallet
// the user just LEFT completes after the fast one for the wallet they just
// CHOSE, and re-primes the shared cache with the old wallet. Every synchronous
// getProvider() call site — WETH wrap/unwrap, listing create, cancel, bids,
// trades — then transacts from a wallet the user already switched away from.
// That is the same pay-from-the-wrong-wallet state the connector resolution
// exists to close, reintroduced through the back door.
//
// The invariant pinned here is ordering-independent and user-visible:
//
//   Whatever order in-flight resolutions COMPLETE in, the synchronous
//   getProvider() reflects the wallet that is CURRENTLY connected.
//
// Note this asserts the cache, not the return value. A stale caller still gets
// its own answer back — that is deliberate, because it is paired with
// `assertSameWallet()` at the call site. Only the SHARED cache is guarded.

const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const h = vi.hoisted(() => ({
  account: { address: undefined, isConnected: false, connector: undefined },
}));

vi.mock("wagmi/actions", () => ({ getAccount: () => h.account }));
vi.mock("../lib/wagmi", () => ({ config: { __test: true } }));

const makeProvider = (tag) => ({ __wallet: tag, request: vi.fn() });

/** A connector whose getProvider() resolves only when you call `release()`. */
function deferredConnector(tag) {
  const provider = makeProvider(tag);
  let release;
  const gate = new Promise((res) => { release = res; });
  return {
    provider,
    release: () => { release(); return gate; },
    connector: { getProvider: () => gate.then(() => provider) },
  };
}

function connectAs(address, connector) {
  h.account = { address, isConnected: true, connector };
}

/**
 * Let an in-flight resolution advance past its dynamic `import()`s and reach
 * the `await connector.getProvider()` it will hang on.
 *
 * Without this, a resolution started for wallet A has not yet called
 * `getAccount()` when the test switches to B, so it reads B's account and both
 * calls race on the SAME connector — which models nothing. Flushing here is
 * what makes A genuinely a stale, previous-wallet resolution.
 */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("getActiveWalletProvider — stale-resolution guard", () => {
  let api;

  beforeEach(async () => {
    vi.resetModules();
    // No window.ethereum and no EIP-6963 announcement: the rdns walk finds
    // nothing, so getProvider() returns null unless the cache was primed.
    // That keeps this test about the CACHE and nothing else.
    delete globalThis.window.ethereum;
    h.account = { address: undefined, isConnected: false, connector: undefined };
    api = await import("./api.js");
  });

  it("a slow resolution for the PREVIOUS wallet cannot overwrite the current one", async () => {
    const slowA = deferredConnector("walletA");
    const fastB = deferredConnector("walletB");

    // 1. Connected as A. Start resolving; it hangs on the connector.
    connectAs(ADDR_A, slowA.connector);
    const pendingA = api.getActiveWalletProvider();
    await settle(); // A is now genuinely parked on A's connector

    // 2. User switches to B before A ever came back. B resolves immediately.
    connectAs(ADDR_B, fastB.connector);
    fastB.release();
    await api.getActiveWalletProvider();
    expect(api.getProvider()?.__wallet).toBe("walletB");

    // 3. NOW A's connector finally answers — after the switch.
    slowA.release();
    await pendingA;

    // The cache must still be B. Pre-guard this was "walletA": the user would
    // have signed and paid from the wallet they had already left.
    expect(api.getProvider()?.__wallet).toBe("walletB");
    expect(api.getProvider()).toBe(fastB.provider);
  });

  it("a slow resolution cannot resurrect a wallet after disconnect", async () => {
    const slowA = deferredConnector("walletA");

    connectAs(ADDR_A, slowA.connector);
    const pendingA = api.getActiveWalletProvider();
    await settle(); // A is now genuinely parked on A's connector

    // Disconnected while A was still resolving.
    h.account = { address: undefined, isConnected: false, connector: undefined };
    await api.getActiveWalletProvider();
    expect(api.getProvider()).toBeNull();

    slowA.release();
    await pendingA;

    // Still disconnected. A late answer must not put a wallet back in play.
    expect(api.getProvider()).toBeNull();
  });

  it("the newest resolution still primes the cache (guard is not a no-op)", async () => {
    // Positive control: without this, a guard that rejected EVERY write would
    // pass both tests above while breaking the fix entirely.
    const only = deferredConnector("walletB");
    connectAs(ADDR_B, only.connector);
    only.release();
    await api.getActiveWalletProvider();
    expect(api.getProvider()).toBe(only.provider);
  });
});
