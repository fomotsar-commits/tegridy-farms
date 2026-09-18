import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// WIRING GUARD for the post-graduation re-attest verdict.
//
// readMigrationStream cannot read the V1 locker yet, so it always returns
// `{ graduated: false, unsupported: true }`. PostGraduationReattest used to ignore
// `unsupported` and set phase 'not-graduated', which rendered "No fee stream for this
// token … it either hasn't graduated yet … or it wasn't launched through this rail" — a
// negative claim about ANY token, from a read the code never performs.
//
// verdictFromReads (lockerStream.test.ts) pins the rule. Nothing there can see whether the
// page still CALLS it: the component is unexported and its onCheck path needs a connected
// mainnet wallet, so restoring the old inline `if (!stream) → 'not-graduated'` leaves every
// behavioural test green. So pin the call site at the source, like launchPriceWiring.test.ts.

const LAUNCH_PAGE = join(process.cwd(), 'src', 'pages', 'LaunchPage.tsx');

describe('LaunchPage re-attest verdict wiring', () => {
  const src = readFileSync(LAUNCH_PAGE, 'utf8');

  /** Strip comments so prose describing the old bug never satisfies (or trips) the check. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('derives the non-graduated phase from verdictFromReads', () => {
    expect(code).toMatch(/verdictFromReads\(\s*reads\s*\)/);
    expect(code).toMatch(/setState\(\{\s*phase:\s*verdict\.kind\s*\}\)/);
  });

  it('never sets "not-graduated" directly — only the verdict may make that claim', () => {
    expect(code).not.toMatch(/phase:\s*'not-graduated'\s*\}\s*\)/);
  });

  it('renders an unsupported state that makes no claim about the token', () => {
    const at = code.indexOf("state.phase === 'unsupported'");
    expect(at).toBeGreaterThan(-1);
    const branch = code.slice(at, code.indexOf('</p>', at));
    expect(branch).toMatch(/says nothing about this token/);
    expect(branch).not.toMatch(/hasn&rsquo;t graduated|wasn&rsquo;t launched/);
  });
});
