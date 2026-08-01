import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECTIONS } from './TermsPage';
import {
  DEFAULT_FEE_CONSTITUTION,
  LAUNCH_FEE_TIER,
  isLauncherEnabled,
  isExoticLaunchEnabled,
} from '../lib/launcher/config';
import { protocolFeeSink } from '../lib/launcher/launchService';
import { isSolanaLauncherEnabled } from '../lib/launcher/solana/dbc';

// CONTENT GUARD for the Terms of Service vs the live launcher.
//
// /launch deploys ERC-20s on Ethereum mainnet for members of the public, but the Terms
// shipped describing only farming/swap/staking/NFT-lending/NFT-AMM — the live product did
// something the Terms did not describe, and nothing in CI noticed. Flipping a launcher
// flag is a one-line edit that silently changes what the Protocol offers, so this file
// couples the flags to the disclosure: turn a rail on or off and these tests go red until
// someone reads §2/§7-§11 again.
//
// The fee assertions are the same anti-drift rule as SWAP_FEE_PCT: §7's launch figures
// must be RENDERED from DEFAULT_FEE_CONSTITUTION / LAUNCH_FEE_TIER / protocolFeeSink(),
// never retyped, so a constitution change cannot leave the Terms quoting a stale split or
// naming a recipient the routing does not pay. Modelled on the coverage-guard pattern in
// artStudioCoverage.test.ts / launchPriceWiring.test.ts.

const TERMS_PAGE = join(process.cwd(), 'src', 'pages', 'TermsPage.tsx');

const allBodies = SECTIONS.map((s) => s.body).join('\n');
const section = (n: number) => SECTIONS.find((s) => s.title.startsWith(`${n}. `));

describe('Terms of Service — launcher coverage', () => {
  it('sections are numbered 1..N with no gaps or repeats after the launcher insert', () => {
    expect(SECTIONS.map((s) => s.title.split('.')[0])).toEqual(
      SECTIONS.map((_, i) => String(i + 1)),
    );
  });

  it('§2 Description of Services covers token issuance while the EVM launcher is enabled', () => {
    // If the launcher is ever gated off, this whole block must be revisited rather than
    // left describing a rail that no longer exists.
    expect(isLauncherEnabled()).toBe(true);
    const s2 = section(2);
    expect(s2?.title).toContain('Description of Services');
    expect(s2?.body).toMatch(/token launcher/i);
    expect(s2?.body).toMatch(/create, issue and deploy/i);
    expect(s2?.body).toMatch(/ERC-20/);
    expect(s2?.body).toMatch(/Doppler/);
  });

  it('§2 names the TOWELI base pair exactly while exotic launches are enabled', () => {
    expect(isExoticLaunchEnabled()).toBe(true);
    expect(section(2)?.body).toMatch(/paired against either native ETH or TOWELI/);
  });

  it('§2 describes the Solana rail as preview-only, which is what it is today', () => {
    expect(isSolanaLauncherEnabled()).toBe(true);
    const s2 = section(2)?.body ?? '';
    expect(s2).toMatch(/Meteora/);
    expect(s2).toMatch(/PREVIEW only/);
    // The Solana page has no signer; claiming otherwise would overstate the rail.
    expect(s2).toMatch(/does not submit any Solana transaction/i);
  });

  it('§7 Fees renders the launch fee tier and the full constitution from the constants', () => {
    const s7 = section(7)?.body ?? '';
    expect(section(7)?.title).toContain('Fees');
    // 10_000 hundredths-of-a-bip = 1%. Both the percent and the raw constant appear.
    expect(s7).toContain(`${LAUNCH_FEE_TIER / 10_000}%`);
    expect(s7).toContain(`LAUNCH_FEE_TIER = ${LAUNCH_FEE_TIER}`);
    for (const line of DEFAULT_FEE_CONSTITUTION) {
      const label = line.role === 'protocol-stakers' ? protocolFeeSink().recipient : line.recipient;
      expect(s7).toContain(`${label} ${(line.shareBps / 100).toFixed(0)}%`);
    }
  });

  it('§7 describes BOTH destinations, and promises no revenue claim either way', () => {
    const s7 = section(7)?.body ?? '';
    // The sink moved (Treasury -> LockerClaimer) the moment the claimer was deployed, so
    // pin the PROPERTY rather than a literal: §7 must name both real destinations, because
    // a locker position has two currencies and they do NOT land in the same place. The ETH
    // leg reaches stakers; an exotic pair's two ERC20 legs sweep to the treasury.
    expect(s7).toMatch(/revenue distributor/i);
    expect(s7).toMatch(/treasury/i);
    expect(s7).toMatch(/stakers may claim/i);
    // And whichever it is, holding a launched token buys no claim on Tegridy revenue.
    expect(s7).toMatch(/grant you\s+any claim on any Tegridy revenue distribution/i);
  });

  it('the issuer-side terms exist and say the load-bearing things', () => {
    expect(allBodies).toMatch(/you are the issuer of that token/i);
    expect(allBodies).toMatch(/not the issuer, underwriter, sponsor, promoter, broker, dealer, exchange/i);
    expect(allBodies).toMatch(/permissionless/i);
    expect(allBodies).toMatch(/can be edited, paused, reversed, refunded or deleted/i);
    expect(allBodies).toMatch(/does not vet, screen or guarantee/i);
    // The Fact Sheet is a disclosure, not a warranty — do not let it be reworded upward.
    expect(allBodies).toMatch(/not a security audit/i);
    // Prohibited uses.
    expect(allBodies).toMatch(/impersonate/i);
    expect(allBodies).toMatch(/infringes/i);
    expect(allBodies).toMatch(/OFAC/);
    // De-listing is editorial only; the on-chain token is untouched.
    expect(allBodies).toMatch(/does not remove, disable, freeze or otherwise affect that token on-chain/i);
  });

  it('no pre-existing section was dropped when the launcher sections were inserted', () => {
    for (const title of [
      'Acceptance of Terms',
      'Description of Services',
      'Eligibility',
      'Wallet Connection & Self-Custody',
      'Risks',
      'No Financial Advice',
      'Fees',
      'Intellectual Property',
      'Limitation of Liability',
      'Governing Law',
      'Changes to Terms',
    ]) {
      expect(SECTIONS.some((s) => s.title.includes(title))).toBe(true);
    }
  });

  it('the launch fee figures are interpolated, not hardcoded, in the source', () => {
    const src = readFileSync(TERMS_PAGE, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toMatch(/\$\{LAUNCH_FEE_PCT\}%/);
    expect(code).toMatch(/\$\{LAUNCH_FEE_TIER\}/);
    expect(code).toMatch(/\$\{FEE_CONSTITUTION_TEXT\}/);
    expect(code).toMatch(/\$\{PROTOCOL_FEE_PCT\}%/);
    // BOTH recipient labels come from protocolFeeSink(), because the sink is numeraire-aware.
    expect(code).toMatch(/\$\{PROTOCOL_FEE_RECIPIENT\}/);
    expect(code).toMatch(/\$\{PROTOCOL_FEE_RECIPIENT_EXOTIC\}/);
    expect(code).toMatch(/\$\{PROTOCOL_FEE_RECIPIENT\}/);
    // A retyped split is the failure mode this guard exists for.
    expect(code).not.toMatch(/70% Creator|Creator 70%|15% to the treasury/);
  });
});

describe('the launch flow surfaces the Terms', () => {
  // A term nobody is shown is a weak term: the irreversible create() is one button away
  // from the Review step, so that step must link to /terms.
  it('LaunchPage step 4 links to /terms next to the launch button', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'pages', 'LaunchPage.tsx'), 'utf8');
    const review = src.slice(src.indexOf('function StepReview'));
    expect(review).toMatch(/to="\/terms"/);
    expect(review).toMatch(/issuer/i);
  });
});
