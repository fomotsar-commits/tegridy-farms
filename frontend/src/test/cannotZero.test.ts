// The word Cannot appears nowhere on the venue (island answer twenty-four, build 5; answer
// twenty-five, screen 2). e2e/cannot-zero.spec.ts walks the page text of every route, but only
// the branches a sealed walk renders; a toast, a refused button's label or a tooltip shows on
// a state no walk reaches. So every string the app source can show is read here too: string
// literals, template pieces and JSX text, never comments. A visitor is told what is true and
// the next move instead.
import { describe, it, expect } from 'vitest';
import { SRC, fromSrc, shownTexts, shownWith, sourceFiles } from './shownText';

/** The capital word, as a label or a sentence opens with it. */
const WORD = /\bCannot\b/;

describe('the word Cannot', () => {
  // Parses every source file with the TypeScript compiler, as pageTitlesNoEmDash.test.ts does:
  // its time is CPU, so the limit says "this is a long test" and loosens nothing asserted.
  it('is in no string the venue can show', { timeout: 30_000 }, () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(100);
    const offenders = shownWith(WORD);
    expect(offenders, `say what is true and the next move instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  // The range pools' copy is mostly refusals and warnings a sealed walk never shows (a frozen
  // pool, a reward short of what is owed, a position the site does not take out), so the word
  // is held out of it in lowercase too.
  it('nor in lowercase, in the range pools’ copy', { timeout: 30_000 }, () => {
    const RANGE = /^(components\/solana\/range\/|components\/solana\/curve\/Range|lib\/launcher\/solana\/write\/range|lib\/solana\/clmm\/|lib\/solana\/swap\/rangePools)/;
    expect(sourceFiles(SRC).filter((f) => RANGE.test(fromSrc(f))).length).toBeGreaterThan(15);
    const offenders = shownWith(/\bcannot\b/i, RANGE);
    expect(offenders, `say what is true and the next move instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('reads strings, templates and JSX text, and never a comment, so it cannot pass by reading nothing', () => {
    const source = [
      "// Cannot, in a comment, is nobody's copy",
      "const a = 'Cannot share';",
      'const b = `Cannot ${a} here`;',
      'const c = <p title="Cannot verify">Cannot launch</p>;',
    ].join('\n');
    expect(shownTexts('probe.tsx', source).filter((t) => WORD.test(t.text)).map((t) => t.text.trim())).toEqual([
      'Cannot share',
      'Cannot',
      'Cannot verify',
      'Cannot launch',
    ]);
  });
});
