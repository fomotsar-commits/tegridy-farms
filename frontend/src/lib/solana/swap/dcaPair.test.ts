import { describe, it, expect } from 'vitest';
import { checkDcaPair, TOKEN_2022_PROGRAM } from './dcaPair';
import { BAYLA, LEGACY_TOKEN_PROGRAM, SOL, USDC } from '../../solanaTokenList';

// Jupiter's recurring program rejects a Token-2022 mint (error 3007). The check refuses one
// only on the chain's answer or Jupiter's own token record, and an answer it could not read
// is never "fine" and never a refusal (law 8).
const owners = (...o: (string | null)[]) => async () => o;

describe('checkDcaPair: which pairs a recurring order can take', () => {
  it('two plain SPL tokens: ok', async () => {
    expect(await checkDcaPair([SOL, USDC], owners(LEGACY_TOKEN_PROGRAM, LEGACY_TOKEN_PROGRAM))).toEqual({ kind: 'ok' });
  });

  it('a Token-2022 mint on either side is named', async () => {
    expect(await checkDcaPair([SOL, BAYLA], owners(LEGACY_TOKEN_PROGRAM, TOKEN_2022_PROGRAM))).toEqual({ kind: 'token-2022', symbol: 'BAYLA' });
    expect(await checkDcaPair([BAYLA, USDC], owners(TOKEN_2022_PROGRAM, LEGACY_TOKEN_PROGRAM))).toEqual({ kind: 'token-2022', symbol: 'BAYLA' });
  });

  it("Jupiter's own record says Token-2022: refused with no read", async () => {
    const read = async () => { throw new Error('not asked'); };
    expect(await checkDcaPair([SOL, { ...BAYLA, tokenProgram: TOKEN_2022_PROGRAM }], read)).toEqual({ kind: 'token-2022', symbol: 'BAYLA' });
  });

  it('a read that failed, a mint not found, or an owner that is no token program: unread, never ok and never a refusal', async () => {
    expect(await checkDcaPair([SOL, USDC], async () => { throw new Error('fetch failed: 503'); })).toEqual({ kind: 'unread' });
    expect(await checkDcaPair([SOL, USDC], owners(LEGACY_TOKEN_PROGRAM, null))).toEqual({ kind: 'unread' });
    expect(await checkDcaPair([SOL, USDC], owners(LEGACY_TOKEN_PROGRAM, '11111111111111111111111111111111'))).toEqual({ kind: 'unread' });
    expect(await checkDcaPair([SOL, USDC], owners(LEGACY_TOKEN_PROGRAM))).toEqual({ kind: 'unread' });
  });
});
