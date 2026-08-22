// PLAN-AND-REGISTRY RECONCILIATION GUARD.
//
// A companion to `docsClaimHonesty.test.ts`, which pins what the docs may not SAY about
// revenue. This one pins what the docs and the address registry may not say about
// STATUS: what is deployed, what is live, and what merging a branch does and does not
// prove.
//
// Four failures this repo has already paid for, one assertion group each:
//
//   1. A closed Solana program that read "live, DEPLOYED" for six days. `solana program
//      close` deletes the ProgramData account and leaves the program stub
//      executable-FLAGGED, so the registry's `expect: {type: 'executable'}` kept passing
//      against a program that could never run again. Prose said live; CI agreed; both
//      were wrong. The fix is structural: the closure of a program id is asserted by
//      registering its ProgramData address with `expect: {type: 'absent'}`, which
//      verify-addresses.mjs enforces unconditionally against the chain. A sentence about
//      closure is a claim; an absent-account check is a read.
//
//   2. A handoff doc, four months stale, whose "immediate priorities" told an operator to
//      act on three addresses the relaunch had superseded — one of them a controller
//      whose `pairToGauge` reverts. `docsAddressTruth.test.ts` guards four published docs
//      by name and never saw this one. The rule here is blunter and needs no list of
//      addresses to maintain: a superseded runbook names no address at all.
//
//   3. Two PWA manifests, byte-duplicated, one linked by `index.html` and the other
//      fetched by name in the e2e suite. Editing either alone makes the tests pass while
//      the installed app is wrong.
//
//   4. Plan docs marking work `✅ shipped` on the strength of a merge. Nearly everything
//      here ships deployed-nowhere or flag-gated-off by house law, so `🟡 in the tree`
//      is the normal terminus and `✅` is the exception. A `🟡` that does not name its
//      gap is worse than no marker, because it reads as finished.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, sep } from 'node:path';

function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, 'README.md')) && existsSync(join(d, 'docs'))) return d;
    d = dirname(d);
  }
  throw new Error('could not locate the repo root from ' + import.meta.url);
}

const ROOT = repoRoot();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// 1. The two closed Solana programs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Both own-venue programs were deployed 2026-08-08 and CLOSED on mainnet 2026-08-13.
 * Verified on two independent RPCs 2026-08-15 — both ProgramData accounts return null
 * with 0 lamports while the program stubs remain executable-flagged at 1,141,440
 * lamports each (`docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md`).
 *
 * ⚠ MAY ONLY GROW BY A REAL CLOSURE. Removing an entry is a claim that a spent program
 * id became reusable, which Solana does not permit.
 */
const CLOSED_PROGRAMS = [
  {
    what: 'tegridy-launch bonding curve',
    programId: 'CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED',
    programData: '6vV7DqMyGwpM18rf2Lkefa1U9YfKquZjvwA61ch3FsnS',
  },
  {
    what: 'cp-swap fork (the graduation venue)',
    programId: '3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y',
    programData: '6TnZb1GTHhPAYsrbtwfELkqQrXyqCfv7V6s27RJKXHAF',
  },
] as const;

interface RegistryEntry {
  id?: string;
  address?: string;
  role?: string;
  status?: string;
  expect?: { type?: string };
}

const registry = JSON.parse(read('frontend', 'scripts', 'addresses.json')) as {
  solana?: RegistryEntry[];
};
const solanaEntries = (registry.solana ?? []).filter((e) => e.address);

describe('the address registry tells the truth about the two closed programs', () => {
  it('registers both program ids at all — a vacuous loop proves nothing', () => {
    for (const p of CLOSED_PROGRAMS) {
      expect(
        solanaEntries.some((e) => e.address === p.programId),
        `${p.what} (${p.programId}) has vanished from the registry`,
      ).toBe(true);
    }
  });

  for (const p of CLOSED_PROGRAMS) {
    it(`${p.what}: its status says closed, not live`, () => {
      const entry = solanaEntries.find((e) => e.address === p.programId)!;
      const status = entry.status ?? '';
      expect(status, 'entry has no status').not.toBe('');
      expect(status, 'status does not record the closure').toMatch(/\bclosed\b/i);
      // The exact wording this guard was written for. "live, DEPLOYED to mainnet" was
      // the sentence that survived the close; the shape, not that sentence, is banned.
      expect(status, 'status opens by asserting the program is live').not.toMatch(
        /^\s*live\b/i,
      );
      expect(status, 'status still presents the program as a live deployment').not.toMatch(
        /\blive,\s*deployed\b/i,
      );
    });

    it(`${p.what}: its closure is machine-checked, not merely asserted`, () => {
      // The load-bearing assertion of this file. A program account stays
      // executable-flagged after a close, so `expect: {type: 'executable'}` on the
      // program id can never notice the difference; only the ProgramData account can.
      const pd = solanaEntries.find((e) => e.address === p.programData);
      expect(
        pd,
        `no registry entry for ${p.what}'s ProgramData ${p.programData} — without it, ` +
          'the closure is a sentence in a status field that nothing verifies against the chain',
      ).toBeDefined();
      expect(
        pd!.expect?.type,
        'the ProgramData entry must expect ABSENT; verify-addresses.mjs enforces that ' +
          'expectation unconditionally, which is what turns the claim into a read',
      ).toBe('absent');
      expect(pd!.role, 'the ProgramData entry has no role explaining why it exists').toBeTruthy();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Published docs may not present a closed program as live
// ─────────────────────────────────────────────────────────────────────────────

/** Point-in-time records: rewriting them would destroy the trail. */
const HISTORICAL_RECORD = [
  /^docs\/audits\//,
  // The findings ledger IS the record of the closure and quotes the pre-close state to
  // date it; the two inventories are dated snapshots that quote other files verbatim.
  /^docs\/SOLANA_PROGRAM_FINDINGS_2026_08_15\.md$/,
  /^docs\/UNFINISHED_INVENTORY_2026_08_13\.md$/,
  /^docs\/EVERYTHING_LEFT_2026_08_15\.md$/,
];

function walkMarkdown(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walkMarkdown(p, acc);
    } else if (/\.md$/i.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Every markdown surface that describes the Solana venue to a reader or an operator. */
function statusDocs(): string[] {
  const roots = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.md$/i.test(e.name))
    .map((e) => join(ROOT, e.name));
  const amm = join(ROOT, 'solana', 'tegridy-amm');
  const ammDocs = existsSync(amm)
    ? readdirSync(amm, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.md$/i.test(e.name))
        .map((e) => join(amm, e.name))
    : [];
  return [...roots, ...walkMarkdown(join(ROOT, 'docs')), ...ammDocs]
    .map((f) => f.split(sep).join('/'))
    .filter((f) => !HISTORICAL_RECORD.some((r) => r.test(f.slice(ROOT.length + 1))));
}

// Present-tense liveness, asserted on a line that names a spent program id. `was`,
// `used to`, `ran at` and every closure word are deliberately outside the shape:
// describing what the program DID is history and stays legal.
const ASSERTS_LIVE = /\b(?:is|are|still)?\s*(?:live|running|deployed to mainnet|executable)\b/i;
const RETRACTS = /clos(?:e|ed|ure)|spent|stranded|cannot (?:execute|be redeployed)|permanently unusable|no longer|was\b|used to|ran at|deleted|retired|post-mortem|⛔/i;

describe('no published doc presents a closed program id as live', () => {
  it('scans the docs that describe the Solana venue', () => {
    // Guard the guard: a walker returning nothing passes every assertion below.
    const files = statusDocs().map((f) => f.slice(ROOT.length + 1));
    expect(files.length).toBeGreaterThan(40);
    for (const must of [
      'ROADMAP.md',
      'NEXT_SESSION.md',
      'docs/BATTLE_PLAN.md',
      'docs/YEAR_PLAN_2026_2027.md',
      'docs/TOP_100_BUILDS.md',
      'solana/tegridy-amm/MAINNET_RUNBOOK.md',
      'solana/tegridy-amm/TEGRIDY_FORK.md',
    ]) {
      expect(files, `${must} is not being scanned`).toContain(must);
    }
  });

  it('carries no unretracted liveness claim about either spent id', () => {
    const offenders: string[] = [];
    for (const file of statusDocs()) {
      const rel = file.slice(ROOT.length + 1);
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const p of CLOSED_PROGRAMS) {
          if (!line.includes(p.programId)) continue;
          if (!ASSERTS_LIVE.test(line)) continue;
          if (RETRACTS.test(line)) continue;
          offenders.push(`${rel}:${i + 1} presents ${p.what} as live\n    ${line.trim().slice(0, 160)}`);
        }
      });
    }
    expect(offenders, `closed programs described as live:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the shape still fires on the wording it was written for', () => {
    // Reworded on purpose — the shape is what is pinned, not a quote.
    const bad = `| tegridy-launch | ${CLOSED_PROGRAMS[0].programId} | live, deployed to mainnet |`;
    expect(ASSERTS_LIVE.test(bad) && !RETRACTS.test(bad)).toBe(true);
    // …and the corrected wording must survive, or the guard just forces a new lie.
    for (const legal of [
      `it ran at ${CLOSED_PROGRAMS[0].programId} until the ProgramData was deleted`,
      `${CLOSED_PROGRAMS[1].programId} is a closed, permanently unusable program id`,
    ]) {
      expect(ASSERTS_LIVE.test(legal) && !RETRACTS.test(legal)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. NEXT_SESSION.md is a redirect, not a runbook
// ─────────────────────────────────────────────────────────────────────────────

describe('the retired handoff cannot be executed', () => {
  const doc = read('NEXT_SESSION.md');

  it('names no contract address', () => {
    // Not a list of banned addresses — a list would need maintaining and would have
    // missed the three that mattered. A superseded runbook has no business naming any
    // address, so the safe count is zero and there is nothing to keep current.
    expect(doc.match(/0x[0-9a-fA-F]{40}/g) ?? []).toEqual([]);
  });

  it('issues no on-chain instruction', () => {
    expect(doc).not.toMatch(/\bacceptOwnership\b|\btransferOwnership\b|\bforge script\b/);
  });

  it('says it is superseded and points somewhere current', () => {
    expect(doc).toMatch(/superseded/i);
    expect(doc).toContain('docs/OPERATOR_NEXT.md');
    expect(doc).toContain('docs/BATTLE_PLAN.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The two PWA manifests
// ─────────────────────────────────────────────────────────────────────────────

describe('the PWA manifests agree and describe the app that exists', () => {
  const linked = JSON.parse(read('frontend', 'public', 'manifest.webmanifest'));
  const fetched = JSON.parse(read('frontend', 'public', 'manifest.json'));

  it('the linked manifest and the tested one are identical', () => {
    // index.html links `.webmanifest`; e2e/trust-pages.spec.ts fetches `.json` by name.
    // Let them drift and the suite goes green against a file the browser never reads.
    expect(fetched).toEqual(linked);
  });

  it('does not describe a single-chain farming product', () => {
    // The app is two-chain and is not farming-only; index.html's own meta description
    // has said so since the 2026-08-07 chain-scope pass, and this file did not.
    expect(linked.description).toBeTruthy();
    expect(linked.description).not.toMatch(/art-first yield farming on ethereum/i);
    expect(linked.description).toMatch(/solana/i);
  });

  it('still installs under a name', () => {
    // Which name is the operator's call (docs/OPERATOR_NEXT.md C3). Empty is not a call.
    expect(linked.name).toBeTruthy();
    expect(linked.short_name).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Plan status markers
// ─────────────────────────────────────────────────────────────────────────────

const PLANS = ['docs/BATTLE_PLAN.md', 'docs/YEAR_PLAN_2026_2027.md', 'docs/TOP_100_BUILDS.md'];

/** Phrases that state, in the same breath, that the thing is not live. */
const NOT_LIVE = /deployed nowhere|not deployed|switched off|charging nothing|shipped off|flag-gated off|defaulting to 0|default(?:ing)? is 0|share defaulting|no host|wired to no page|mounted nowhere|unmet/i;

describe('the plans distinguish merged from shipped', () => {
  it('the battle plan defines both markers', () => {
    const bp = read('docs', 'BATTLE_PLAN.md');
    expect(bp).toContain('✅ shipped <date> <commit>');
    expect(bp).toContain('🟡 in the tree');
    expect(bp, 'the rule that a merge is not a deploy has been dropped').toMatch(
      /Merging is not shipping/i,
    );
  });

  it('no ✅ line simultaneously admits the thing is not live', () => {
    const offenders: string[] = [];
    for (const rel of PLANS) {
      read(...rel.split('/')).split('\n').forEach((line, i) => {
        if (!/✅\s*\*{0,2}shipped/i.test(line)) return;
        if (NOT_LIVE.test(line)) offenders.push(`${rel}:${i + 1}\n    ${line.trim().slice(0, 160)}`);
      });
    }
    expect(offenders, `marked shipped while saying it is not:\n${offenders.join('\n')}`).toEqual([]);
  });

  // An APPLIED marker, not a mention. The rule-4 definition, the year plan's pointer at
  // it and the top-100 legend all discuss the vocabulary without claiming anything about
  // an item, and demanding a gap clause from a definition would push the definition out
  // of the docs. The count assertion below is what stops this narrowing from emptying
  // the scan: tighten the shape too far and there is nothing left to check.
  // The bold is the tell: an applied marker opens `🟡 **in the tree …`, while every
  // description of the vocabulary writes it inside backticks and unbolded.
  const APPLIED = /🟡\s+\*\*(?:in the tree|partially)/i;

  it('every 🟡 marker names the gap that stops it being ✅', () => {
    // The mandatory trailing clause from the battle plan's rule 4. A 🟡 without one
    // reads as finished, which is the failure the two-marker split exists to prevent.
    const offenders: string[] = [];
    for (const rel of PLANS) {
      read(...rel.split('/')).split('\n').forEach((line, i) => {
        if (!APPLIED.test(line)) return;
        if (/<what is still missing>/.test(line)) return; // the rule's own template
        if (NOT_LIVE.test(line) || /missing|still|remain|not built|only|partial/i.test(line)) return;
        offenders.push(`${rel}:${i + 1}\n    ${line.trim().slice(0, 160)}`);
      });
    }
    expect(offenders, `🟡 markers that name no gap:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('at least one item carries each marker — an empty scan proves nothing', () => {
    const lines = PLANS.flatMap((r) => read(...r.split('/')).split('\n'));
    expect(lines.filter((l) => APPLIED.test(l)).length).toBeGreaterThan(8);
    expect(lines.filter((l) => /✅\s*\*{0,2}shipped/i.test(l)).length).toBeGreaterThan(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ROADMAP carries a status per item and no fictional split
// ─────────────────────────────────────────────────────────────────────────────

describe('the roadmap states where each item actually stands', () => {
  const roadmap = read('ROADMAP.md');

  it('does not re-assert the fee split that was never implemented', () => {
    // No 70/20/10 exists anywhere in the system; the live router has a staker-share
    // dial and a POL-share dial, with a referral share ahead of both that cannot be
    // zeroed. FAQ.md is guarded for the same figure in docsAddressTruth.test.ts.
    expect(roadmap).not.toMatch(/70\s*\/\s*20\s*\/\s*10/);
    expect(roadmap).not.toMatch(/70%\s+to\s+stakers/i);
  });

  it('every numbered item carries a status line', () => {
    const items = roadmap.match(/^\d+\.\s+\*\*/gm) ?? [];
    const statuses = roadmap.match(/^\s*-\s+\*\*Status:/gm) ?? [];
    expect(items.length).toBeGreaterThan(10);
    expect(statuses.length, 'an item was added or edited without saying where it stands').toBe(
      items.length,
    );
  });

  it('does not present a production statistic as if it had been measured', () => {
    // Several 2026 metrics are outcomes nothing in this repo measures. "unmeasured" is
    // the honest word for those and must stay in the file that uses it.
    expect(roadmap).toMatch(/unmeasured/i);
  });
});
