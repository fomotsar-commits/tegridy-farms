// @vitest-environment node
//
// A production build stops unless the Solana fee owner it inlines is the registry's
// squads-vault and the rate is 50 bps (leak audit 2026-11-15, LC-4). The last block resolves
// vite.config.ts as `vite build` does, so it fails if the plugin is ever unhooked.
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkSolanaFeeSettings, registryVault } from './solanaFeeGuardPlugin';
import { solanaFeeSettingProblems } from './src/lib/solanaFeeEnv';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
// The fee owner before the vault (registry row swap-fee-account): a real, wrong owner.
const OLD_FEE_WALLET = 'DVGiHe98CzEf7VuCS6YpVDFnp38ubJmKNLt6aMJwAyER';
const RIGHT = { VITE_SOLANA_FEE_ACCOUNT: VAULT, VITE_SOLANA_PLATFORM_FEE_BPS: '50' };

describe('solanaFeeSettingProblems', () => {
  it('passes the vault at 50 bps, as the site trims them', () => {
    expect(solanaFeeSettingProblems(RIGHT, VAULT)).toEqual([]);
    expect(solanaFeeSettingProblems({ VITE_SOLANA_FEE_ACCOUNT: ` ${VAULT}\n`, VITE_SOLANA_PLATFORM_FEE_BPS: ' 50 ' }, VAULT)).toEqual([]);
  });

  it.each([
    ['owner unset', { VITE_SOLANA_PLATFORM_FEE_BPS: '50' }, 'VITE_SOLANA_FEE_ACCOUNT is unset'],
    ['owner blank', { ...RIGHT, VITE_SOLANA_FEE_ACCOUNT: '  ' }, 'VITE_SOLANA_FEE_ACCOUNT is unset'],
    ['owner another wallet', { ...RIGHT, VITE_SOLANA_FEE_ACCOUNT: OLD_FEE_WALLET }, 'is not the Squads vault'],
    ['rate unset', { VITE_SOLANA_FEE_ACCOUNT: VAULT }, 'VITE_SOLANA_PLATFORM_FEE_BPS is unset'],
    ['rate 1%', { ...RIGHT, VITE_SOLANA_PLATFORM_FEE_BPS: '100' }, 'is not 50'],
    ['rate 0', { ...RIGHT, VITE_SOLANA_PLATFORM_FEE_BPS: '0' }, 'is not 50'],
    ['rate not a number', { ...RIGHT, VITE_SOLANA_PLATFORM_FEE_BPS: 'fifty' }, 'is not 50'],
  ])('refuses %s, and never prints the value', (_, env, said) => {
    const problems = solanaFeeSettingProblems(env, VAULT);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(said);
    expect(problems[0]).not.toContain(OLD_FEE_WALLET);
    expect(problems[0]).not.toContain('100');
    expect(problems[0]).not.toContain('fifty');
  });
});

describe('checkSolanaFeeSettings', () => {
  it('takes the vault from the registry row squads-vault', () => {
    expect(registryVault(ROOT)).toBe(VAULT);
  });

  it('refuses a production build with a wrong owner or no rate', () => {
    expect(() => checkSolanaFeeSettings({ ...RIGHT, VITE_SOLANA_FEE_ACCOUNT: OLD_FEE_WALLET }, 'production', ROOT)).toThrow(/production build is refused/);
    expect(() => checkSolanaFeeSettings({ VITE_SOLANA_FEE_ACCOUNT: VAULT }, 'production', ROOT)).toThrow(/VITE_SOLANA_PLATFORM_FEE_BPS is unset/);
  });

  it('lets a right production build through and says what it checked', () => {
    expect(checkSolanaFeeSettings(RIGHT, 'production', ROOT)).toContain(`fee owner is ${VAULT} and the rate is 50 bps`);
  });

  it('says it did not check a build that is not production', () => {
    expect(checkSolanaFeeSettings({}, 'preview', ROOT)).toContain('not a production build (VERCEL_ENV "preview"), fee settings not checked');
    expect(checkSolanaFeeSettings({}, undefined, ROOT)).toContain('VERCEL_ENV unset');
  });
});

describe('vite.config.ts runs the guard on a build', () => {
  const KEYS = ['VERCEL_ENV', 'VITE_SOLANA_FEE_ACCOUNT', 'VITE_SOLANA_PLATFORM_FEE_BPS'] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const resolveBuild = (env: Partial<Record<(typeof KEYS)[number], string>>) => {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    return resolveConfig({ root: ROOT, configFile: join(ROOT, 'vite.config.ts'), logLevel: 'silent' }, 'build', 'production');
  };

  it('a production build with the old fee wallet stops', async () => {
    await expect(resolveBuild({ VERCEL_ENV: 'production', VITE_SOLANA_FEE_ACCOUNT: OLD_FEE_WALLET, VITE_SOLANA_PLATFORM_FEE_BPS: '50' }))
      .rejects.toThrow(/solana-fee-guard: this production build is refused/);
  });

  it('a production build with no fee settings stops', async () => {
    await expect(resolveBuild({ VERCEL_ENV: 'production' })).rejects.toThrow(/VITE_SOLANA_FEE_ACCOUNT is unset/);
  });

  it('a production build with the vault at 50 bps resolves', async () => {
    const config = await resolveBuild({ VERCEL_ENV: 'production', ...RIGHT });
    expect(config.plugins.some((p) => p.name === 'solana-fee-guard')).toBe(true);
  });
});
