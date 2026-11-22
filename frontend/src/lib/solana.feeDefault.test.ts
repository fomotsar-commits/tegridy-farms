// The Solana fee rate has no default: unset or unreadable is 0, no fee, never the old
// guessed 1% (leak audit 2026-11-15, LC-4). The live rate is 50, from the build setting.
import { afterEach, describe, expect, it, vi } from 'vitest';

const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';

async function solanaWith(bps: string) {
  vi.resetModules();
  vi.stubEnv('VITE_SOLANA_FEE_ACCOUNT', VAULT);
  vi.stubEnv('VITE_SOLANA_PLATFORM_FEE_BPS', bps);
  return import('./solana');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SOLANA_PLATFORM_FEE_BPS', () => {
  it('is 50 when the setting says 50', async () => {
    const s = await solanaWith('50');
    expect(s.SOLANA_PLATFORM_FEE_BPS).toBe(50);
    expect(s.isSolanaFeeConfigured()).toBe(true);
  });

  it.each(['', '   ', 'fifty', '-5', '2000'])('is 0, and no fee is taken, when the setting is %j', async (raw) => {
    const s = await solanaWith(raw);
    expect(s.SOLANA_PLATFORM_FEE_BPS).toBe(0);
    expect(s.isSolanaFeeConfigured()).toBe(false);
  });
});
