/**
 * AUDIT C-05 — Wallet-integrated E2E test foundation.
 *
 * Pattern: inject a mock EIP-1193 provider as window.ethereum BEFORE the app loads.
 * Tests drive the mock from Playwright-land via `page.evaluate`, and the app sees
 * exactly the JSON-RPC shape a real wallet would emit. No Anvil, MetaMask, or other
 * external dependency is required for this baseline; you can replace the mock's
 * in-memory backing with an Anvil fork URL (see ANVIL_BACKEND section at the bottom)
 * once you want true on-chain simulation.
 *
 * What the mock currently handles (enough for the UI happy-path specs):
 *   eth_chainId          — returns configured chainId (default 1)
 *   eth_accounts         — returns [testAccount] after connect(), [] before
 *   eth_requestAccounts  — connects and returns [testAccount]
 *   personal_sign        — returns a canned signature (doesn't really sign)
 *   wallet_switchEthereumChain — updates chainId and emits chainChanged
 *   eth_call / eth_blockNumber / eth_getBalance — returns canned defaults; override
 *     per-test via `walletMock.setReadResponses({...})`
 *
 * What it does NOT handle:
 *   - Real signatures / transactions that the chain needs to accept. Any test that
 *     asserts on-chain state changes must be paired with an Anvil backend.
 *
 * Usage:
 *   import { test } from './fixtures/wallet';
 *   test('connects and shows address', async ({ page, walletMock }) => {
 *     await page.goto('/');
 *     await walletMock.connect();
 *     await page.getByRole('button', { name: /connect/i }).click();
 *     await expect(page.getByText(/hoodhokage|0x/i)).toBeVisible();
 *   });
 */

import { test as base, expect, type Locator, type Page } from '@playwright/test';

const DEFAULT_ACCOUNT = '0x71be63f3384f5fb98995898a86b02fb2426c5788'; // Hardhat account #9
const DEFAULT_CHAIN_ID = 1; // Ethereum mainnet

// ANVIL_BACKEND. When ANVIL_RPC_URL is set, unhandled JSON-RPC is forwarded to a
// real anvil node instead of being answered with canned values — which is what
// turns the `test.skip(!onAnvil, …)` specs in stake/swap/liquidity/lending/
// claim-rewards into genuine end-to-end flows. Unset, behaviour is byte-identical
// to before: canned reads, no network.
const ANVIL_RPC_URL = process.env.ANVIL_RPC_URL;

/** Live TOWELI. Mirrors src/lib/constants.ts; the specs gate CTAs on this balance. */
const TOWELI = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D';

// ─── NFT-lending fixture constants ───────────────────────────────────────
// The deployed NFT lending market (constants.ts TEGRIDY_NFT_LENDING_ADDRESS) and
// Nakamigos, one of the three collections NFTLendingSection accepts as collateral
// (NFTLendingSection.tsx:33-37). Measured on a live fork: offerCount() is 0 on
// mainnet, so the borrow tab has nothing to show until this fixture plants one.
const NFT_LENDING = '0x89BeB6cc0255B7465c01aA38a6f937efd345f14F';
const NAKAMIGOS = '0xd774557b647330C91Bf44cfEAB205095f7E6c367';
/** Anvil/hardhat account #1 — plays the lender. No key: the node signs by impersonation. */
const LENDER_ACCOUNT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OFFER_PRINCIPAL_WEI = 10n ** 17n; // 0.1 ETH
const OFFER_APR_BPS = 1000n;            // 10%
const OFFER_DURATION_S = 7n * 24n * 60n * 60n;

// EVERY SEEDED LOAN GETS ITS OWN TOKEN, and that is not tidiness — it is the only thing
// stopping this fixture from wrecking a loan another test is mid-way through. All the
// specs share ONE anvil node, so if two of them collateralised the same Nakamigos the
// second `transferFrom` would be impersonating the lending market itself and would pull
// the NFT straight back out of a live loan. The pid term keeps the ranges apart when
// Playwright runs workers in parallel (each worker is its own process); the sequence
// keeps them apart within a worker. 19,000 keeps every id inside the 20k supply.
const COLLATERAL_ID_BASE = 1 + ((process.pid * 137) % 19_000);
let collateralIdSeq = 0;

/**
 * Mint a wallet address no other test on this fork is using.
 *
 * No key exists for it and none is needed: the bridge signs by
 * `anvil_impersonateAccount`, so an address the node has never heard of transacts
 * exactly like a funded EOA. The pid keeps parallel workers apart (each is its own
 * process), the sequence keeps tests within a worker apart, and the 0xe2e prefix makes
 * these obvious in a trace.
 */
let forkAccountSeq = 0;
function deriveForkAccount(): string {
  const tail = process.pid.toString(16).padStart(8, '0') + (forkAccountSeq++).toString(16).padStart(8, '0');
  return `0xe2e${'0'.repeat(40 - 3 - tail.length)}${tail}`;
}

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * Assert a transaction receipt link appeared — one that could not have been on the page
 * before the action.
 *
 * ⚠ EVERY money-path spec used to do this instead:
 *     page.locator('a[href*="etherscan"], a[href*="explorer"]').first()
 * and that is a FALSE GREEN. Measured on /swap with no wallet and no transaction: one
 * such link is already present and visible — the static TOWELI token link
 * (`etherscan.io/token/0x420698…`, "Etherscan ↗"). Several surfaces carry similar
 * standing links.
 *
 * The consequence was worse than a weak assertion. In liquidity.spec.ts it let the spec
 * sail past a supply that never landed and fail four lines later on a missing remove
 * button — pointing the reader at the wrong step entirely. A receipt link points at
 * `/tx/0x<64 hex>`, and nothing static does.
 *
 * Lives here, not copy-pasted per spec, because the original was fixed in swap.spec.ts
 * alone and survived in five other places.
 *
 * ⚠ SECOND FALSE GREEN, closed by `notHash`. A multi-step spec (add → remove, borrow →
 * repay) asserts a receipt after EACH leg, and these surfaces render ONE receipt line
 * that they overwrite in place. So leg two's assertion is satisfied by leg ONE's link,
 * still sitting on the page — the second transaction need never have happened. Pass the
 * hash the previous leg returned and this waits for a link pointing somewhere else.
 *
 * Returns the transaction hash it matched, so the next leg can demand a different one.
 */
export async function expectTxReceipt(page: Page, what: string, notHash?: string): Promise<string> {
  const link = page.locator('a[href*="/tx/0x"]');
  await expect(
    link.first(),
    `${what}: no explorer link to a transaction hash appeared. A receipt link points at ` +
      `/tx/0x…; the static token link on these pages is NOT a receipt and must not satisfy this.`,
  ).toBeVisible({ timeout: 30_000 });
  await expect(link.first()).toHaveAttribute('href', /\/tx\/0x[0-9a-fA-F]{64}/);
  if (notHash) {
    await expect(
      link.first(),
      `${what}: the only receipt on the page is still the PREVIOUS step's (${notHash}). ` +
        `This step's transaction never confirmed — the stale link must not satisfy this leg.`,
    ).not.toHaveAttribute('href', new RegExp(notHash, 'i'), { timeout: 30_000 });
  }
  const href = (await link.first().getAttribute('href')) ?? '';
  const hash = /0x[0-9a-fA-F]{64}/.exec(href)?.[0];
  if (!hash) throw new Error(`${what}: receipt href ${href} carried no 0x<64 hex> hash.`);
  return hash;
}

/**
 * Walk a self-relabelling `approve → act` CTA to its ACT state, and prove it got there.
 *
 * ⚠ THIS IS THE BUG THAT KEPT THREE ANVIL LEGS RED, and it was never a missing fixture.
 * Every money surface here renders ONE button that renames itself: "Approve TOWELI" while
 * the allowance is short, the real verb ("Stake & Lock for 90 Days", "Grow the Crop")
 * once it is not. A spec that clicks that button ONCE, on a cold fork, spends its click
 * on the APPROVAL — and an approval deliberately surfaces no `/tx/0x…` receipt
 * (FarmPage.tsx tags it precisely so no stake receipt is fabricated). The spec then waits
 * out its receipt budget for a transaction it never sent.
 *
 * Measured, not theorised: stake.spec.ts:57 failed at `expectTxReceipt` on attempt 0 and
 * PASSED on retry #1 in 3.6s, both locally and in CI run 32598383834 — because attempt 0
 * left the allowance on the fork, so retry #1 found the CTA already reading "Stake &
 * Lock" and actually staked. The green retry was the accident; the red first attempt was
 * the honest report.
 *
 * What this does NOT do: it does not accept the approve as the action. It requires the
 * CTA to arrive at `actVerb` and be enabled, so the caller's click is always the real
 * transaction. An approval that never confirms fails here, loudly, naming the label it
 * was stuck on.
 */
export async function advancePastApproval(cta: Locator, actVerb: RegExp, what: string): Promise<void> {
  await expect(cta, `${what}: no action CTA rendered on this card at all.`).toBeVisible({ timeout: 20_000 });

  // Bounded, not `while`: the deepest cascade on these surfaces is two approvals (both
  // sides of a pair). A CTA that never leaves the approve state must fail, not spin.
  for (let step = 0; step < 2; step++) {
    const label = ((await cta.textContent()) ?? '').trim();
    if (!/^approve/i.test(label)) break;
    await expect(cta, `${what}: "${label}" rendered but is disabled — the approval cannot be sent.`)
      .toBeEnabled({ timeout: 20_000 });
    await cta.click();
    // An approval surfaces no receipt link by design. What proves it landed on the fork
    // is the allowance refetch relabelling THIS button, so wait that out — through the
    // transient "Granting permission…" the pending state renders.
    await expect(
      cta,
      `${what}: "${label}" never cleared. The approval did not confirm on the fork, so the ` +
        `real action below could never be reached.`,
    ).not.toHaveText(/^(approve|granting permission)/i, { timeout: 30_000 });
  }

  await expect(
    cta,
    `${what}: the CTA never reached ${actVerb} — it is showing a state that is neither an ` +
      `approval nor the action, so the precondition this leg needs is genuinely absent.`,
  ).toHaveText(actVerb, { timeout: 20_000 });
  await expect(cta, `${what}: the CTA reached ${actVerb} but stayed disabled.`)
    .toBeEnabled({ timeout: 20_000 });
}

/**
 * Give `holder` an ERC-20 balance on the fork by writing the balance slot directly.
 *
 * THE SLOT IS DISCOVERED, NOT HARDCODED, and that is the whole point. `balanceOf` is
 * `_balances[holder]` at `keccak256(abi.encode(holder, N))` for some mapping slot N —
 * and N depends on the contract's storage layout. The live TOWELI is NOT this repo's
 * Toweli.sol: it is a generator template ("Towelie", ERC20 + ERC20Burnable +
 * Ownable2Step + Initializable), so N is not the 0 you would get from a textbook
 * OpenZeppelin ERC20, and nothing in this repo pins its layout.
 *
 * A hardcoded slot would not throw. It would write to an unrelated slot, leave
 * balanceOf at 0, and hand the spec back the exact "CTA never enabled" timeout this
 * function exists to remove — a fixture that looks like it ran and did nothing. So we
 * probe: write a sentinel, read balanceOf back through the contract's OWN getter, and
 * keep the slot only if the getter agrees. Self-verifying by construction.
 *
 * Every probe is undone before moving on, so a wrong guess leaves no residue.
 */
async function seedErc20Balance(rpc: Rpc, token: string, holder: string, amount: bigint): Promise<void> {
  const { keccak256, encodeAbiParameters, parseAbiParameters, toHex, pad } = await import('viem');
  const balanceOfCall = `0x70a08231${pad(holder as `0x${string}`, { size: 32 }).slice(2)}`;

  const readBalance = async (): Promise<bigint> => {
    const hex = (await rpc('eth_call', [{ to: token, data: balanceOfCall }, 'latest'])) as string;
    return hex && hex !== '0x' ? BigInt(hex) : 0n;
  };

  const before = await readBalance();
  if (before >= amount) return; // already rich enough — nothing to do

  const sentinel = pad(toHex(amount), { size: 32 });
  for (let slot = 0; slot < 64; slot++) {
    const key = keccak256(
      encodeAbiParameters(parseAbiParameters('address, uint256'), [holder as `0x${string}`, BigInt(slot)]),
    );
    const prior = (await rpc('eth_getStorageAt', [token, key, 'latest'])) as string;
    await rpc('anvil_setStorageAt', [token, key, sentinel]);
    if ((await readBalance()) === amount) return; // the getter agrees — this is the slot
    await rpc('anvil_setStorageAt', [token, key, prior]); // wrong guess, leave no trace
  }

  // FAIL LOUD. Silently continuing hands the spec a timeout whose message blames the
  // product ("CTA never enabled") for a fixture that could not find the slot.
  throw new Error(
    `seedErc20Balance: could not locate the balance slot for ${token} in slots 0-63. ` +
      `The token's storage layout changed, or it proxies balanceOf. Do NOT hardcode a slot ` +
      `to work around this — find out why the probe failed.`,
  );
}

/**
 * Talk to the anvil fork directly from Node (cheatcodes included).
 *
 * Used by specs whose precondition is TIME rather than balance — reward accrual is the
 * only one today. Advancing the clock makes the contract's OWN accrual math produce the
 * rewards, which is the difference between testing the claim path and testing a number
 * we wrote into storage ourselves. Throws if ANVIL_RPC_URL is unset, so a mock-mode run
 * can never silently skip the step and leave the assertion below asserting nothing.
 */
export async function anvilRpc(method: string, params: unknown[] = []): Promise<unknown> {
  if (!ANVIL_RPC_URL) {
    throw new Error(`anvilRpc(${method}) called with ANVIL_RPC_URL unset — this is an Anvil-only path.`);
  }
  const res = await fetch(ANVIL_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (!res.ok) throw new Error(`anvil ${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`anvil ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * Move the fork's clock forward and mine, so time-based accrual actually advances.
 *
 * ⚠ KEEP THE JUMP SMALL — WELL UNDER 1800 SECONDS. The skew is PERMANENT: anvil has no
 * way back, and every later spec on this node inherits it. The routers stamp their
 * deadline from the BROWSER's clock (`Date.now()/1000 + 1800`, useAddLiquidity.ts:258),
 * so once the chain runs more than 30 minutes ahead of the runner, every add, remove and
 * swap reverts EXPIRED. Measured: a seven-day jump in claim-rewards.spec took out the
 * liquidity and swap anvil legs downstream while passing itself — a spec silently
 * breaking two others through the clock. Prefer staking more over waiting longer.
 */
export async function advanceForkTime(seconds: number): Promise<void> {
  await anvilRpc('evm_increaseTime', [seconds]);
  await anvilRpc('evm_mine', []);
}

/**
 * Plant the ONE precondition the NFT-lending borrow leg needs and mainnet does not have.
 *
 * Measured, not assumed: `offerCount()` at the deployed market is 0 on mainnet at head,
 * and the test account owns no NFT from any accepted collection. Neither can be conjured
 * with `anvil_setBalance` — the borrow tab renders offers straight out of the contract,
 * and the accept reverts unless the borrower owns the exact tokenId the lender pinned.
 *
 * NOTHING PRIVILEGED HAPPENS HERE. `createOffer` is payable and permissionless, so the
 * lender leg is a transaction any address could send; the only cheatcode is
 * `anvil_impersonateAccount`, used to move one Nakamigos out of its current holder's
 * wallet and to sign for the lender without a key. No storage is hand-written, no
 * owner-only function is called, and no protocol invariant is forged — the offer this
 * creates is one the real contract created, through its own code path.
 *
 * Self-verifying, in the same spirit as seedErc20Balance: both halves are read back
 * through the contracts' own getters and a failure throws with the reason, because a
 * silent no-op here hands the spec a "no borrowable offer" timeout that blames the
 * product for a fixture that did nothing.
 */
async function seedNftLendingOffer(rpc: Rpc, borrower: string): Promise<void> {
  const { encodeFunctionData, parseAbi, decodeAbiParameters, parseAbiParameters } = await import('viem');
  const tokenId = BigInt(COLLATERAL_ID_BASE + collateralIdSeq++);

  const erc721 = parseAbi([
    'function ownerOf(uint256) view returns (address)',
    'function transferFrom(address,address,uint256)',
  ]);
  const market = parseAbi([
    'function offerCount() view returns (uint256)',
    'function createOffer(uint256,uint256,uint256,address,uint256,uint64) payable returns (uint256)',
  ]);

  const call = async (to: string, data: string): Promise<`0x${string}`> =>
    (await rpc('eth_call', [{ to, data }, 'latest'])) as `0x${string}`;

  const sendFrom = async (from: string, to: string, data: string, value?: bigint): Promise<void> => {
    await rpc('anvil_impersonateAccount', [from]);
    const hash = (await rpc('eth_sendTransaction', [
      { from, to, data, ...(value !== undefined ? { value: `0x${value.toString(16)}` } : {}) },
    ])) as string;
    // Anvil automines, but never assume it: a transaction that reverted still has a
    // receipt, and a fixture that ignores `status` is a fixture that silently no-ops.
    for (let i = 0; i < 40; i++) {
      const receipt = (await rpc('eth_getTransactionReceipt', [hash])) as { status?: string } | null;
      if (receipt) {
        if (receipt.status !== '0x1') {
          throw new Error(`seedNftLendingOffer: tx to ${to} REVERTED on the fork (${hash}).`);
        }
        await rpc('anvil_stopImpersonatingAccount', [from]);
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`seedNftLendingOffer: tx to ${to} never produced a receipt (${hash}).`);
  };

  const ownerOfToken = async (): Promise<string> => {
    const raw = await call(NAKAMIGOS, encodeFunctionData({ abi: erc721, functionName: 'ownerOf', args: [tokenId] }));
    return (decodeAbiParameters(parseAbiParameters('address'), raw)[0] as string).toLowerCase();
  };

  // 1. Put the collateral in the test account's hands.
  const holder = await ownerOfToken();
  // NEVER PULL COLLATERAL OUT OF A LIVE LOAN. Impersonating the market would let this
  // transfer succeed and silently break whichever test is holding that loan open, so
  // stop with the reason instead — the id scheme above is what should prevent it.
  if (holder === NFT_LENDING.toLowerCase()) {
    throw new Error(
      `seedNftLendingOffer: Nakamigos #${tokenId} is locked in the lending market as live collateral. ` +
        `Two seeds collided on one token; do NOT reclaim it — widen COLLATERAL_ID_BASE instead.`,
    );
  }
  if (holder !== borrower.toLowerCase()) {
    await rpc('anvil_setBalance', [holder, '0x8ac7230489e80000']); // 10 ETH for gas
    await sendFrom(
      holder,
      NAKAMIGOS,
      encodeFunctionData({
        abi: erc721,
        functionName: 'transferFrom',
        args: [holder as `0x${string}`, borrower as `0x${string}`, tokenId],
      }),
    );
  }

  // 2. Post a lender offer against that exact token.
  //
  // The expiry is read off the FORK's clock, not the runner's. The contract rejects an
  // out-of-window validity with `InvalidOfferValidity` (measured: a year-2100 expiry
  // reverts), and a fork pinned to an old block would drift out of that window if this
  // used Date.now().
  const block = (await rpc('eth_getBlockByNumber', ['latest', false])) as { timestamp: string };
  const expiry = BigInt(block.timestamp) + 30n * 24n * 60n * 60n;
  await rpc('anvil_setBalance', [LENDER_ACCOUNT, '0x21e19e0c9bab2400000']); // 10,000 ETH
  await sendFrom(
    LENDER_ACCOUNT,
    NFT_LENDING,
    encodeFunctionData({
      abi: market,
      functionName: 'createOffer',
      args: [OFFER_PRINCIPAL_WEI, OFFER_APR_BPS, OFFER_DURATION_S, NAKAMIGOS as `0x${string}`, tokenId, expiry],
    }),
    OFFER_PRINCIPAL_WEI,
  );

  // 3. Read both halves back through the contracts' own getters.
  const finalHolder = await ownerOfToken();
  if (finalHolder !== borrower.toLowerCase()) {
    throw new Error(
      `seedNftLendingOffer: the collateral transfer did not take — Nakamigos #${tokenId} is still held by ${finalHolder}.`,
    );
  }
  const countRaw = await call(NFT_LENDING, encodeFunctionData({ abi: market, functionName: 'offerCount' }));
  const count = BigInt(countRaw);
  if (count === 0n) {
    throw new Error(
      'seedNftLendingOffer: createOffer confirmed but offerCount() is still 0 — the market did not record the offer.',
    );
  }
}

export interface WalletMock {
  /**
   * Mark the mock as connected; eth_accounts now returns [account].
   *
   * Safe to call BEFORE the first `page.goto`, and that is the form you want
   * for anything that asserts a CONNECTED surface — see the note on
   * `__walletMockConnected` in installWalletMock.
   */
  connect: (account?: string) => Promise<void>;
  /** Mark the mock as disconnected. */
  disconnect: () => Promise<void>;
  /** Switch chain and emit chainChanged. */
  switchChain: (chainId: number) => Promise<void>;
  /** Override eth_call / eth_getBalance responses by method + optional data prefix. */
  setReadResponses: (map: Record<string, string>) => Promise<void>;
  /** Capture all JSON-RPC calls the app has made since mock install. */
  getCalls: () => Promise<Array<{ method: string; params: unknown }>>;
  /**
   * Fund a wallet no other test uses, and return it. Anvil-only.
   *
   * ANY state-changing leg must call this and connect with the address it returns.
   * The shared fork keeps every position, allowance, LP balance and loan a spec
   * creates, so two legs sharing DEFAULT_ACCOUNT contaminate each other — see the
   * block above `export const test` for the measurement and for why evm_revert is
   * not the answer.
   *
   * Pass `nftCollateral` to also place a Nakamigos in the account and post a lender
   * offer against it, which is the borrow leg's precondition.
   */
  useIsolatedForkAccount: (opts?: { nftCollateral?: boolean }) => Promise<string>;
}

type Fixtures = { walletMock: WalletMock };

// ─── FORK ISOLATION — CLOSED 2026-08-22, but NOT with evm_snapshot ───────────────
//
// The problem is real and was measured here, batching the five money specs at
// --workers=1: swap's anvil leg and BOTH of stake.spec's connected tests went red
// purely because an earlier spec had already opened a staking position on the shared
// chain. /farm then renders "Your Position" instead of the amount input, so `fill()`
// had nothing to type into. Alone, every one of them passed.
//
// ⚠ DO NOT REACH FOR evm_snapshot/evm_revert. It was tried in 2026-08-12, reverted,
// and tried again here — and the second attempt found the real reason it must not be
// used: on anvil 1.5.1 against a mainnet fork that has been transacted on, `evm_revert`
// WEDGES THE NODE. Measured twice, both times with the node's own log ending on the
// `evm_revert` line: once it stopped listening outright (every later spec then failed
// with ECONNREFUSED at 127.0.0.1:8545) and once it hung until the teardown blew the
// test timeout. Taking the snapshot after seeding, and unloading the page before
// reverting so no traffic was in flight, changed nothing.
//
// So isolation is by ADDRESS instead, which needs no cheatcode at all beyond the
// impersonation the bridge already does: `useIsolatedForkAccount()` hands each
// state-changing leg its own freshly funded account. Two tests cannot collide over a
// position, an allowance, an LP balance or a loan if they never share a wallet. It also
// stays correct under parallel workers, which a shared snapshot stack never could.
//
// DEFAULT_ACCOUNT is left alone by every leg that spends, which is what keeps the
// mock-mode render specs (and heat-gate.spec.ts, which pins that address in its own
// fixture payload) seeing the cold, unspent wallet they were written against.
export const test = base.extend<Fixtures>({
  walletMock: async ({ page }, provide, testInfo) => {
    // Suppress full-viewport overlays that block clicks in test runs:
    //   - AppLoader splash canvas (zIndex 9999)
    //   - OnboardingModal welcome dialog (zIndex 100)
    // Both self-dismiss on repeat visits by checking storage flags; pre-seed
    // the flags before nav so they short-circuit on mount.
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem('tf_loaded', '1');
        localStorage.setItem('tegridy-onboarding-seen', '1');
      } catch { /* ignore */ }
    });
    await installWalletMock(page);
    const mock: WalletMock = {
      connect: async (account = DEFAULT_ACCOUNT) => {
        // TWO writes, and both are load-bearing.
        //
        // 1. An init script, so the account survives navigation AND is already
        //    there when wagmi's reconnect() runs on mount. That is the only
        //    window in which the app can end up genuinely connected: reconnect
        //    calls injected.isAuthorized(), which is just `eth_accounts` being
        //    non-empty. Before this existed, every "connected" spec ran against
        //    a wallet the app had never authorized — the surfaces they asserted
        //    on were the DISCONNECTED ones, and the assertions were vacuous.
        // 2. A live evaluate for the already-loaded case, best-effort because
        //    connect() is legitimately called before the first navigation.
        await page.addInitScript(
          ([addr]) => {
            (window as unknown as { __walletMockConnected?: string }).__walletMockConnected = addr;
          },
          [account]
        );
        await page
          .evaluate(
            ([addr]) => (window as unknown as { __walletMock?: { connect: (a: string) => void } }).__walletMock?.connect(addr!),
            [account]
          )
          .catch(() => { /* no document yet — the init script covers the next load */ });
      },
      disconnect: async () => {
        await page.addInitScript(() => {
          (window as unknown as { __walletMockConnected?: string }).__walletMockConnected = undefined;
        });
        await page
          .evaluate(() =>
            (window as unknown as { __walletMock?: { disconnect: () => void } }).__walletMock?.disconnect()
          )
          .catch(() => { /* nothing loaded */ });
      },
      switchChain: async (chainId) => {
        await page.evaluate(
          ([id]) => (window as unknown as { __walletMock: { switchChain: (n: number) => void } }).__walletMock.switchChain(id!),
          [chainId]
        );
      },
      setReadResponses: async (map) => {
        await page.evaluate(
          ([m]) => (window as unknown as { __walletMock: { setReadResponses: (x: Record<string, string>) => void } }).__walletMock.setReadResponses(m!),
          [map]
        );
      },
      getCalls: async () =>
        page.evaluate(() =>
          (window as unknown as { __walletMock: { getCalls: () => Array<{ method: string; params: unknown }> } }).__walletMock.getCalls()
        ),
      useIsolatedForkAccount: async (opts) => {
        if (!ANVIL_RPC_URL) {
          throw new Error(
            `useIsolatedForkAccount() called from "${testInfo.title}" with ANVIL_RPC_URL unset. ` +
              `It is an Anvil-only path — gate the leg on test.skip(!onAnvil, …) first.`,
          );
        }
        const account = deriveForkAccount();
        const rpc: Rpc = (method, params) => anvilRpc(method, params);
        await rpc('anvil_setBalance', [account, '0x21e19e0c9bab2400000']); // 10,000 ETH
        await seedErc20Balance(rpc, TOWELI, account, 1_000_000n * 10n ** 18n);
        if (opts?.nftCollateral) await seedNftLendingOffer(rpc, account);
        return account;
      },
    };
    await provide(mock);
  },
});

export { expect };

/**
 * Installed BEFORE the app bundle evaluates. Anything inside must be self-contained
 * because Playwright serializes the function body across the page boundary.
 */
async function installWalletMock(page: Page): Promise<void> {
  // Must be exposed BEFORE the init script runs, and it survives navigation.
  if (ANVIL_RPC_URL) await installAnvilBridge(page, ANVIL_RPC_URL);
  await page.addInitScript(
    ([account, chainId, anvilEnabled]) => {
      type Listener = (...args: unknown[]) => void;
      const listeners: Record<string, Set<Listener>> = {};
      const calls: Array<{ method: string; params: unknown }> = [];
      let connectedAccounts: string[] = [];
      let currentChainId = chainId as number;
      const reads: Record<string, string> = {
        eth_blockNumber: '0x1234567',
        eth_getBalance: '0xde0b6b3a7640000', // 1 ETH
      };

      function emit(event: string, ...args: unknown[]): void {
        listeners[event]?.forEach((cb) => cb(...args));
      }

      // Read LAZILY, never at install time. `connect()` seeds
      // `__walletMockConnected` with its own addInitScript, which necessarily
      // runs AFTER this one on every document; by the time the app asks for
      // accounts both have run, so the ordering resolves itself. Reading it
      // eagerly here would always see undefined.
      function accountsNow(): string[] {
        if (connectedAccounts.length) return connectedAccounts;
        const seeded = (window as unknown as { __walletMockConnected?: string }).__walletMockConnected;
        if (seeded) connectedAccounts = [seeded];
        return connectedAccounts;
      }

      const provider = {
        isMetaMask: false,
        isTegridyTestMock: true,
        async request(args: { method: string; params?: unknown }) {
          calls.push({ method: args.method, params: args.params });
          switch (args.method) {
            case 'eth_chainId':
              return `0x${currentChainId.toString(16)}`;
            case 'eth_accounts':
              return accountsNow();
            case 'eth_requestAccounts': {
              connectedAccounts = [account as string];
              emit('accountsChanged', connectedAccounts);
              return connectedAccounts;
            }
            case 'wallet_requestPermissions':
              // RainbowKit / wagmi's injected connector asks for this before
              // eth_requestAccounts on some paths; returning null makes it fall
              // through to eth_requestAccounts rather than throwing.
              return null;
            case 'personal_sign':
              return '0x' + '00'.repeat(64) + '1b';
            case 'wallet_switchEthereumChain': {
              const chainHex = (args.params as Array<{ chainId: string }>)[0]?.chainId;
              if (chainHex) {
                currentChainId = parseInt(chainHex, 16);
                emit('chainChanged', chainHex);
              }
              return null;
            }
            default: {
              // ANVIL_BACKEND step 2 — forward anything we do not emulate to the
              // real node. Reached by eth_call, eth_estimateGas, eth_getBalance,
              // eth_blockNumber, eth_getTransactionReceipt, eth_sendTransaction…
              // i.e. everything a state-changing flow actually needs.
              const bridge = (
                window as unknown as {
                  __tegridyAnvilRpc?: (m: string, p: unknown[]) => Promise<unknown>;
                }
              ).__tegridyAnvilRpc;
              if (anvilEnabled && typeof bridge === 'function') {
                return await bridge(args.method, (args.params as unknown[]) ?? []);
              }
              const override = reads[args.method];
              if (override !== undefined) return override;
              return null;
            }
          }
        },
        on(event: string, cb: Listener) {
          (listeners[event] ||= new Set()).add(cb);
        },
        removeListener(event: string, cb: Listener) {
          listeners[event]?.delete(cb);
        },
      };

      (window as unknown as { ethereum: typeof provider }).ethereum = provider;

      // EIP-6963 announcement. Setting window.ethereum alone is NOT enough for
      // this app: it builds its wagmi config through RainbowKit's
      // getDefaultConfig, and wagmi's `multiInjectedProviderDiscovery` is what
      // turns a browser wallet into a connector there. Without an announcement
      // the app never so much as calls `eth_accounts` on the mock — verified:
      // `__walletMock.getCalls()` came back EMPTY after a full page load, which
      // is what made every "connected" assertion in the money-path specs an
      // assertion about the DISCONNECTED surface.
      const providerInfo = {
        uuid: '11111111-2222-3333-4444-555555555555',
        name: 'Tegridy E2E Mock',
        // 1x1 transparent PNG — RainbowKit requires a data URI here.
        icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        rdns: 'farms.tegridy.e2emock',
      };
      const announce = () => {
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({ info: providerInfo, provider }),
          }),
        );
      };
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
      (window as unknown as { __walletMock: Record<string, unknown> }).__walletMock = {
        connect: (addr: string) => {
          connectedAccounts = [addr];
          emit('accountsChanged', connectedAccounts);
        },
        disconnect: () => {
          connectedAccounts = [];
          // Clear the seed too, or `accountsNow()` re-authorizes the account on
          // the very next `eth_accounts` and the disconnect silently undoes
          // itself. The fixture's addInitScript only affects the NEXT document.
          (window as unknown as { __walletMockConnected?: string }).__walletMockConnected = undefined;
          emit('accountsChanged', []);
        },
        switchChain: (id: number) => {
          currentChainId = id;
          emit('chainChanged', `0x${id.toString(16)}`);
        },
        setReadResponses: (map: Record<string, string>) => {
          Object.assign(reads, map);
        },
        getCalls: () => calls,
      };
    },
    [DEFAULT_ACCOUNT, DEFAULT_CHAIN_ID, !!ANVIL_RPC_URL] as [string, number, boolean]
  );
}

/**
 * ANVIL_BACKEND steps 2-4. Forwards JSON-RPC from the page's injected provider to
 * a real anvil node.
 *
 * The forwarding deliberately happens HERE, in Node, not in the page:
 *   * no CORS — the page never talks to 127.0.0.1 directly
 *   * anvil's `anvil_*` cheatcodes are reachable, which is what lets us send
 *     transactions with NO PRIVATE KEY anywhere in the test suite
 */
/**
 * The app's READ path never touches the wallet.
 *
 * wagmi answers useBalance / useReadContract through the `transports` in
 * src/lib/wagmi.ts — three public mainnet RPCs — and only sends WRITES through
 * the connector. So pointing the wallet at a fork moves the transactions and
 * leaves every balance, allowance and quote reading real mainnet, where the
 * test account holds nothing. `anvil_setBalance` funds an account the app then
 * never asks about, and every CTA stays disabled behind "insufficient balance".
 *
 * Redirecting those hosts at the browser is the whole fix, and it keeps the fix
 * in the test: no VITE_ override to add to src/, nothing that can leak into a
 * production build. Unset ANVIL_RPC_URL and not a single route is installed.
 */
const APP_RPC_HOSTS = [
  'https://ethereum-rpc.publicnode.com/**',
  'https://eth.drpc.org/**',
  'https://eth.merkle.io/**',
];

async function routeAppReadsToAnvil(page: Page, rpcUrl: string): Promise<void> {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'POST,OPTIONS',
  };
  for (const pattern of APP_RPC_HOSTS) {
    await page.route(pattern, async (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: cors, body: '' });
        return;
      }
      try {
        const upstream = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: request.postData() ?? '',
        });
        await route.fulfill({
          status: upstream.status,
          headers: { ...cors, 'content-type': 'application/json' },
          body: await upstream.text(),
        });
      } catch (e) {
        // Fail the request rather than letting it fall through to real
        // mainnet — a silent fallback would make the fork invisible and the
        // assertions meaningless again.
        await route.abort('failed');
        throw e;
      }
    });
  }
}

async function installAnvilBridge(page: Page, rpcUrl: string): Promise<void> {
  let nextId = 1;

  await routeAppReadsToAnvil(page, rpcUrl);

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    if (!res.ok) throw new Error(`anvil ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`anvil ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  }

  // ANVIL_BACKEND step 3 — CORRECTED. The original TODO said DEFAULT_ACCOUNT is
  // "one of Anvil's pre-funded accounts", which is true for a FRESH anvil chain
  // and FALSE when forking: a fork inherits mainnet state, and account #9 holds
  // 0 ETH on mainnet. Verified — eth_getBalance returned 0x0 on a live fork.
  // So fund it explicitly. anvil_setBalance needs no key and no faucet.
  await rpc('anvil_setBalance', [DEFAULT_ACCOUNT, '0x21e19e0c9bab2400000']); // 10,000 ETH

  // ANVIL_BACKEND step 5 — ERC-20 balance. ETH alone is not enough.
  //
  // Four money-path specs failed on a live fork with their own named messages —
  // "stake CTA never enabled — the fork account holds no TOWELI", and the same for
  // liquidity's paired side. A mainnet fork inherits mainnet state, and the test
  // account holds no TOWELI there, so every CTA that gates on a token balance stays
  // disabled and the leg times out. That is a MISSING FIXTURE, not a product defect,
  // and it is what kept these specs skipped for months.
  await seedErc20Balance(rpc, TOWELI, DEFAULT_ACCOUNT, 1_000_000n * 10n ** 18n);

  // ANVIL_BACKEND step 6 — PROTOCOL state, not just balances, lives in
  // `walletMock.useIsolatedForkAccount()` rather than here. It is per-leg, not per-test:
  // the NFT-lending precondition costs two on-chain transactions and moves a real NFT,
  // and only one spec needs it. Seeding it for all ~20 tests in the fork job would be
  // 40 pointless transactions of protocol churn.

  await page.exposeFunction(
    '__tegridyAnvilRpc',
    async (method: string, params: unknown[] = []): Promise<unknown> => {
      // ANVIL_BACKEND step 4 — sign without a key. `anvil_impersonateAccount`
      // makes the node accept eth_sendTransaction from an address it holds no
      // key for, so DEFAULT_ACCOUNT (anvil/hardhat account #9, pre-funded on a
      // fresh fork) can transact and NO private key is ever handled by the
      // fixture, the specs, or CI.
      if (method === 'eth_sendTransaction') {
        const from = (params?.[0] as { from?: string } | undefined)?.from;
        if (from) await rpc('anvil_impersonateAccount', [from]);
      }
      return rpc(method, params);
    },
  );

}

// ─── ANVIL_BACKEND — IMPLEMENTED 2026-07-30 ──────────────────────────────
// This used to be a 4-step TODO. All four are now done, above:
//   1. Run anvil forking mainnet. Verified working against a KEYLESS RPC
//      (https://ethereum-rpc.publicnode.com) — no paid archive provider needed:
//        anvil --fork-url https://ethereum-rpc.publicnode.com --port 8545
//      Sanity check that the fork sees real state — TOWELI totalSupply via
//      eth_call returns 0x033b2e3c9fd0803ce8000000 (1e9 * 1e18).
//   2. Unhandled requests forward to anvil — see the `default:` case above.
//   3. DEFAULT_ACCOUNT is funded via `anvil_setBalance` at bridge-install time.
//      NOTE the original TODO was WRONG here: it said account #9 is "pre-funded",
//      which holds for a FRESH anvil chain but not for a FORK — a fork inherits
//      mainnet state, where that address has 0 ETH. Confirmed on a live fork
//      (eth_getBalance -> 0x0), hence the explicit top-up.
//   4. eth_sendTransaction is signed by the node via `anvil_impersonateAccount`,
//      so NO private key exists anywhere in this suite.
//
// To run the state-changing specs:
//   ANVIL_RPC_URL=http://127.0.0.1:8545 npx playwright test e2e/stake.spec.ts …
// With ANVIL_RPC_URL unset every one of those specs still skips exactly as
// before, and mock-mode behaviour is unchanged.
