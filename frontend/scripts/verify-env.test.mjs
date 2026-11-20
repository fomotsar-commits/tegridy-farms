// @vitest-environment node
//
// scripts/verify-env.mjs run as a deploy check runs it, on an env file. Pinned here: a Solana
// fee owner other than the vault is reported as refused, without its value, and fails --strict,
// because the site then takes no fee (lib/solana.ts SOLANA_FEE_OWNER); the vault is reported as
// matching. Every other revenue gate is set, so the Solana owner alone decides --strict.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./verify-env.mjs', import.meta.url));
const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const OLD_FEE_WALLET = 'DVGiHe98CzEf7VuCS6YpVDFnp38ubJmKNLt6aMJwAyER';
const dir = mkdtempSync(join(tmpdir(), 'verify-env-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The script's output and exit code under --strict, with `solanaOwner` as the fee owner. */
let runs = 0;
function strictRun(solanaOwner) {
  // The script prints the file's path, so the path never carries the value.
  const file = join(dir, `deploy-${(runs += 1)}.env`);
  writeFileSync(file, [
    'VITE_SWAP_FEE_BPS=25',
    'VITE_SWAP_FEE_RECIPIENT=0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d',
    `VITE_SOLANA_FEE_ACCOUNT=${solanaOwner}`,
  ].join('\n'));
  // No VITE_ value is inherited from the shell that runs the tests: the file alone is the deploy.
  const env = { PATH: process.env.PATH ?? '', ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) };
  const r = spawnSync(process.execPath, [SCRIPT, '--strict', '--env-file', file], { encoding: 'utf8', env });
  return { out: `${r.stdout}${r.stderr}`, code: r.status };
}

describe('verify-env: the Solana fee owner must be the vault (XCHL-04)', () => {
  it('another owner is reported as refused, its value never printed, and fails --strict', () => {
    const { out, code } = strictRun(OLD_FEE_WALLET);
    expect(out).toContain('VITE_SOLANA_FEE_ACCOUNT (must be the vault)');
    expect(out).toContain('SET TO AN ADDRESS THE CODE REFUSES (value not printed).');
    expect(out).toContain(`The Solana swap fee is OFF until it is ${VAULT}.`);
    expect(out).not.toContain(OLD_FEE_WALLET);
    expect(code).toBe(1);
  });

  it('the vault is reported as matching, and passes --strict', () => {
    const { out, code } = strictRun(VAULT);
    expect(out).toContain('set, and matches the vault.');
    expect(out).not.toContain('THE CODE REFUSES');
    expect(code).toBe(0);
  });
});
