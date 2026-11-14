// @vitest-environment node
//
// A CLOSED DROP-DOWN SAYS IT OPENS (pre-merge read, 2026-11-14). A <summary> laid out as `flex`
// loses the browser's own marker, so the LP forms' Risks box and "More about this pool" drew no
// arrow while the small print beside them (FinePrint) did: closed, nothing said they opened.
// Every flex summary in the app draws an arrow of its own. And an address inside a sentence
// wraps as one token (`[overflow-wrap:anywhere]`): `break-all` split a pool's address after its
// first seven characters at the end of a line, so it read as two things.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(tsx|jsx)$/.test(e.name) && !/\.(test|stories)\./.test(e.name)) out.push(p);
  }
  return out;
}

/** Each <summary ...>...</summary> in a file: its opening tag and what it holds. */
function summaries(src: string): { tag: string; body: string; line: number }[] {
  const out: { tag: string; body: string; line: number }[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf('<summary', from);
    if (at < 0) return out;
    // The opening tag ends at the first '>' outside braces (an attribute can hold `=>`).
    let depth = 0;
    let end = at;
    for (; end < src.length; end++) {
      const c = src[end];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const close = src.indexOf('</summary>', end);
    if (close < 0) return out; // a "<summary>" named in a comment, with no element after it
    out.push({ tag: src.slice(at, end + 1), body: src.slice(end + 1, close), line: src.slice(0, at).split('\n').length });
    from = close + 1;
  }
}

/** A summary laid out as flex, which draws no marker of the browser's own. */
const FLEX = /(^|[\s"'`{])(inline-)?flex(\s|["'`}]|$)|display:\s*["']flex/;
/** An arrow the summary draws itself: the shared one, an icon, or a glyph. */
const ARROW = /<DisclosureArrow\b|<svg\b|[▾▸▶]|&#9656;|&#9654;|>\+</;
/** RangeRisks.tsx is another pull request's (#1242) to change today; its summary gets the arrow after it lands. */
const NOT_YET = new Set(['components/solana/range/RangeRisks.tsx']);

describe('a flex <summary> draws its own open/closed arrow', () => {
  const files = sourceFiles(SRC).map((f) => ({ rel: relative(SRC, f).replaceAll('\\', '/'), src: readFileSync(f, 'utf8') }));

  it('every one in the app, but the one another pull request is changing', () => {
    const bare: string[] = [];
    for (const { rel, src } of files) {
      for (const s of summaries(src)) {
        if (FLEX.test(s.tag) && !ARROW.test(s.body) && !NOT_YET.has(rel)) bare.push(`${rel}:${s.line}`);
      }
    }
    expect(bare).toEqual([]);
  });

  it('the exception is still bare: once it draws an arrow, take it off the list', () => {
    for (const rel of NOT_YET) {
      const src = files.find((f) => f.rel === rel)?.src ?? '';
      expect(summaries(src).some((s) => FLEX.test(s.tag) && !ARROW.test(s.body)), rel).toBe(true);
    }
  });

  it('sees the LP forms\' summaries: the shared one in LpDisclosures.tsx draws the arrow, and the cards use it', () => {
    const lp = files.find((f) => f.rel === 'components/solana/lp/LpDisclosures.tsx')!.src;
    expect(summaries(lp).map((s) => ARROW.test(s.body))).toEqual([true]);
    for (const rel of ['components/solana/lp/PoolCard.tsx', 'components/solana/lp/YourPositions.tsx']) {
      const src = files.find((f) => f.rel === rel)!.src;
      expect(summaries(src), rel).toEqual([]);
      expect(src, rel).toMatch(/<LpSummary\b/);
    }
  });
});

describe('an address inside a sentence wraps as one token', () => {
  // An address, or one value, closed on the same line: the form a sentence holds. A figure on a
  // row of its own (LaunchBuyPanel's amounts) is not one.
  const INLINE = /<span className="font-mono break-all">(\{[^}]+\}|[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})<\/span>/;

  it('no inline address span breaks anywhere', () => {
    const split = sourceFiles(SRC)
      .flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => ({ at: `${relative(SRC, f).replaceAll('\\', '/')}:${i + 1}`, l })))
      .filter(({ l }) => INLINE.test(l))
      .map(({ at }) => at);
    expect(split).toEqual([]);
  });

  it('the pattern sees the forms the LP cards used', () => {
    expect(INLINE.test('The biggest is <span className="font-mono break-all">{pool.address}</span>, holding')).toBe(true);
    expect(INLINE.test('pool program <span className="font-mono break-all">EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT</span> and')).toBe(true);
    expect(INLINE.test('The biggest is <span className="font-mono [overflow-wrap:anywhere]">{pool.address}</span>, holding')).toBe(false);
  });
});
