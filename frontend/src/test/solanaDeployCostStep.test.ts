// The launch-curve job prints what deploying tegridy-launch would lock up in rent, the figure
// an operator funds a deployer with. Until 2026-10-14 it priced that at a rate written into
// the workflow (6960.89 lamports a byte) weeks after mainnet's rent fell to 5,080 a byte, so
// every figure it printed was about 37% high. The step asks mainnet for each figure, names the
// rate and slot it read, and says so when it could not read them.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STEP = '- name: Report measured deploy cost';

/** The step's text, from its name to the next step, with shell and YAML comments removed. */
function stepCode(): string {
  const yml = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'solana-ci.yml'), 'utf-8');
  const start = yml.indexOf(STEP);
  expect(start, `solana-ci.yml has no "${STEP}" step`).toBeGreaterThan(-1);
  const next = yml.indexOf('\n      - name:', start + STEP.length);
  return yml
    .slice(start, next === -1 ? undefined : next)
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

describe('the measured deploy cost is priced by mainnet on the day', () => {
  it('asks mainnet for the rent of each account it prices', () => {
    const code = stepCode();
    expect(code).toContain('getMinimumBalanceForRentExemption');
    expect(code).toContain('https://api.mainnet-beta.solana.com');
  });

  it('carries no lamports-a-byte rate of its own', () => {
    const code = stepCode();
    expect(code).not.toMatch(/\brate\s*=\s*\d/);
    expect(code).not.toMatch(/\b(6960|5080)(\.\d+)?\b/);
  });

  it('names the rate and slot it read, and prints no SOL figure when it could not read them', () => {
    const code = stepCode();
    expect(code).toMatch(/Rent read from mainnet at slot/);
    expect(code).toMatch(/could not be read[^\n]*no SOL figure/);
  });
});
