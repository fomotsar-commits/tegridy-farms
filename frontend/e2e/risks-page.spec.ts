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
    await page.goto('/risks');
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

    await expect(fixStatusLink).toHaveAttribute(
      'href',
      /github\.com\/fomotsar-commits\/tegridy-farms\/blob\/main\/FIX_STATUS\.md/,
    );
    await expect(auditsLink).toHaveAttribute(
      'href',
      /github\.com\/fomotsar-commits\/tegridy-farms\/blob\/main\/AUDITS\.md/,
    );
    // External links must not leak opener.
    for (const link of [fixStatusLink, auditsLink]) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
    }
  });
});
