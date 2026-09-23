// The venue explains heat in the island's sentences and states no formula, TWAB, window
// length, decay mechanic, sum of rooms, share-of-supply definition or link to
// memetics.wtf/island anywhere a reader is shown. The guards read the strings and JSX
// text a reader sees (userText), or source with its comments stripped (prose).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import ts from 'typescript';
import * as oracle from './heatOracle';
import { VENUE } from '../arrival';
import { venueFaq } from '../faqData';

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

  it('still names it continuous, the island label with no gloss of its own', () => {
    expect(heatCard).toMatch(/\bcontinuous\b/i);
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

  it('explains in the island paragraph, word for word', () => {
    const paragraph = 'Heat counts your warm days: every day you hold, weighted by size and by the coin. Your deepest room sets your heat; every other room adds half as much as the one before it, so breadth amplifies depth and never replaces it. Degrees are the temperature of that count: one real position held half a year reads 80°, Resident. Each degree after that takes longer than the last. Size can raise what a day is worth, it cannot buy a day, and price never enters it.';
    expect(VENUE.heatParagraph).toBe(paragraph);
    // The hero and llms.txt carry the paragraph's first two sentences, and only those.
    expect(VENUE.heatPlain).toBe('Heat counts your warm days: every day you hold, weighted by size and by the coin. Your deepest room sets your heat; every other room adds half as much as the one before it, so breadth amplifies depth and never replaces it.');
    expect(VENUE.heatParagraph.startsWith(`${VENUE.heatPlain} `)).toBe(true);
    expect(VENUE.heatDays).toBe('Your clock on a token starts at your first hold.');
    expect(VENUE.heatSize).toBe('A real position earns a full day. The largest holders earn up to two. Dust earns nothing.');
    // The Maths fold renders all three from VENUE; Weight stays its own sentence.
    const heatCard = prose(join(SRC, 'components', 'HeatCard.tsx'));
    for (const key of ['heatParagraph', 'heatDays', 'heatSize']) expect(heatCard).toContain(`VENUE.${key}`);
    expect(heatCard, 'weight is not defined as the published multiplier').toMatch(/published\s*\{?'?\s*\}?\s*multiplier/i);
  });

  it('names the Resident band the paragraph names, so a band cannot move without the words', () => {
    const resident = oracle.TIER_FLOORS.find((t) => t.tier === 'Resident');
    expect(VENUE.heatParagraph).toContain(`reads ${resident?.floor}°, Resident.`);
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
  it('is 80, Resident', () => {
    expect(oracle.LAUNCH_FLOOR).toBe(80);
    const resident = oracle.TIER_FLOORS.find((t) => t.tier === 'Resident');
    expect(resident?.floor).toBe(80);
  });
});

// Shipped source: src and api (tests excluded), public's text files, index.html,
// middleware.js, vercel.json and the build scripts that write text into dist.
// userText() is what a file can put in front of a reader: a script's
// string literals, template text and JSX text read from the TypeScript AST (so no
// comment, and no `/*` inside a string, hides or adds anything), one per line with its
// whitespace collapsed; any other file whole, minus HTML comments. Entities are decoded.
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
  const single = ['index.html', 'middleware.js', 'vercel.json', 'scripts/render-bungalow-doors.mjs', 'scripts/llms-txt.mjs'];
  return [...files, ...single.map((f) => join(ROOT, f))];
}

const SCRIPT: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};
const NAMED: Record<string, string> = { times: '×', middot: '·', sdot: '⋅', minus: '−', nbsp: ' ', amp: '&', apos: "'", quot: '"', deg: '°', radic: '√', divide: '÷' };
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
        parts.push(n.text.replace(/\s+/g, ' '));
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
    expect(shown(join(SRC, 'components', 'HeatCard.tsx'))).not.toContain('VENUE.heatParagraph');
  });

  it('reads the build scripts that write text into dist, and the deploy config', () => {
    expect(shown(join(ROOT, 'scripts', 'render-bungalow-doors.mjs'))).toContain('hold her for heat');
    expect(shown(join(ROOT, 'scripts', 'llms-txt.mjs'))).toContain('dist/llms.txt did not read back as written');
    expect(shown(join(ROOT, 'vercel.json'))).toContain('"outputDirectory": "dist"');
  });

  it('decodes the entities a formula can be written with', () => {
    expect(decode('80 &middot; &radic;(warm days &divide; 180) &times; 2')).toBe('80 · √(warm days ÷ 180) × 2');
  });
});

// The venue reads heat and never computes it, so it carries sentences, never a formula:
// a heat term on either side of `=` with an operator on the line, a `Heat:` definition
// with one, √, ∝, sqrt or Σ beside heat or rooms. A query string (`?heat=0x…`,
// `resource=heat`) is not one, `x` is an operator only standing alone, and `Σ(share²)`
// passes.
const TERM = String.raw`(?:island_heat|heat|deg(?:rees)?|warm days)`;
const OP = String.raw`(?:[+×·⋅*÷/^√∝−]|\s[-x]\s)`;
const FORMULA = new RegExp(
  [
    String.raw`(?<![?&\w])${TERM}\s*=\s*(?:Σ|[^=\n]*?${OP})`,
    String.raw`${OP}[^=\n]{0,60}\s=\s*${TERM}\b`,
    String.raw`\b${TERM}\s*:\s*[\w\s()]{1,40}?[×·⋅*÷/]`,
    String.raw`Σ\s*(?:rooms?|tokens?|degrees)|weight\s*[×·⋅*]\s*\(|days held\s*[×·⋅*]\s*rate|1\s*[−-]\s*e\s*\^`,
    String.raw`[√∝]|\bsqrt\s*\(|\bsquare root\b|\bwarm days\s*=`,
  ].join('|'),
  'i',
);

describe('no formula, TWAB or time-weighted in user-facing source', () => {
  it('knows the island law lines as formulas, and the island paragraph as sentences', () => {
    expect(FORMULA.test('degrees = 80 · √( warm days ÷ 180 )')).toBe(true);
    expect(FORMULA.test('degrees = 80 · ( warm days ÷ 180 )')).toBe(true);
    expect(FORMULA.test('warm days = weight · days held · rate')).toBe(true);
    expect(FORMULA.test('heat = weight × ( size + loyalty )')).toBe(true);
    expect(FORMULA.test('degrees = 80 x ( warm days ÷ 180 )')).toBe(true);
    expect(FORMULA.test('80 · sqrt( warm days ÷ 180 )')).toBe(true);
    expect(FORMULA.test('deg = 80 · sqrt(d/180)')).toBe(true);
    expect(FORMULA.test('heat = Σ rooms')).toBe(true);
    expect(FORMULA.test('island_heat = weight × days')).toBe(true);
    for (const line of [
      'heat = size + loyalty',
      'degrees = warm days ÷ 180',
      'heat = warm days / 180',
      'heat = days held ÷ 180',
      'heat = days held / 180',
      'heat = (weight × days) ÷ 180',
      'Heat: weight × days × rate',
      'warm days × weight × rate = heat',
      'degrees ∝ square root of warm days',
    ]) {
      expect(FORMULA.test(line), line).toBe(true);
    }
    for (const line of [
      '/api/aggregator?resource=heat',
      'https://memetics.wtf/heat?address=0x000000000000000000000000000000000000dEaD&x=1',
      'Dank Memes + Time = Memetic Finance.',
    ]) {
      expect(FORMULA.test(line), line).toBe(false);
    }
    expect(FORMULA.test('/?heat=0xabc')).toBe(false);
    expect(FORMULA.test('https://memetics.finance/?heat=0x000000000000000000000000000000000000dEaD')).toBe(false);
    expect(FORMULA.test('Σ(share²)')).toBe(false);
    expect(FORMULA.test(VENUE.heatParagraph)).toBe(false);
  });

  const TWAB = /\btwab\b/i;
  const TIME_WEIGHTED = /time[\s\u00ad\u2010-\u2015-]*weighted/i;
  it('knows TWAB in any case, and time-weighted with any hyphen or space', () => {
    for (const s of ['your twab', 'a Twab', 'TWAB']) expect(TWAB.test(s), s).toBe(true);
    for (const sep of ['-', ' ', '\u00a0', '\u00ad', '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '']) {
      expect(TIME_WEIGHTED.test(`time${sep}weighted`), JSON.stringify(sep)).toBe(true);
    }
    expect(TWAB.test('TWAP orders')).toBe(false);
  });

  // The retired Maths-fold sentence averaged over held time; the island paragraph replaced it.
  const AVERAGING = /average is taken|whole held time/i;
  it('knows the retired averaging sentence, and the island paragraph is not it', () => {
    expect(AVERAGING.test('The average is taken over your whole held time.')).toBe(true);
    expect(AVERAGING.test(VENUE.heatParagraph)).toBe(false);
  });

  const GUARDS: [string, RegExp][] = [
    ['a formula line', FORMULA],
    ['TWAB', TWAB],
    ['time-weighted', TIME_WEIGHTED],
    ['TWAB gloss', /balance at every\s+moment|balance held across time/i],
    ['averaging sentence', AVERAGING],
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

// The deepest room sets the heat and every other room amplifies it, so no user-facing
// sentence adds heat up across rooms or tokens, or says the number comes from them, and
// `summed` is refused anywhere. "adds to your heat" is the island's own sentence.
describe('no heat-summing sentence in user-facing source', () => {
  const SUMMING =
    /added\s+together|\bsummed\b|\bsum across\b|\brows sum to\b|\bon your total\b|\bsum of (?:your|the|its|every) (?:rooms?|tokens?|degrees|heat)\b|\badds? up across\b/i;
  const HEAT_SUM =
    /\b(?:heat|degrees?|warmth|flame)\b[^.\n]{0,80}\b(?:added together|summed|sums?|adds? up|combined|totall?ed|total of|added to)\b|\b(?:added together|summed|sums?|adds? up|combined|total of)\b[^.\n]{0,80}\b(?:heat|degrees?|rooms?|everything you hold)\b|\bwhere (?:the|your)\b[^.\n]{0,40}?\b(?:heat|degrees?)\s+comes? from\b|°\s*comes? from\b/i;
  const offenders = (re: RegExp) =>
    [...SHIPPED].flatMap(([f, text]) => {
      const m = re.exec(text);
      return m ? [`${relative(ROOT, f)}: "${m[0]}"`] : [];
    });

  it('says no heat is added together, summed, or totalled across rooms', () => {
    const found = offenders(SUMMING);
    expect(found, `a summing sentence in user-facing source:\n${found.join('\n')}`).toEqual([]);
  });

  it('pairs no heat word with a summing word in one sentence', () => {
    const found = offenders(HEAT_SUM);
    expect(found, `heat and a summing word in one sentence:\n${found.join('\n')}`).toEqual([]);
  });

  it('knows a summing sentence from the island paragraph and from unrelated sums', () => {
    for (const bad of [
      'It is read per token and added together across everything you hold.',
      'Your heat is summed across every token you hold.',
      'Sum across 10 tokens',
      'These rows sum to 1979.59°',
      'The tiers, on your total',
      'Degrees from each room add up to your heat.',
      'Your heat is the total of your rooms.',
      "Each room's degrees are added to your heat.",
      'Where your heat comes from',
      '° comes from',
    ]) {
      expect(SUMMING.test(bad) || HEAT_SUM.test(bad), bad).toBe(true);
    }
    for (const ok of [
      VENUE.heatParagraph,
      'Every fill below comes from GeckoTerminal’s public trade feed.',
      'Heat measures how long a wallet has held island tokens.',
      // The island's own sentence: every token adds, and the paragraph says how much.
      'Every token the island measures adds to your heat.',
      'Only swaps that spend the season quote token add to a total.',
      'Weights must sum to 10000.',
      'measured against the sum of ETH lent',
    ]) {
      expect(SUMMING.test(ok) || HEAT_SUM.test(ok), ok).toBe(false);
    }
  });
});

// Every heat explainer speaks in the island's sentences: none defines heat as a share of
// a supply, and the FAQ answers "What is Heat?" with the paragraph's own words.
describe('every heat explainer carries the island sentences', () => {
  it('defines heat by no share of supply anywhere a reader is shown', () => {
    const found = [...SHIPPED].flatMap(([f, text]) => {
      const m = /how much of a token you (?:have )?held|as a share of its supply/i.exec(text);
      return m ? [`${relative(ROOT, f)}: "${m[0]}"`] : [];
    });
    expect(found, `a share-of-supply definition of heat:\n${found.join('\n')}`).toEqual([]);
  });

  it('answers "What is Heat?" in the island sentences', () => {
    const answer = venueFaq(80).flatMap((s) => s.items).find((i) => i.q === 'What is Heat?')?.a;
    expect(answer).toBe(`${VENUE.heatPlain} ${VENUE.heatDays} Price never enters it.`);
  });
});
