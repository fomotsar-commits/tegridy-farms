// RETIREMENT TRIPWIRE for the Meteora Dynamic Bonding Curve rail.
//
// Retired 2026-08-23 by operator decision: only launchers that graduate into OUR OWN
// venue survive. The DBC rail graduated into Meteora DAMM v2 — a pool this protocol
// does not own and could not own without deploying a different program. Six lib
// modules, eight test files, a page, a route, an operator script and the
// `@meteora-ag/dynamic-bonding-curve-sdk` dependency were deleted.
//
// ─── WHY A TEST AND NOT JUST A DELETION ─────────────────────────────────────
//
// A retired rail that leaves no trace is how a future session re-adds it. This repo
// has the scars: a "not deployed" banner survived four days past a deploy, a "live on
// mainnet" banner survived nine days past a close, and both were prose nobody checked.
// `spentProgramIds.test.ts` is the same idea pointed at the own-venue ids; this points
// it at Meteora.
//
// ─── PAST TENSE IS LEGAL, PRESENT TENSE IS NOT ──────────────────────────────
//
// The history must stay writable. `addresses.json` deliberately KEEPS both Meteora
// entries — the programs are still live third-party counterparties, and erasing them
// would delete the record of a rail that really did go live on mainnet. So this guard
// does not ban the word. It bans a present-tense claim, in shipped copy, that we launch
// or run on Meteora.
//
// ─── TWO THINGS THE FIRST VERSION OF THIS FILE GOT WRONG ────────────────────
//
// 1. It scanned whole lines, so it flagged the comments documenting the retirement —
//    which necessarily QUOTE the claims being retired. It flagged its own explanation.
//    Comments are now exempt; shipped copy lives in string literals.
// 2. It text-matched `/solana-launch`, so it flagged every historical mention and,
//    absurdly, the navConfig test that asserts the entry is ABSENT. Discussing a removed
//    route is not re-adding one. The route is now checked STRUCTURALLY instead.
//
// ─── WHAT THIS CANNOT DO ────────────────────────────────────────────────────
//
// It reads text. It cannot notice someone re-adding the SDK and wiring a client that
// never says the word — so it also asserts the dependency is absent, which is the one
// mechanical fact underneath all the prose.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `frontend/`, three levels above `src/lib/launcher`. */
const FRONTEND = join(HERE, '..', '..', '..');
const SRC = join(FRONTEND, 'src');

/** Files the deletion removed. Any of them returning is the rail coming back. */
const DELETED = [
  'src/lib/launcher/solana/dbc.ts',
  'src/lib/launcher/solana/dbcClient.ts',
  'src/lib/launcher/solana/liveConfig.ts',
  'src/lib/launcher/solana/feeSchedule.ts',
  'src/lib/launcher/solana/feeCustody.ts',
  'src/lib/launcher/solana/submitLaunch.ts',
  'src/pages/SolanaLaunchPage.tsx',
  'scripts/solana-dbc-operator.mjs',
];

/**
 * Present-tense claims that the protocol uses Meteora, as they would appear in shipped
 * copy. Past tense is deliberately absent — "was retired", "used to run on",
 * "previously published" are the sentences the record is made of.
 */
const PRESENT_TENSE_CLAIMS: { re: RegExp; why: string }[] = [
  { re: /\blaunch(?:es|ing)?\s+(?:tokens?\s+)?on\s+Meteora\b/i, why: 'claims the protocol launches on Meteora' },
  { re: /\b(?:runs|running)\s+on\s+Meteora\b/i, why: 'claims a rail runs on Meteora' },
  { re: /\bgraduates?\s+into\s+Meteora\b/i, why: 'claims a launch graduates into Meteora' },
];

/**
 * The route, checked as CODE rather than as prose — see the header note. What matters
 * is a live `<Route>` or a nav entry, not a comment mentioning either.
 */
const ROUTE_DEFINITIONS: { file: string; re: RegExp; why: string }[] = [
  { file: 'src/App.tsx', re: /<Route\s[^>]*path=["']solana-launch["']/, why: 'the /solana-launch route is defined again' },
  { file: 'src/lib/navConfig.ts', re: /to:\s*['"]\/solana-launch['"]/, why: 'the /solana-launch nav entry is back' },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

/** Strip `//` comments and jsdoc continuation lines; what remains is shipped code. */
function codeOnly(line: string): string {
  return line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
}

describe('the Meteora DBC rail stays retired', () => {
  it('none of the deleted modules has come back', () => {
    const returned = DELETED.filter((rel) => existsSync(join(FRONTEND, rel)));
    expect(
      returned,
      'a retired rail reappearing is how this repo re-acquires a launcher that graduates into a pool it does not own',
    ).toEqual([]);
  });

  it('the Meteora SDK is not a dependency', () => {
    // The mechanical fact under all the prose. Someone could re-add a client that never
    // says "Meteora"; they cannot re-add one without the SDK.
    const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(Object.keys(all).filter((d) => d.includes('meteora') || d.includes('bonding-curve'))).toEqual([]);
  });

  it('does not define the removed route or nav entry', () => {
    for (const { file, re, why } of ROUTE_DEFINITIONS) {
      const full = join(FRONTEND, file);
      expect(existsSync(full), `${file} is gone — this guard is checking nothing`).toBe(true);
      expect(re.test(readFileSync(full, 'utf8')), why).toBe(false);
    }
  });

  it('no shipped copy claims, in the present tense, that we use Meteora', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      // This file names the claims in order to ban them.
      if (file.endsWith(`${sep}meteoraRetired.test.ts`)) continue;
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const code = codeOnly(line);
          // 2026-08-28: the string-literal gate below used to skip QUOTE-LESS
          // JSX text lines entirely — CurveLaunchPage carried "runs on
          // Meteora's curve" as bare JSX prose for five days while this
          // tripwire passed. JSX text is exactly as user-visible as a string
          // literal, so only comment-stripped emptiness exempts a line now.
          if (code.trim().length === 0) return;
          for (const { re, why } of PRESENT_TENSE_CLAIMS) {
            if (re.test(code)) {
              offenders.push(`${file.slice(SRC.length + 1)}:${i + 1} — ${why}\n    ${line.trim().slice(0, 140)}`);
            }
          }
        });
    }
    expect(offenders, `retired-rail claims still in shipped copy:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no shipped JSX links to the removed route', () => {
    // Added 2026-08-24: LaunchPage.tsx:1199 and CurveLaunchPage.tsx:819 shipped
    // live <Link to="/solana-launch"> cross-links for a day after the retirement
    // — the ROUTE_DEFINITIONS guard above checks only App.tsx and navConfig, so
    // in-page links dead-ending on the 404 sailed straight through. This scans
    // every shipped file for a Link/navigate to the removed route. Test files
    // are exempt (navConfig.test legitimately asserts the entry is absent).
    const LINK_RE = /\bto=["']\/solana-launch["']/;
    const NAV_RE = /navigate\(\s*["']\/solana-launch["']/;
    // Guard the guard: the exact line that shipped must match.
    expect(LINK_RE.test('<Link to="/solana-launch" className="underline">')).toBe(true);

    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (/\.test\.tsx?$/.test(file)) continue;
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const code = codeOnly(line);
          if (LINK_RE.test(code) || NAV_RE.test(code)) {
            offenders.push(`${file.slice(SRC.length + 1)}:${i + 1} — ${line.trim().slice(0, 120)}`);
          }
        });
    }
    expect(offenders, `live links to the removed /solana-launch route:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('still allows the history to be written down', () => {
    // Guard the guard. If the patterns ever widen into a blanket ban on the word, the
    // registry entries and every retirement note become unwritable, and the next session
    // deletes the record to make CI green. These must all stay legal.
    const legal = [
      '"The Meteora DBC rail was retired on 2026-08-23."',
      '"This used to run on Meteora’s Dynamic Bonding Curve."',
      '"Meteora Dynamic Bonding Curve program. Third-party, never ours."',
      '"/solana-launch was removed 2026-08-23."',
      "expect(ALL_NAV.find((n) => n.to === '/solana-launch')).toBeUndefined();",
    ];
    for (const line of legal) {
      const code = codeOnly(line);
      for (const { re, why } of PRESENT_TENSE_CLAIMS) {
        expect(re.test(code), `the guard would reject a legitimate historical note (${why}): ${line}`).toBe(false);
      }
    }
  });

  it('the patterns actually fire on the claims that really shipped', () => {
    // The other half of guarding the guard: these are real sentences that were live in
    // production until this retirement. If the patterns stop matching them, the tripwire
    // has quietly stopped working.
    const shipped = [
      `"/solana-launch launches tokens on Meteora's bonding curve."`,
      `"The Solana launch rail runs on Meteora's Dynamic Bonding Curve."`,
      `"Solana launches graduate into Meteora DAMM v2 — an external venue."`,
    ];
    for (const line of shipped) {
      expect(
        PRESENT_TENSE_CLAIMS.some(({ re }) => re.test(codeOnly(line))),
        `a claim that really shipped is no longer caught: ${line}`,
      ).toBe(true);
    }
  });
});
