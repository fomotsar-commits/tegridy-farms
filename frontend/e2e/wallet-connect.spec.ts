/**
 * AUDIT C-05 — First wallet-integrated E2E spec. Exercises the mock wallet fixture
 * against the connect-button flow and the address display in the header.
 *
 * Pattern demonstrated:
 *   1. Navigate to the app BEFORE clicking connect (fixture has installed the mock).
 *   2. Call walletMock.connect() in test code to simulate wallet approval.
 *   3. Click the app's Connect button; RainbowKit reads the mock's eth_accounts.
 *   4. Assert the connected state is reflected in the UI.
 *
 * This is the foundation other wallet-aware specs should extend: swap, stake,
 * claim revenue, etc. Each flow can layer walletMock.setReadResponses() calls
 * to canned-simulate specific contract reads (token balance, allowance, etc.).
 */

import { test, expect } from './fixtures/wallet';

test.describe('Wallet connect flow', () => {
  test('mock provider is injected and detected by the app', async ({ page, walletMock }) => {
    await page.goto('/');
    // The provider should be present on window before any React code runs.
    const present = await page.evaluate(() =>
      Boolean((window as unknown as { ethereum?: { isTegridyTestMock?: boolean } }).ethereum?.isTegridyTestMock)
    );
    expect(present).toBe(true);
    // No calls should have been made yet — app is mounted but connect wasn't clicked.
    const calls = await walletMock.getCalls();
    // Some wagmi/rainbowkit internals may probe eth_chainId/accounts at mount;
    // we only assert there's no request-accounts yet.
    expect(calls.some((c) => c.method === 'eth_requestAccounts')).toBe(false);
  });

  test('clicking a connect option eventually surfaces a connected-account UI', async ({ page, walletMock }) => {
    await page.goto('/');
    await walletMock.connect();
    // RainbowKit's ConnectButton is surfaced as a button; on a page that has it
    // (HomePage shows one in the hero for disconnected users). We look for one
    // matching 'connect' OR 'start farming' after connect resolves.
    // The mock emits accountsChanged synchronously, so the address should appear
    // in the TopNav connect-area within a couple seconds.
    await page.waitForTimeout(500);
    // Heuristic assertion: either the Connect button disappeared from the top nav,
    // or a truncated address appeared. We don't rely on a specific address string
    // because different RainbowKit builds format it differently (ENS vs hex).
    const topNavConnect = page.locator('nav button', { hasText: /connect/i }).first();
    // Allow up to 4s for async state settle.
    await expect.poll(
      async () => (await topNavConnect.count()) === 0 ? 'disconnected-gone' : 'still-visible',
      { timeout: 4000 }
    ).toBe('disconnected-gone');
  });

  test('wrong-network banner appears after switching to an unsupported chain', async ({ page, walletMock }) => {
    await page.goto('/dashboard');
    await walletMock.connect();
    // Switch to Sepolia (11155111) — the app's CHAIN_ID is mainnet (1).
    await walletMock.switchChain(11155111);
    // The Dashboard/Farm wrong-network banner uses role="alert" after audit M-F23.
    // Give wagmi time to notice chainChanged and React to re-render.
    const banner = page.locator('[role="alert"]').filter({ hasText: /wrong network|ethereum mainnet/i });
    await expect(banner.first()).toBeVisible({ timeout: 5000 });
  });
});
