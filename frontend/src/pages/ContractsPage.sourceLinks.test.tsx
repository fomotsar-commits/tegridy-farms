/**
 * /contracts links each row's source to GitHub. A link to a path the repo does not
 * track is a 404, and GitHub paths are case-sensitive, so the check reads
 * `git ls-files` rather than the filesystem (Windows would call TOWELI.sol present).
 * A live contract whose deployed source the repo does not hold gets no source link:
 * contracts/src/Toweli.sol exists but is not the bytecode at the TOWELI address.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GITHUB_BLOB_BASE, TOWELI_ADDRESS } from '../lib/constants';

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

function sourceLinks(container: HTMLElement): { href: string; path: string }[] {
  const prefix = `${GITHUB_BLOB_BASE}/`;
  return [...container.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href')!)
    .filter((href) => href.startsWith(prefix))
    .map((href) => ({ href, path: decodeURIComponent(href.slice(prefix.length)) }));
}

function rowOf(container: HTMLElement, label: string): HTMLElement {
  const span = [...container.querySelectorAll('span')].find((s) => s.textContent === label);
  expect(span, `no row labelled ${label}`).toBeTruthy();
  return span!.closest('div.grid') as HTMLElement;
}

describe('/contracts source links', () => {
  it('reads a case-exact tracked list, so a wrong-case path cannot pass', () => {
    expect(TRACKED.size).toBeGreaterThan(100);
    expect(TRACKED.has('contracts/src/TegridyStaking.sol')).toBe(true);
    expect(TRACKED.has('contracts/src/tegridystaking.sol')).toBe(false);
  });

  it('links every source to a file the repo tracks', () => {
    const { container } = render(<ContractsPage />);
    const links = sourceLinks(container);
    // One per repo-sourced row: a page that rendered no links would pass vacuously.
    expect(links.length).toBeGreaterThan(20);
    const broken = links.filter((l) => !TRACKED.has(l.path)).map((l) => l.path);
    expect(broken, `source links that 404 on GitHub:\n${broken.join('\n')}`).toEqual([]);
  });

  it('does not link the live TOWELI row to a repo file', () => {
    const { container } = render(<ContractsPage />);
    const row = rowOf(container, 'TOWELI Token');
    expect(sourceLinks(row)).toEqual([]);
  });

  it('still asks Etherscan about the live TOWELI', () => {
    queried.length = 0;
    render(<ContractsPage />);
    expect(queried.flat().map((a) => a.toLowerCase())).toContain(TOWELI_ADDRESS.toLowerCase());
  });
});
