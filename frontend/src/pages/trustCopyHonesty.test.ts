// TRUST-COPY GUARD — the claims a first-time visitor reads, and the two files
// this app serves to machines.
//
// Every assertion here failed before 2026-09-03. They are grouped because they
// are one failure mode wearing four costumes: a string that was true when it was
// typed and was never re-checked against the thing it describes.
//
//   1. The brand word retired on 2026-08-31 still shipping in RENDERED copy —
//      the /contracts meta description and lead, the marketplace's only exit
//      link, the dashboard's score card, the gallery's attribution.
//   2. "Tegridy Score" on /dashboard vs "Venue Score" on the page it links to:
//      one instrument, two names.
//   3. Evidence links resolving to branch `main`, 1,048 commits behind the
//      branch this site is built from, while /contracts linked the same repo
//      correctly — so the app disagreed with itself about which branch is
//      authoritative.
//   4. The Home Farm card's "2 pools" stat contradicting its own body.
//
// The brand rule, precisely: CODE keeps its Tegridy identifiers (contract names,
// storage keys, the CoW `appCode`, hook and component names) — renaming a storage
// key orphans real user data. It is RENDERED STRINGS that must not carry it.
// RisksPage is exempt where it says the name WAS retired; that sentence needs the
// word to be true.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE_URL, GITHUB_BRANCH, GITHUB_BLOB_BASE, SOCIAL_LINKS } from '../lib/constants';
import { farmCardStat, farmCardDesc } from '../lib/lpEmissions';
import { FAQ_DATA } from './FAQPage';

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

// ── 1 + 2. The retired brand in rendered copy ───────────────────────────────
describe('the retired brand does not reach the reader', () => {
  const surfaces: { what: string; source: string }[] = [
    { what: '/contracts meta description and lead paragraph', source: read('src', 'pages', 'ContractsPage.tsx') },
    { what: 'the marketplace header back-link', source: read('src', 'nakamigos', 'components', 'Header.jsx') },
    { what: 'the dashboard score card', source: read('src', 'components', 'TegridyScoreMini.tsx') },
    { what: 'the score improvement tips', source: read('src', 'hooks', 'useTegridyScore.ts') },
    { what: '/gallery attribution', source: read('src', 'pages', 'GalleryPage.tsx') },
    { what: 'the offline shell', source: read('public', 'offline.html') },
    { what: 'the public security.txt', source: read('public', '.well-known', 'security.txt') },
  ];

  // Strip line comments and JSDoc bodies: the WHY notes on these fixes name the
  // retired brand on purpose, and a guard that forbids explaining itself is a
  // guard people delete.
  const rendered = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|#|\*)/.test(l))
      .join('\n');

  for (const { what, source } of surfaces) {
    it(`${what} names the venue, not the retired brand`, () => {
      const hits = rendered(source)
        .split('\n')
        .filter((l) => /Tegridy Farms|Tegridy Score|hand-drawn Tegridy|(?:>\s*Tegridy\s*$)/.test(l));
      expect(hits, `retired brand in rendered copy:\n${hits.join('\n')}`).toEqual([]);
    });
  }

  it('the points instrument has exactly one rendered name across its two hosts', () => {
    const mini = read('src', 'components', 'TegridyScoreMini.tsx');
    const board = read('src', 'pages', 'LeaderboardPage.tsx');
    expect(mini).toContain('>Venue Score<');
    expect(board).toContain('Your Venue Score');
    expect(mini).not.toContain('>Tegridy Score<');
  });
});

// ── 3. Evidence links point at the branch the site ships from ───────────────
describe('audit evidence links', () => {
  it('no page carries its own repo-branch literal', () => {
    // Both trust pages had their own `blob/main` literals while /contracts had
    // `blob/mvp-launch`. One constant, or they drift again.
    for (const f of ['SecurityPage.tsx', 'RisksPage.tsx', 'ContractsPage.tsx']) {
      const src = read('src', 'pages', f);
      expect(src, `${f} still hardcodes a github.com repo URL`).not.toMatch(
        /https:\/\/github\.com\/[^"'`\s]+\/(blob|tree)\//,
      );
    }
  });

  it('the shared base points at the deploy branch, never `main`', () => {
    expect(GITHUB_BRANCH).toBe('mvp-launch');
    expect(GITHUB_BLOB_BASE).toContain('/blob/mvp-launch');
    expect(GITHUB_BLOB_BASE).not.toContain('/blob/main');
  });
});

// ── 4. The Farm card's stat and body come off one read ──────────────────────
describe('the Home Farm card', () => {
  it('never claims two pools once the LP emissions period has ended', () => {
    expect(farmCardStat('ended')).not.toContain('2 pools');
    expect(farmCardStat('running')).toBe('2 pools');
  });

  it('gives an unread period its own answer rather than borrowing "ended"', () => {
    // "could not read" and "it has stopped" are different facts. Collapsing them
    // is the fabricated zero this app refuses to ship.
    expect(farmCardStat('unknown')).not.toBe(farmCardStat('ended'));
    expect(farmCardDesc('unknown')).not.toBe(farmCardDesc('ended'));
    expect(farmCardDesc('unknown')).toMatch(/could not read/i);
  });

  it('the card derives both halves instead of hardcoding the stat', () => {
    const home = read('src', 'pages', 'HomePage.tsx');
    expect(home).toContain('stat: farmCardStat(lpPhase)');
    expect(home).toContain('desc: farmCardDesc(lpPhase)');
    expect(home, 'the literal is back').not.toContain("stat: '2 pools'");
  });
});

// ── The $JBM card leads where its own words point ───────────────────────────
describe('the $JBM ecosystem card', () => {
  it('does not open a chain-wide swap with no output token', () => {
    const home = read('src', 'pages', 'HomePage.tsx');
    expect(home).not.toContain('app.uniswap.org/swap?chain=base');
  });

  it('points at the registry-driven JBM door', () => {
    expect(read('src', 'pages', 'HomePage.tsx')).toContain('<Link to="/jbm"');
  });
});

// ── The community list has one source ───────────────────────────────────────
describe('social links', () => {
  it('are declared once and imported, not re-listed per page', () => {
    for (const [where, ...parts] of [
      ['Footer', 'src', 'components', 'layout', 'Footer.tsx'],
      ['HomePage', 'src', 'pages', 'HomePage.tsx'],
    ] as const) {
      const src = read(...(parts as unknown as string[]));
      expect(src, `${where} re-declares the social list`).not.toMatch(/const (SOCIAL_LINKS|COMMUNITY_LINKS)\s*(:|=)/);
      expect(src, `${where} does not import the shared list`).toContain('SOCIAL_LINKS');
    }
    expect(SOCIAL_LINKS.length).toBeGreaterThan(0);
  });
});

// ── The two files served to machines ────────────────────────────────────────
describe('public/.well-known/security.txt', () => {
  const txt = read('public', '.well-known', 'security.txt');
  const fields = txt
    .split('\n')
    .filter((l) => !l.startsWith('#') && l.includes(':'))
    .map((l) => l.trim());
  const canonicals = fields.filter((l) => l.startsWith('Canonical:')).map((l) => l.slice('Canonical:'.length).trim());

  it('declares a Canonical at the origin the app calls its own', () => {
    // RFC 9116 §3: a Canonical URI that does not match where the file was
    // fetched from is grounds to distrust the file. SITE_URL is read, not typed.
    expect(canonicals).toContain(`${SITE_URL}/.well-known/security.txt`);
  });

  it('ships no TODO addressed to the owner', () => {
    // This is fetched by convention by researchers and by automated scanners.
    expect(txt).not.toMatch(/TODO|FIXME|XXX\b/);
  });

  it('puts no origin in scope under a domain the project does not own', () => {
    // The alias may be named in prose to say it is OUT of scope, but never as a
    // fetchable origin: this document cannot promise safe harbour on a hostname
    // under a domain the project does not own, and a researcher following it
    // could have tested someone else's deployment.
    expect(txt).not.toContain('https://tegridyfarms.vercel.app');
  });

  it('parses as RFC 9116 fields, not as one long comment', () => {
    // Sanity for the guards above: if a future edit comments out the field
    // block, `fields` empties and every assertion here passes vacuously.
    expect(fields.some((l) => l.startsWith('Contact:'))).toBe(true);
    expect(fields.some((l) => l.startsWith('Expires:'))).toBe(true);
    expect(canonicals.length).toBeGreaterThan(0);
  });
});

// ── The FAQ's opening answer agrees with its own network answer ─────────────
describe('the FAQ opener', () => {
  const all = FAQ_DATA.flatMap((s) => s.items);
  const opener = all[0]!;
  const network = all.find((i) => /what network/i.test(i.q))!;

  it('is the answer the schema.org payload leads with', () => {
    // The first item of FAQ_DATA is the first `mainEntity` of the emitted
    // FAQPage JSON-LD, so it is the sentence a search engine quotes.
    expect(opener.q).toMatch(/what is memetics\.finance/i);
  });

  it('does not describe a single-chain yield farm', () => {
    // The exact framing OnboardingModal.tsx and Footer.tsx were both corrected
    // for on 2026-08-07: "a yield farming protocol on Ethereum", three lines
    // above an answer describing four chains, a launcher and a Solana swap.
    expect(opener.a).not.toMatch(/is a yield farming protocol on Ethereum/i);
  });

  it('names every chain its own network answer names', () => {
    // Checked against the sibling answer, not against a literal — so the two
    // cannot drift apart again without this failing.
    for (const chain of ['Ethereum', 'Base', 'Robinhood', 'Solana']) {
      // Case-insensitive: the network answer names Solana through the `/solana`
      // route. The opener must name it in prose either way.
      const named = new RegExp(chain, 'i');
      expect(network.a, `network answer no longer mentions ${chain}`).toMatch(named);
      expect(opener.a, `opening answer omits ${chain}`).toMatch(named);
    }
  });

  it('keeps the TOWELI-staking detail as an Ethereum-specific claim', () => {
    // Do not let the multi-chain framing rot into "multichain staking":
    // TOWELI staking really is Ethereum-only.
    expect(opener.a).toMatch(/On Ethereum you stake TOWELI/);
  });
});

// ── One name per thing on the Trade tabs ────────────────────────────────────
describe('the Trade page limit-order tab', () => {
  const src = read('src', 'pages', 'TradePage.tsx');

  it('is not labelled "Alerts" while /alerts in the nav is a different product', () => {
    // The panel was rebuilt as a real on-chain CoW order and its heading says
    // "Limit Order"; the label and canonical param were left behind by an
    // earlier honesty pass, so "Alerts" here offered a signature for a live
    // order while the alert-rule store lived somewhere else entirely.
    expect(src).toContain("limit: 'Limit',");
    expect(src).not.toContain("limit: 'Alerts',");
  });

  it('writes ?tab=limit as canonical', () => {
    expect(src).not.toContain("next === 'limit' ? 'alerts' : next");
  });

  it('still resolves the legacy ?tab=alerts synonym so shared links survive', () => {
    expect(src).toContain("if (v === 'alerts') return 'limit';");
  });
});

// ── No fabricated order book survives behind an unused export ───────────────
describe('the NFT-finance placeholders', () => {
  it('are gone, not merely unreferenced', () => {
    // Both were exported, imported by nothing, and described features live since
    // 2026-07-21 as unlaunched. One rendered four INVENTED lender offers with
    // real-looking principals, APRs and lender addresses. Re-importing either
    // would have shipped a false gate — and, in one case, a fabricated order
    // book — in a single line.
    const lending = read('src', 'components', 'nftfinance', 'LendingSection.tsx');
    const amm = read('src', 'components', 'nftfinance', 'AMMSection.tsx');
    expect(lending).not.toMatch(/export function ComingSoonState/);
    expect(lending).not.toMatch(/mockOffers/);
    expect(amm).not.toMatch(/export function ComingSoon\b/);
  });
});

describe('public/offline.html', () => {
  const html = read('public', 'offline.html');

  it('does not claim a data source that is hosted nowhere', () => {
    // VITE_INDEXER_URL is unset and every indexer-backed surface is pilled SOON
    // for exactly that reason, so "and from its indexer" was a claim about a
    // service that does not exist. Chain-only is true today and stays true if
    // the indexer ever lands.
    expect(html).not.toMatch(/indexer/i);
    expect(html).toContain('reads everything it displays live from the chain');
  });

  it('keeps its honesty framing intact', () => {
    // This page's whole reason to exist. If a later edit removes it, that edit
    // is wrong, not this test.
    expect(html).toContain('Nothing here is a zero');
  });
});
