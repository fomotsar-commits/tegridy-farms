// The three pitches for /eth-curve must not sell a launch as "one signature". It is not:
// the wallet signs the image upload, sends the create transaction, then signs the metadata
// upload (CurveCreatePanel.tsx, irysClient.ts). Source is scanned with comments stripped,
// because the pitches are a data field, a JSX paragraph and an assistant answer.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { KNOWLEDGE_BASE } from '../lib/towelieKnowledge';

const HERE = dirname(fileURLToPath(import.meta.url));
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (name: string) => stripComments(readFileSync(join(HERE, name), 'utf-8'));

const ONE_SIGNATURE = /one signature/i;

describe('no /eth-curve pitch sells a launch as one signature', () => {
  it("the home page's Memetics Curve card", () => {
    const src = read('HomePage.tsx');
    expect(src, 'the card this guards is gone').toContain('Our own zero-toll bonding curve.');
    expect(src).not.toMatch(ONE_SIGNATURE);
  });

  it("the /eth-curve page's own hero", () => {
    const src = read('EthCurvePage.tsx');
    expect(src, 'the hero this guards is gone').toContain('Our own bonding curve.');
    expect(src).not.toMatch(ONE_SIGNATURE);
  });

  it("Towelie's launcher answer", () => {
    const curve = KNOWLEDGE_BASE.filter((e) => e.answer.includes('/eth-curve'));
    expect(curve.length, 'no Towelie answer names /eth-curve any more').toBeGreaterThan(0);
    for (const e of curve) expect(e.answer).not.toMatch(ONE_SIGNATURE);
  });
});
