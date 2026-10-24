// @vitest-environment node
//
// The reader and writer behind vercel.json's script-src pins. The pins themselves, for
// index.html and every door page, are asserted in src/lib/siteIdentity.test.ts and
// src/lib/bungalowDoors.test.ts; this file proves `--write` touches nothing else.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cspHash, inlineScriptBodies, pageHashes, pinHashes, pinnedHashes } from './csp-hashes.mjs';

const vercelJson = readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8');
const sha = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const A = sha('a');
const B = sha('b');

describe('inlineScriptBodies', () => {
  it('reads every inline script, any tag case, LF endings, and skips external ones', () => {
    const html = '<script src="/x.js"></script><script type="application/ld+json">{"a":1}\r\n</script><SCRIPT>b()</SCRIPT >';
    expect(inlineScriptBodies(html)).toEqual(['{"a":1}\n', 'b()']);
    expect(pageHashes(html)).toEqual([sha('{"a":1}\n'), sha('b()')]);
    expect(cspHash('a')).toBe(A);
  });
});

describe('pinHashes', () => {
  it('pins exactly the hashes given, once each, after self, and keeps every other byte', () => {
    const out = pinHashes(vercelJson, [A, B, A]);
    expect(pinnedHashes(out)).toEqual([A, B]);
    const csp = (text) => JSON.parse(text).headers.flatMap((r) => r.headers).find((h) => h.key === 'Content-Security-Policy').value;
    const scriptSrc = (text) => csp(text).split(';').find((d) => d.trim().startsWith('script-src')).trim();
    expect(scriptSrc(out)).toBe(`script-src 'self' ${A} ${B} 'wasm-unsafe-eval'`);
    const outside = (text) => text.split(scriptSrc(text));
    expect(outside(out)).toEqual(outside(vercelJson));
  });

  it('reads only script-src, and refuses anything that is not a sha256 source', () => {
    const withStyleHash = vercelJson.replace("style-src 'self'", `style-src 'self' ${B}`);
    expect(pinnedHashes(withStyleHash)).toEqual(pinnedHashes(vercelJson));
    expect(() => pinHashes(vercelJson, ["'unsafe-inline'"])).toThrow(/not a sha256 source/);
  });
});
