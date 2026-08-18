/**
 * THE DOOR, end to end. `/launch` mounts <LaunchGate>, and until this spec existed the
 * whole launch surface had no browser coverage at all — the enforcement ORDER
 * (heat → custody → sign) was pinned only by unit tests against `meetsHeatFloor`, which
 * cannot see whether the rendered page offers a signature to a wallet the door refused.
 *
 * That is the property these tests are really for. A COLD wallet must be offered NO
 * signature prompt, because a prove-first door would be asking for a signature it has
 * already decided not to honour — and a STALE door must offer neither a signature nor a
 * verdict, because "we could not ask" is not an answer about anybody.
 *
 * THE ISLAND IS NEVER CONTACTED. Every reading here is stubbed at the network layer
 * (`/api/aggregator?resource=heat`), so these run offline, deterministically, and
 * without spending a third party's quota. `vite preview` serves a static build and has
 * no `/api` at all, so an unrouted request would 404 into STALE and quietly turn every
 * assertion below into an assertion about an outage.
 */

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';

/** Mirrors the fixture's DEFAULT_ACCOUNT — the wallet the mock connects. */
const WALLET = '0x71be63f3384f5fb98995898a86b02fb2426c5788';
const AUDIT_KEY = 'tegridy.heat.gate.audit.v1';

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * A well-formed island payload, in the oracle's own wire spelling.
 *
 * The breakdown row carries the SAME degrees as the total, because HeatCard checks the
 * two against each other and flags a disagreement — a fixture that ships a mismatch
 * would put a warning on screen that has nothing to do with what is being tested.
 */
function heatPayload({ degrees = 195.54, tier = 'Builder' } = {}) {
  const now = nowSec();
  return {
    address: WALLET,
    degrees,
    tier,
    is_cold: false,
    held_since_unix: now - 400 * 86_400,
    as_of_unix: now - 3_600,
    token_count: 1,
    breakdown: [
      {
        token_address: '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D',
        chain: 'ethereum',
        name: 'Towelie',
        symbol: 'TOWELI',
        heat_degrees: degrees,
        first_seen_at_unix: now - 400 * 86_400,
        last_transfer_at_unix: now - 30 * 86_400,
      },
    ],
  };
}

/**
 * Answer the heat resource with `reply`, and let every other aggregator call through.
 *
 * Matched on the `resource` query parameter rather than on the path, because the
 * aggregator is a single catchall function and swallowing its other resources here
 * would break page surfaces that have nothing to do with the door.
 */
async function stubHeat(page: Page, reply: { status: number; body?: unknown }): Promise<void> {
  await page.route('**/api/aggregator**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('resource') !== 'heat') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: reply.status,
      contentType: 'application/json',
      body: JSON.stringify(reply.body ?? { error: 'The instrument is unreachable.' }),
    });
  });
}

/** The gate's own region. Scoped so the wizard below it can never satisfy an assertion. */
const gate = (page: Page) => page.getByRole('region', { name: 'Who may plant' });

/** The three verdict words, and only those — the chip renders the state verbatim. */
const VERDICT = /^(WARM|COLD|STALE)$/;

/**
 * Open `/launch` and wait for the door to have actually ANSWERED.
 *
 * The wait is the load-bearing part. Two of the door's states are not verdicts at all
 * (no wallet connected, reading in flight) and both render the same heading and the same
 * frame as the three that are — so an assertion fired before the mock wallet's
 * `reconnect()` has resolved is an assertion against the no-wallet panel, which happens
 * to lack every element being looked for. That reads as "COLD did not render" when what
 * actually happened is that nothing was asked yet. Under parallel workers this raced
 * about one run in four before the wait existed; waiting for a verdict word removes the
 * race without weakening a single assertion below it.
 */
async function openLaunch(page: Page): Promise<ReturnType<typeof gate>> {
  await page.goto('/launch');
  const door = gate(page);
  await expect(door).toBeVisible({ timeout: 30_000 });
  await expect(door.getByText(VERDICT)).toBeVisible({ timeout: 30_000 });
  return door;
}

const COLD_READING = { degrees: 62.4, tier: 'Observer' };

test.describe('the launch door', () => {
  test('WARM opens the launch lane', async ({ page, walletMock }) => {
    await stubHeat(page, { status: 200, body: heatPayload() });
    await walletMock.connect();
    const door = await openLaunch(page);
    await expect(door.getByText('WARM', { exact: true })).toBeVisible();
    // The reading itself, not merely the verdict word.
    await expect(door.getByText(/195\.54° — Builder\. The launch lane is open\./)).toBeVisible();

    // Custody proof is the NEXT step, and it exists only because heat already passed.
    await expect(door.getByRole('button', { name: /prove this wallet is yours/i })).toBeVisible();
    await expect(door.getByText(/moves no funds, approves no tokens, and costs no gas/i)).toBeVisible();

    // The lane is not open until it is proved — the tick is the post-signature state.
    await expect(door.getByText('✓ The launch lane is open.')).toHaveCount(0);
  });

  test('COLD shows the wallet its own degrees and offers no lane', async ({ page, walletMock }) => {
    await stubHeat(page, { status: 200, body: heatPayload(COLD_READING) });
    await walletMock.connect();
    const door = await openLaunch(page);
    await expect(door.getByText('COLD', { exact: true })).toBeVisible();

    // The door's explanation, in its own words, with the floor named.
    await expect(door.getByText(/The door opens at 80°/).first()).toBeVisible();
    await expect(door.getByText(/it cannot be bought, and a larger bag does not buy it faster/i)).toBeVisible();

    // THIS WALLET'S OWN READING, from the embedded card — the point of the COLD state.
    // The breakdown heading is HeatCard's alone, so it cannot be satisfied by the
    // door's one-line detail quoting the same number.
    await expect(door.getByText(/Where the 62\.40° comes from/)).toBeVisible();
    // The reckoning date travels with the reading everywhere it is shown — a stale
    // ruler certifies nothing, so the card never renders degrees without it.
    await expect(door.getByText(/Reckoned .+ ago/)).toBeVisible();

    // NO LANE, AND NO SIGNATURE PROMPT. Heat precedes custody: a refused wallet is
    // never asked to sign for a door that has already answered.
    await expect(door.getByRole('button', { name: /prove this wallet is yours/i })).toHaveCount(0);
    for (const label of await door.getByRole('button').allInnerTexts()) {
      expect(label).not.toMatch(/sign|prove this wallet|launch lane is open/i);
    }
  });

  test('STALE renders the retry, and never a verdict', async ({ page, walletMock }) => {
    await stubHeat(page, { status: 503 });
    await walletMock.connect();
    const door = await openLaunch(page);
    await expect(door.getByText('STALE', { exact: true })).toBeVisible();
    await expect(door.getByText(/instrument is unreachable, so the door cannot read you/i)).toBeVisible();
    await expect(door.getByRole('button', { name: /read again/i })).toBeVisible();
    await expect(door.getByText(/No verdict has been recorded against you/i)).toBeVisible();

    // AN OUTAGE IS NOT A SCORE. No verdict word, no degrees, no tier, no signature.
    await expect(door.getByText('WARM', { exact: true })).toHaveCount(0);
    await expect(door.getByText('COLD', { exact: true })).toHaveCount(0);
    await expect(door.getByRole('button', { name: /prove this wallet is yours/i })).toHaveCount(0);
    expect(await door.innerText()).not.toMatch(/\d+\.\d{2}°/);
  });
});

test.describe('the audit panel', () => {
  /** A denial taken earlier, against a floor that has since moved. */
  const priorDenial = {
    id: 'gd_prior_denial_fixture',
    address: WALLET,
    degrees: 41.2,
    tier: 'Observer',
    as_of: 1_786_000_000,
    floor: 250,
    verdict: 'COLD',
    reason: 'below-floor',
    decided_at: 1_786_003_600,
  };

  test('surfaces a prior denial, against the floor it was actually taken on', async ({ page, walletMock }) => {
    await page.addInitScript(
      ([key, row]) => {
        try {
          localStorage.setItem(key as string, JSON.stringify([row]));
        } catch { /* private mode — the panel has its own state for that */ }
      },
      [AUDIT_KEY, priorDenial] as [string, typeof priorDenial],
    );
    await stubHeat(page, { status: 200, body: heatPayload(COLD_READING) });
    await walletMock.connect();
    const door = await openLaunch(page);
    // Collapsed by default: the reading is the answer, the ledger is the working.
    await expect(door.getByText('Floor at the time')).toHaveCount(0);
    const toggle = door.getByRole('button', { name: /why did the door answer this way\?/i });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();

    // The prior row, with ITS OWN inputs — not today's.
    await expect(door.getByText('41.20°', { exact: true })).toBeVisible();
    await expect(door.getByText('250°', { exact: true })).toBeVisible();
    await expect(door.getByText(/41\.20° measured against a 250° floor — short by 208\.80°/)).toBeVisible();
    // A moved floor is disclosed as a present-tense fact, never substituted into history.
    await expect(door.getByText(/The floor is 80° today\. This decision was taken against 250°/)).toBeVisible();

    // Reckoning date and decision time are separate fields, because they are separate facts.
    await expect(door.getByText('Island reckoned').first()).toBeVisible();
    await expect(door.getByText('Door decided').first()).toBeVisible();
  });

  test('logs the live denial into the same record the panel reads back', async ({ page, walletMock }) => {
    await stubHeat(page, { status: 200, body: heatPayload(COLD_READING) });
    await walletMock.connect();
    const door = await openLaunch(page);
    await door.getByRole('button', { name: /why did the door answer this way\?/i }).click();

    // Written by the door on read, read back by the panel — the whole round trip, in a
    // browser, which is the half no unit test can reach.
    await expect(door.getByText(/62\.40° measured against a 80° floor — short by 17\.60°/)).toBeVisible();
    await expect(door.getByText(/never sent anywhere, and it is not analytics/i)).toBeVisible();

    const stored = await page.evaluate((key) => localStorage.getItem(key), AUDIT_KEY);
    expect(stored).toContain('"verdict":"COLD"');
  });
});
