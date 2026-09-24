/**
 * /contracts links each row's source to GitHub. A link to a path the repo does not
 * track is a 404, and GitHub paths are case-sensitive, so the check reads
 * `git ls-files` rather than the filesystem (Windows would call TOWELI.sol present).
 * A row with no link must say why ('external (...)' or 'not in this repo (...)'), so a
 * mistyped path cannot quietly lose its link. Our live contracts whose deployed source
 * the repo does not hold get no link and stay in the Etherscan verification query.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GITHUB_BLOB_BASE, TOWELI_ADDRESS, TEGRIDY_FEE_HOOK_ADDRESS } from '../lib/constants';

const queried: string[][] = [];
vi.mock('../hooks/useSourceVerification', () => ({
  useSourceVerification: (addresses: string[]) => {
    queried.push(addresses);
    return {};
  },
}));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));

import ContractsPage from './ContractsPage';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TRACKED = new Set(
  execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean),
);

/** The only two reasons a row may carry no source link. */
const UNLINKED = /^(external|not in this repo) \(.+\)$/;

/** Our own live contracts whose deployed source the repo does not hold. */
const NOT_IN_REPO: Array<[string, string]> = [
  ['TOWELI Token', TOWELI_ADDRESS],
  ['Tegridy Fee Hook (V4)', TEGRIDY_FEE_HOOK_ADDRESS],
];

function sourceLinks(container: Element): { href: string; path: string }[] {
  const prefix = `${GITHUB_BLOB_BASE}/`;
  return [...container.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href')!)
    .filter((href) => href.startsWith(prefix))
    .map((href) => ({ href, path: decodeURIComponent(href.slice(prefix.length)) }));
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-record="contracts"] div.grid')];
}

function plainSource(row: Element): string | undefined {
  return [...row.querySelectorAll('div')].map((d) => d.textContent ?? '').find((t) => UNLINKED.test(t));
}

function rowOf(container: HTMLElement, label: string): HTMLElement {
  const span = [...container.querySelectorAll('span')].find((s) => s.textContent === label);
  expect(span, `no row labelled ${label}`).toBeTruthy();
  return span!.closest('div.grid') as HTMLElement;
}

function leadSentences(container: HTMLElement): string[] {
  const lead = container.querySelector('header p')!.textContent!.replace(/\s+/g, ' ').trim();
  return lead.split(/(?<=[.;])\s+/);
}

describe('/contracts source links', () => {
  it('reads a case-exact tracked list, so a wrong-case path cannot pass', () => {
    expect(TRACKED.size).toBeGreaterThan(100);
    expect(TRACKED.has('contracts/src/TegridyStaking.sol')).toBe(true);
    expect(TRACKED.has('contracts/src/tegridystaking.sol')).toBe(false);
  });

  it('links every source to a file the repo tracks', () => {
    const { container } = render(<ContractsPage />);
    const record = container.querySelector('[data-record="contracts"]')!;
    const links = sourceLinks(record);
    // A page that rendered no links would pass vacuously.
    expect(links.length).toBeGreaterThan(20);
    const broken = links.filter((l) => !TRACKED.has(l.path)).map((l) => l.path);
    expect(broken, `source links that 404 on GitHub:\n${broken.join('\n')}`).toEqual([]);
  });

  it('gives every row either one source link or a stated reason it has none', () => {
    const { container } = render(<ContractsPage />);
    const all = rows(container);
    expect(all.length).toBeGreaterThan(20);
    const silent = all
      .filter((row) => {
        const n = sourceLinks(row).length;
        return n > 1 || (n === 0 && plainSource(row) === undefined);
      })
      .map((row) => row.querySelector('span')?.textContent);
    expect(silent, `rows with no source link and no stated reason:\n${silent.join('\n')}`).toEqual([]);
  });

  it.each(NOT_IN_REPO)('does not link the live %s row to a repo file', (label) => {
    const { container } = render(<ContractsPage />);
    const row = rowOf(container, label);
    expect(sourceLinks(row)).toEqual([]);
    expect(plainSource(row)).toMatch(/^not in this repo \(/);
  });

  it.each(NOT_IN_REPO)('still asks Etherscan about the live %s', (_label, address) => {
    queried.length = 0;
    render(<ContractsPage />);
    expect(queried.flat().map((a) => a.toLowerCase())).toContain(address.toLowerCase());
  });

  it('does not promise a source link for every contract while a row has none', () => {
    const { container } = render(<ContractsPage />);
    const ownUnlinked = rows(container).filter((r) => plainSource(r)?.startsWith('not in this repo ('));
    expect(ownUnlinked.length).toBeGreaterThan(0);
    const universal = leadSentences(container).filter(
      (s) => /\blinked\b/i.test(s) && /\b(every|each|all)\b/i.test(s),
    );
    expect(universal).toEqual([]);
  });

  it('says a link to a branch can be newer than the deployed code', () => {
    // A link pinned to a commit is the file as deployed; a branch link is the file today.
    if (/\/blob\/[0-9a-f]{40}$/.test(GITHUB_BLOB_BASE)) return;
    const { container } = render(<ContractsPage />);
    const disclosed = leadSentences(container).some(
      (s) => /\b(newer|differ|ahead)\b/i.test(s) && /\bdeployed\b/i.test(s),
    );
    expect(disclosed, `lead: ${leadSentences(container).join(' ')}`).toBe(true);
  });
});
