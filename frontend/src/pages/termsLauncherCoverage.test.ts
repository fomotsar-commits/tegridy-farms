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

  // The Solana rail STOPPED being preview-only when the browser submit path shipped.
  // §2 previously stated, as a binding term, that the interface "does not submit any
  // Solana transaction on your behalf" — shipping the signer without amending that
  // sentence would have falsified the live Terms on the exact action that moves a
  // user's funds. These assertions moved in the SAME commit as the signer, which is
  // the whole point of this file.
  // REPLACED 2026-08-23 — these two asserted that §2 described the Meteora DBC rail
  // (user-submitted, non-custodial, immutable config, anti-snipe schedule). That rail
  // is retired: it graduated into Meteora DAMM v2, a pool this protocol does not own.
  //
  // The obligation is unchanged and is why these are rewritten rather than deleted.
  // Terms of Service are the most consequential copy in the app — a stale §2 that goes
  // on describing a live Solana launch service is a legal claim about something the
  // protocol no longer does. So the assertions now pin the RETIREMENT, and pin that
  // the old operative language is gone rather than merely supplemented.
  it('§2 states the Solana launch rail is retired and offers no such service', () => {
    const s2 = section(2)?.body ?? '';
    expect(s2).toMatch(/RETIRED/);
    expect(s2).toMatch(/no Solana launch service/i);
    expect(s2).toMatch(/not deployed/i);
  });

  it('§2 no longer describes a live Solana launch service', () => {
    const s2 = section(2)?.body ?? '';
    // The operative promises of the retired rail. Any one of these surviving would
    // have the Terms describing a service that cannot be performed.
    expect(s2).not.toMatch(/Meteora/);
    expect(s2).not.toMatch(/sign the launch transaction yourself/i);
    expect(s2).not.toMatch(/anti-snipe/i);
    // The EVM launcher is untouched and must NOT have been swept up — it graduates
    // into a Tegridy-owned V4 pool once the migrator is deployed.
    expect(s2).toMatch(/Doppler/);
    expect(s2).toMatch(/Uniswap V4/i);
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

  // The success panel is the one moment a creator is guaranteed to be looking, and the
  // permalink is the only artifact in it that belongs to us. It shipped linking ONLY to
  // Etherscan, which handed the most engaged moment in the funnel to a block explorer and
  // left /launch/:token reachable from a single Explorer row. Pin the hand-off.
  it('the launch success panel links to the token permalink, not just Etherscan', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'pages', 'LaunchPage.tsx'), 'utf8');
    // Slice from the banner COMPONENT, not from the "Launched." string: `txUrl` is
    // built above that literal, so a narrower slice silently drops the Etherscan
    // assertion below and passes for the wrong reason.
    const panel = src.slice(src.indexOf('function LaunchStatusBanner'));
    expect(panel).toContain('to={`/launch/${result.tokenAddress}`}');
    // And it must still surface the on-chain records — the permalink replaces neither.
    //
    // `toContain` on the exact URL PREFIX, deliberately not a regex: CodeQL's
    // js/regex/missing-regexp-anchor flags an unanchored URL-shaped pattern as a
    // high-severity finding, because that shape is a real bypass primitive WHEN it
    // guards a trust decision. It does not here — this greps source text — but an
    // exact substring is both immune to the class and a stricter assertion, so
    // there is nothing to trade off. Do not "simplify" these back into regexes.
    expect(panel).toContain('https://etherscan.io/tx/');
    expect(panel).toContain('https://etherscan.io/token/');
  });
});
