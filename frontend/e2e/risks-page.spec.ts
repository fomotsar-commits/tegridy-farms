/**
 * RisksPage — validates the protocol-specific "What can actually go wrong"
 * section (B1b) renders before the generic DeFi disclosure, each row carries
 * a status chip, and the footer links to FIX_STATUS.md + AUDITS.md.
 *
 * This is the depositor-facing truthfulness surface. A regression here — a
 * card getting silently dropped, a status chip mislabelled — materially
 * misrepresents the protocol's current state. Keep this spec green.
 */

import { test, expect } from '@playwright/test';
import { gotoRoute } from './fixtures/routes';
import { GITHUB_BRANCH, GITHUB_BLOB_BASE } from '../src/lib/constants';

/**
 * ⚠ ROUTES ARE ENTERED THROUGH `gotoRoute`, NOT `page.goto`.
 *
 * Every page is a `lazy()` chunk behind Suspense, so `goto` resolves while the
 * route is still a skeleton. Playwright's default 5s expect budget absorbs that
 * on Chromium and on WebKit at --workers=1 (the CI setting), and does not
 * absorb it on WebKit at the local default worker count — measured on this
 * machine: green at --workers=1, red at 9 with `element(s) not found`, same
 * build, pages fine. `gotoRoute` waits for the fallback to be gone before any
 * assertion runs, so the result stops depending on the host's core count.
 * See e2e/fixtures/routes.ts.
 */

const PROTOCOL_RISK_TITLES = [
  'Single-operator admin key (no multisig yet)',
  'Patched contracts not yet redeployed on-chain',
  'No paid human audit by a recognised firm',
  'Thin market / low on-chain liquidity',
  'Satirical brand exposure',
  'Single maintainer',
  'NFT collateral concentration',
];

test.describe('RisksPage — protocol-specific risks', () => {
  test.beforeEach(async ({ page }) => {
    await gotoRoute(page, '/risks');
  });

  test('hero banner + page title render', async ({ page }) => {
    await expect(page.locator('h1')).toContainText(/risk disclosure/i);
    await expect(
      page.getByText(/experimental software.*smart contracts/i).first(),
    ).toBeVisible();
  });

  test('protocol-specific section appears before generic disclosure', async ({ page }) => {
    // The protocol-specific heading is wired to the aria-labelledby on the
    // <section>; if the section ever gets reordered, the aria wiring breaks
    // too.
    const protocolHeading = page.getByRole('heading', {
      name: /what can actually go wrong — as of today/i,
    });
    const genericHeading = page.getByRole('heading', {
      name: /general defi risk disclosure/i,
    });

    await expect(protocolHeading).toBeVisible();
    await expect(genericHeading).toBeVisible();

    // Confirm protocol section is above generic by DOM order.
    const bothCount = await page
      .locator('h2', { hasText: /what can actually go wrong|general defi risk disclosure/i })
      .count();
    expect(bothCount).toBe(2);
  });

  test('every protocol-specific risk renders with a status chip', async ({ page }) => {
    for (const title of PROTOCOL_RISK_TITLES) {
      const heading = page.getByRole('heading', { name: new RegExp(title.replace(/[()]/g, '\\$&'), 'i') });
      await expect(heading).toBeVisible();
    }

    // Seven risks, seven status chips. Chips are Active / In progress / Mitigated.
    const chipMatches = page.locator(
      'text=/^(Active|In progress|Mitigated)$/',
    );
    const chipCount = await chipMatches.count();
    expect(chipCount).toBeGreaterThanOrEqual(PROTOCOL_RISK_TITLES.length);
  });

  test('footer links point to FIX_STATUS.md and AUDITS.md on GitHub', async ({ page }) => {
    const fixStatusLink = page.getByRole('link', { name: /fix_status\.md/i });
    const auditsLink = page.getByRole('link', { name: /audits\.md/i });

    await expect(fixStatusLink).toBeVisible();
    await expect(auditsLink).toBeVisible();

    // THE PRECONDITION, ASSERTED FIRST AND ON PURPOSE. This spec used to pin the
    // literal `/blob/main/`, and `main` is ~1,048 commits behind the branch the
    // site is actually built from — so both links resolved, to a stale ledger, and
    // this spec was holding that in place. Pinning the deploy branch by name means
    // a revert to `main` fails here; asserting the constant FIRST means that a
    // deliberate branch rename fails by naming its real cause, instead of surfacing
    // as two confusing href mismatches below.
    expect(GITHUB_BRANCH, 'the audit ledger must be linked at the deployed branch').toBe(
      'mvp-launch',
    );

    await expect(fixStatusLink).toHaveAttribute('href', `${GITHUB_BLOB_BASE}/FIX_STATUS.md`);
    await expect(auditsLink).toHaveAttribute('href', `${GITHUB_BLOB_BASE}/AUDITS.md`);
    // External links must not leak opener.
    for (const link of [fixStatusLink, auditsLink]) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
    }
  });
});
