import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// REGRESSION GUARD (2026-07-24). The Tradermigos sub-app renders inside the
// app-wide `<LazyMotion features={domAnimation} strict>` wrapper (App.tsx). In
// strict mode, rendering a bare `motion.*` component THROWS — which crashed the
// entire marketplace on visit. Four components were migrated `motion.* -> m.*`.
//
// A render test is unreliable here: the components branch on matchMedia
// (coarse-pointer / reduced-motion), so under jsdom they take a LITE path that
// renders no motion component and never trips the throw (verified — a render
// test stayed green with `motion.*` restored). So we pin the invariant at the
// source: no file under nakamigos/ may import the bare `motion` proxy from
// framer-motion. `m`, `MotionConfig`, `AnimatePresence`, `useReducedMotion`,
// `useAnimation`, etc. are all fine. This fails deterministically on the pre-fix
// code (4 offending imports) and passes after the swap.
const HERE = dirname(fileURLToPath(import.meta.url));

function jsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsxFiles(p));
    else if (/\.(jsx?|tsx?)$/.test(name) && !/\.test\.[jt]sx?$/.test(name)) out.push(p);
  }
  return out;
}

// Pull every `import { ... } from "framer-motion"` specifier list out of a file
// and return the set of IMPORTED names (the part before `as`). Flagging the
// imported name — not the local alias — correctly catches `motion as m` too,
// since that still binds the full `motion` proxy that throws under strict.
function framerImportedNames(src: string): string[] {
  const names: string[] = [];
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']framer-motion["']/g;
  let mch: RegExpExecArray | null;
  while ((mch = re.exec(src)) !== null) {
    for (const spec of mch[1].split(',')) {
      const imported = spec.trim().split(/\s+as\s+/)[0].trim();
      if (imported) names.push(imported);
    }
  }
  return names;
}

describe('nakamigos is safe under LazyMotion strict', () => {
  it('no component imports the bare `motion` proxy from framer-motion', () => {
    const offenders = jsxFiles(HERE)
      .filter((f) => framerImportedNames(readFileSync(f, 'utf8')).includes('motion'))
      .map((f) => f.slice(HERE.length + 1).replace(/\\/g, '/'));
    expect(offenders, `use \`m.*\` (not \`motion.*\`) under LazyMotion strict: ${offenders.join(', ')}`).toEqual([]);
  });
});
