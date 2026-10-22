// A room's explanation sits in FinePrint, closed (owner, 2026-10-21, with /bayla's word
// ceiling raised to 500 for the three cards: "keep every movable line folded"). Pinned on
// the room's source, as roomPoolLine.test.tsx pins the pool line's words.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'HomePage.tsx'), 'utf8');

function between(from: string, to: string): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  expect(start, `found ${from}`).toBeGreaterThan(-1);
  expect(end, `found ${to} after it`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("a room's folded lines", () => {
  it('the pool on record is in FinePrint; the no-pool sentence stays on the page', () => {
    const block = between('element D: THE POOL, OR THE HONEST LINE', 'Who holds her');
    const members = between('stakePoolMembersOnly(bungalowIdentity) ? (', ') : bungalowIdentity.stakePool ? (');
    const open = between(') : bungalowIdentity.stakePool ? (', 'staking program exists on-chain today');
    expect(members).toContain('<FinePrint');
    expect(members).toContain('is on record at');
    expect(open).toContain('<FinePrint');
    expect(open).toContain('is on record at');
    const noPoolAt = block.indexOf('staking program exists on-chain today');
    const noPool = block.slice(block.lastIndexOf(') : (', noPoolAt), noPoolAt);
    expect(noPool.length, 'the no-pool branch').toBeGreaterThan(0);
    expect(noPool, 'the no-pool branch').not.toContain('<FinePrint');
  });

  it("the lore's paragraphs are in FinePrint; its title and links stay on the page", () => {
    const lore = between('bungalowIdentity?.identity.lore && (', 'lore.links.map');
    const fold = lore.indexOf('<FinePrint');
    const paragraphs = lore.indexOf('lore.paragraphs.map');
    expect(fold, 'a FinePrint in the lore').toBeGreaterThan(lore.indexOf('lore.title'));
    expect(paragraphs, 'the paragraphs inside it').toBeGreaterThan(fold);
    expect(lore.indexOf('</FinePrint>'), 'closed before the links').toBeGreaterThan(paragraphs);
  });
});
