// WHAT THE ISLAND HAS ACTUALLY CONFIRMED ABOUT THE INSTRUMENT — Wave 3, phase 06(b).
//
// The venue published a number the island never gave it. `heatOracle.ts` carried
// `TWAB_WINDOW_DAYS = 180` under the header "CONFIRMED BY THE ISLAND 2026-08-07", and
// an explainer built a whole mechanic on top of it: that the window ROLLS, so "a wallet
// that sells decays out of the average over the following 180 days". Both were rendered
// to users on /leaderboard.
//
// Wave 3 says plainly: that constant is not island-confirmed, and the decay story built
// on it is untrue. The instrument's confirmed properties are exactly three —
//
//     continuous · zero-anchored from first hold · velocity-blind
//
// — and wallets should be shown HELD TIME SINCE FIRST HOLD. No calendar. No decay
// schedule. Exact window semantics arrive from the island when they are published.
//
// This is the same defect class as the fee claims: an unknown published as a confident
// value. It is worse here, because the number was attributed to a third party who never
// said it. So these tests pin the RULE, not the wording: the venue may describe the
// three properties, and may not state a window length or a decay mechanic anywhere a
// user can read it.
//
// When the island publishes the window, delete the guard in `does not state an averaging
// window` and nothing else — the three properties stay true either way.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import ts from 'typescript';
import * as oracle from './heatOracle';
import { VENUE } from '../arrival';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Comments carry the correction notes, which quote the retired wording on purpose. */
function prose(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

describe('the venue does not publish an averaging window the island has not given it', () => {
  it('exports no TWAB window constant', () => {
    // The number itself is the defect. While it exists, something will render it.
    expect(
      'TWAB_WINDOW_DAYS' in oracle,
      'heatOracle must not export a window length until the island publishes one',
    ).toBe(false);
  });

  it('states no averaging-window length in any user-facing source', () => {
    // Catches BOTH a literal ("over the last 180 days") and the interpolated constant
    // ("over the last {TWAB_WINDOW_DAYS} days"). The JSX form is how it actually
    // shipped, so a literal-only pattern would have passed on the live defect.
    const WINDOW_CLAIM =
      /(averaged over the last|averaging window|measurement window)[^.]{0,80}(\b\d+\s*days?\b|TWAB_WINDOW_DAYS)|\b\d+\s*[- ]day (?:averaging )?window|TWAB_WINDOW_DAYS/i;
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const m = WINDOW_CLAIM.exec(prose(file));
      if (m) offenders.push(`${file.slice(SRC.length + 1)} — "${m[0]}"`);
    }
    expect(offenders, `an unpublished window length is stated here:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('describes no decay or roll-off mechanic', () => {
    // "Warmth is not banked; a wallet that sells decays out of the average" is a
    // mechanic the island never described. Velocity-blind is confirmed; decay is not.
    const DECAY = /(decays? out of|rolls? off|warmth is not banked|window\s+(?:that\s+)?rolls)/i;
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const m = DECAY.exec(prose(file));
      if (m) offenders.push(`${file.slice(SRC.length + 1)} — "${m[0]}"`);
    }
    expect(offenders, `an unconfirmed decay mechanic is described here:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('the three confirmed properties survive', () => {
  // The correction must not strip the instrument's real guarantees along with the
  // invented ones. Over-correcting is the failure mode on the other side.
  const heatCard = readFileSync(join(SRC, 'components', 'HeatCard.tsx'), 'utf8');

  it('still explains zero-anchoring from first hold', () => {
    expect(heatCard).toMatch(/before you first held counts as zero|zero[- ]anchored/i);
  });

  it('still explains velocity-blindness', () => {
    expect(heatCard).toMatch(/churn earns nothing|velocity[- ]blind/i);
  });

  it('still explains that it is continuous, not a snapshot', () => {
    expect(heatCard).toMatch(/balance at every\s+moment|continuous/i);
  });
});

// The island's law page carries the formula. The venue explains heat in the island's
// sentences and states no per-token cap, no unreachable tier and no curve arithmetic.
describe('the venue teaches the whole published law, not one term of it', () => {
  const userFacing = walk(SRC).map(prose).join('\n');

  it('states no per-token cap of 100 anywhere a user can read it', () => {
    expect(userFacing).not.toMatch(/0 to 100 degrees/i);
    expect(userFacing).not.toMatch(/caps? at 100/i);
    expect(userFacing).not.toMatch(/never exceed 100/i);
  });

  it('does not claim the upper tiers are unreachable from one position', () => {
    expect(userFacing).not.toMatch(/unreachable on a single position/i);
  });

  it('no longer says the averaging period is unpublished, because it is published', () => {
    expect(userFacing).not.toMatch(/has not been published/i);
  });

  it('explains in the island sentences, word for word', () => {
    expect(VENUE.heatPlain).toBe(
      'Heat counts the days you have held each token. It is read per token and added together across everything you hold. Size can raise what a day is worth, it cannot buy a day, and price never enters it.',
    );
    expect(VENUE.heatDays).toBe('Your clock on a token starts at your first hold.');
    expect(VENUE.heatSize).toBe('A real position earns a full day. The largest holders earn up to two. Dust earns nothing.');
    // The Maths fold renders all three from VENUE; Weight stays its own sentence.
    const heatCard = prose(join(SRC, 'components', 'HeatCard.tsx'));
    for (const key of ['heatPlain', 'heatDays', 'heatSize']) expect(heatCard).toContain(`VENUE.${key}`);
    expect(heatCard, 'weight is not defined as the published multiplier').toMatch(/published\s*\{?'?\s*\}?\s*multiplier/i);
  });

  it('retires the arithmetic it can no longer do honestly', () => {
    // A table of what the size curve pays, and a single-token share for
    // Observer, are not anybody's number once weight and loyalty are in the law.
    const heatCard = prose(join(SRC, 'components', 'HeatCard.tsx'));
    expect(heatCard).not.toMatch(/What the curve pays/i);
    expect(heatCard).not.toMatch(/of its whole supply/i);
  });
});

describe('the launch floor is the island word', () => {
  it('is 180, Resident', () => {
    expect(oracle.LAUNCH_FLOOR).toBe(180);
    const resident = oracle.TIER_FLOORS.find((t) => t.tier === 'Resident');
    expect(resident?.floor).toBe(180);
  });
});

// Shipped source: src and api (tests excluded), public's text files, index.html and
// middleware.js. userText() is what a file can put in front of a reader: a script's
// string literals, template text and JSX text read from the TypeScript AST (so no
// comment, and no `/*` inside a string, hides or adds anything); any other file whole,
// minus HTML comments. HTML entities are decoded in both.
const ROOT = process.cwd();
const TEXT = /\.(tsx?|jsx?|mjs|cjs|html|json|txt|xml|webmanifest)$/;
function shipped(): string[] {
  const files = walk(SRC);
  const stack = [join(ROOT, 'api'), join(ROOT, 'public')];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__') stack.push(p);
      } else if (TEXT.test(e.name) && !/\.test\./.test(e.name)) files.push(p);
    }
  }
  return [...files, join(ROOT, 'index.html'), join(ROOT, 'middleware.js')];
}

const SCRIPT: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};
const NAMED: Record<string, string> = { times: '×', middot: '·', sdot: '⋅', minus: '−', nbsp: ' ', amp: '&', apos: "'", quot: '"', deg: '°' };
function decode(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] !== '#') return NAMED[e] ?? m;
    const n = /^#[xX]/.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}
function userText(file: string): string {
  const raw = readFileSync(file, 'utf8');
  const kind = SCRIPT[extname(file)];
  const parts: string[] = [];
  if (kind === undefined) {
    parts.push(/\.(html|xml)$/.test(file) ? raw.replace(/<!--[\s\S]*?-->/g, ' ') : raw);
  } else {
    const visit = (n: ts.Node): void => {
      if (
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateHead(n) ||
        ts.isTemplateMiddle(n) ||
        ts.isTemplateTail(n) ||
        ts.isJsxText(n)
      ) {
        parts.push(n.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, false, kind));
  }
  return decode(parts.join('\n'));
}
// Read once, while the file is collected: parsing every shipped file can outlast one
// test's timeout on a loaded machine.
const SHIPPED = new Map(shipped().map((f) => [f, userText(f)] as const));
const shown = (file: string): string => SHIPPED.get(file) ?? '';

describe('the guards below read what a reader is shown', () => {
  it('sees strings, JSX text with its entities decoded, and the first frame', () => {
    expect(SHIPPED.size).toBeGreaterThan(800);
    expect(shown(join(SRC, 'lib', 'arrival.ts'))).toContain(VENUE.heatDays);
    // prose() loses this item: its block strip starts at the `/*` in '/splash/*.png'.
    expect(shown(join(SRC, 'pages', 'ChangelogPage.tsx'))).toContain('Added reentrancy tests for NFT Pool contracts');
    expect(shown(join(SRC, 'pages', 'SecurityPage.tsx'))).toContain("the venue's record");
    expect(shown(join(ROOT, 'index.html'))).toContain('Your heat already exists.');
    expect(shown(join(ROOT, 'middleware.js'))).toContain('Held time counts here.');
    expect(shown(join(SRC, 'components', 'HeatCard.tsx'))).not.toContain('VENUE.heatPlain');
  });
});

// The venue reads heat and never computes it, so it carries sentences, never a
// formula. An `x` counts as an operator only standing alone, so `?heat=0x…` is not one.
describe('no formula, TWAB or time-weighted in user-facing source', () => {
  const GUARDS: [string, RegExp][] = [
    ['a formula line', /\bheat\s*=\s*\w+(?:\s*[×·⋅*]|\s+x\s)|weight\s*[×·⋅*]\s*\(|days held\s*[×·⋅*]\s*rate|1\s*[−-]\s*e\s*\^/i],
    ['TWAB', /\bTWAB\b/],
    ['time-weighted', /time[- ]weighted/i],
  ];
  for (const [name, re] of GUARDS) {
    it(`states no ${name}`, () => {
      const offenders = [...SHIPPED].flatMap(([f, text]) => {
        const m = re.exec(text);
        return m ? [`${relative(ROOT, f)}: "${m[0]}"`] : [];
      });
      expect(offenders, `${name} in user-facing source:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('exports no heat curve or formula constant from the oracle', () => {
    for (const name of ['HEAT_K', 'heatDegreesFor', 'shareForDegrees']) {
      expect(name in oracle, `heatOracle exports ${name}`).toBe(false);
    }
  });
});

// The island is linked by its public paths, never memetics.wtf/island.
describe('no link to memetics.wtf/island', () => {
  it('names it in no shipped source', () => {
    const offenders = [...SHIPPED].filter(([, text]) => /memetics\.wtf\/+island/i.test(text)).map(([f]) => relative(ROOT, f));
    expect(offenders, `memetics.wtf/island is linked from:\n${offenders.join('\n')}`).toEqual([]);
  });
});
