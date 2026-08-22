// SPENT-PROGRAM-ID TRIPWIRE for the own-venue Solana rail.
//
// Both `tegridy-launch` and the cp-swap fork were deployed to mainnet 2026-08-08 and
// CLOSED on 2026-08-13. On Solana a closed upgradeable program id is permanently spent:
// the ProgramData account is deleted and the id can never hold a program again.
//
// Five files in this module went on saying the opposite for nine days — a README, the
// barrel, the instruction builders, the identity module and the operator harness — while
// `frontend/scripts/addresses.json` recorded the closure. Code and registry disagreed in
// public, and `verify-addresses.mjs` check 5b cross-checks the very literal that was
// being mislabelled.
//
// `docsReconciliation.test.ts` already guards the markdown at the repo root, under
// `docs/` and under `solana/tegridy-amm/`. None of the files below are in any of those
// places, which is why the claim survived there. This file closes that gap: the same
// rule, applied to the SOURCE that a reader is most likely to trust.
//
// WHAT THIS CANNOT DO. It reads text, so it can only catch a claim that is written down.
// The chain-side proof lives in the registry — both ProgramData addresses are registered
// with `expect: {type: 'absent'}`, which `verify-addresses.mjs` enforces unconditionally
// against mainnet. A sentence about closure is a claim; an absent-account check is a
// read. This file guards the sentences.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** `frontend/`, two levels above `src/lib/launcher/solana`. */
const FRONTEND = join(MODULE_DIR, '..', '..', '..', '..');

/**
 * The two ids, with the ProgramData account whose absence is the actual evidence.
 *
 * ⚠ MAY ONLY GROW BY A REAL CLOSURE. Removing an entry asserts that a spent program id
 * became reusable, which Solana does not permit.
 */
const SPENT = [
  {
    what: 'tegridy-launch',
    programId: 'CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED',
    programData: '6vV7DqMyGwpM18rf2Lkefa1U9YfKquZjvwA61ch3FsnS',
  },
  {
    what: 'the cp-swap fork',
    programId: '3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y',
    programData: '6TnZb1GTHhPAYsrbtwfELkqQrXyqCfv7V6s27RJKXHAF',
  },
] as const;

// ── what gets scanned ────────────────────────────────────────────────────────

/**
 * Test files are excluded because this file is one: including them would make the
 * self-test below scan its own counter-examples and fail on them.
 */
const SCANNABLE = /\.(?:ts|tsx|md)$/i;
const EXCLUDED = /\.(?:test|spec)\.tsx?$|\.fixture\.ts$/i;

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(p, acc);
    } else if (SCANNABLE.test(e.name) && !EXCLUDED.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Every non-test surface in this module, plus the operator harness it drives. */
function scannedFiles(): string[] {
  return [...walk(MODULE_DIR), join(FRONTEND, 'scripts', 'tegridy-launch-operator.mjs')];
}

const rel = (f: string) => f.slice(FRONTEND.length + 1).split(sep).join('/');

// ── the shapes ───────────────────────────────────────────────────────────────

/**
 * Present-tense liveness, in the wordings this module actually used. Past tense is
 * deliberately outside the shape: describing what the rail DID is history and must stay
 * legal, or the guard just forces a different lie.
 */
const ASSERTS_LIVE =
  /\b(?:the program is live|the rail is live|is live on mainnet|live on mainnet|has been live|is live|are live|deployed to (?:solana )?mainnet|live mainnet|deployed address|not yet deployed)\b/i;

/**
 * Anything that retracts, dates or historicises the claim.
 *
 * Matched over a WINDOW of surrounding lines, not the single line, because a prose
 * paragraph and a doc comment both carry the correction a line or two away from the
 * phrase. That trades precision for the thing that matters here: a corrected paragraph
 * must survive, and a bare liveness banner must not.
 */
const RETRACTS =
  /clos(?:e|ed|ure|ing)|spent|stranded|cannot (?:execute|be redeployed)|permanently|no longer|\bwas\b|\bwere\b|used to|ran (?:at|from)|deleted|retired|⛔/i;

/** How far either side of a hit the retraction may sit. One doc comment's worth. */
const WINDOW = 8;

function windowAround(lines: string[], i: number): string {
  return lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join('\n');
}

// ── 1. guard the guard ───────────────────────────────────────────────────────

describe('the scan reaches the files that carried the claim', () => {
  it('covers every file that asserted the rail was live', () => {
    const files = scannedFiles().map(rel);
    for (const must of [
      'src/lib/launcher/solana/README.md',
      'src/lib/launcher/solana/curve/index.ts',
      'src/lib/launcher/solana/curve/ix.ts',
      'src/lib/launcher/solana/curve/program.ts',
      'src/lib/launcher/solana/curve/geometry.ts',
      'src/lib/launcher/solana/curve/rpc.ts',
      'scripts/tegridy-launch-operator.mjs',
    ]) {
      expect(files, `${must} is not being scanned`).toContain(must);
    }
  });

  it('finds both spent ids in the scanned text — an empty scan proves nothing', () => {
    const all = scannedFiles().map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const s of SPENT) {
      expect(all.includes(s.programId), `${s.what}'s id (${s.programId}) appears nowhere`).toBe(
        true,
      );
    }
  });
});

// ── 2. no spent id may read as a live target ─────────────────────────────────

describe('no spent program id is presented as a live target', () => {
  it('every mention of a spent id sits next to its retraction', () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const s of SPENT) {
          if (!line.includes(s.programId)) continue;
          if (RETRACTS.test(windowAround(lines, i))) continue;
          offenders.push(
            `${rel(file)}:${i + 1} names ${s.what}'s spent id with nothing nearby saying it is ` +
              `closed\n    ${line.trim().slice(0, 160)}`,
          );
        }
      });
    }
    expect(offenders, `spent ids stated without their closure:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });

  it('nothing in the module claims the rail is running', () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!ASSERTS_LIVE.test(line)) return;
        if (RETRACTS.test(windowAround(lines, i))) return;
        offenders.push(`${rel(file)}:${i + 1}\n    ${line.trim().slice(0, 160)}`);
      });
    }
    expect(offenders, `unretracted liveness claims:\n${offenders.join('\n')}`).toEqual([]);
  });
});

// ── 3. the shapes still fire, and still let the truth through ────────────────

describe('the tripwire is not vacuous', () => {
  // Reworded from the originals on purpose: the shape is pinned, not a quotation.
  const REMOVED = [
    '// THE PROGRAM IS LIVE ON MAINNET since 2026-08-08. `PROGRAM_ID` below is the',
    ' * DEPLOYED TO MAINNET 2026-08-08 at `CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED`',
    '/** The cp-swap fork a launch graduates into. Mainnet id — NOT yet deployed. */',
    '**That program has been live on mainnet since 2026-08-08**',
  ];
  const KEPT = [
    '// It ran on mainnet from 2026-08-08 until its ProgramData was deleted on 2026-08-13.',
    '/** ⛔ SPENT. Nothing can be deployed to this address again. */',
    'both ids are permanently unusable and a restart needs fresh keypairs',
  ];

  it('fires on each wording this slice removed', () => {
    for (const bad of REMOVED) {
      expect(ASSERTS_LIVE.test(bad), `no longer detected: ${bad}`).toBe(true);
      expect(RETRACTS.test(bad), `would be excused as retracted: ${bad}`).toBe(false);
    }
  });

  it('lets the corrected wording through, or it only forces a different lie', () => {
    for (const good of KEPT) {
      expect(
        ASSERTS_LIVE.test(good) && !RETRACTS.test(good),
        `honest wording would be rejected: ${good}`,
      ).toBe(false);
    }
  });

  it('a bare spent id with no retraction anywhere near it is caught', () => {
    const lines = ['const target = new PublicKey(', `  '${SPENT[0].programId}',`, ');'];
    expect(RETRACTS.test(windowAround(lines, 1))).toBe(false);
  });
});

// ── 4. the constants stay, and stay marked ───────────────────────────────────

describe('curve/program.ts marks the ids rather than hiding them', () => {
  const src = readFileSync(join(MODULE_DIR, 'curve', 'program.ts'), 'utf8');

  // Deleting them is not the fix. Every derivation and builder in `curve/` reads them,
  // and verify-addresses.mjs check 5b matches these literals against the registry
  // entries that hold the closure evidence — the only place the two can be compared.
  it('still declares both, so check 5b has something to compare', () => {
    for (const s of SPENT) {
      expect(src.includes(s.programId), `${s.what}'s id was removed from program.ts`).toBe(true);
    }
  });

  it("each declaration's doc comment says the id is spent", () => {
    const lines = src.split('\n');
    for (const s of SPENT) {
      const i = lines.findIndex((l) => l.includes(`new PublicKey('${s.programId}')`));
      expect(i, `${s.what}'s id is no longer a PublicKey literal — check 5b reads that shape`).
        toBeGreaterThan(-1);
      expect(
        /\bSPENT\b/.test(lines.slice(Math.max(0, i - WINDOW), i).join('\n')),
        `${s.what}'s declaration does not say SPENT; a reader can mistake it for a target`,
      ).toBe(true);
    }
  });
});
