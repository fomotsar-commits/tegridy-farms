// @vitest-environment node
//
// Where the $BAYLA plant (island answer 16) meets liquidity (LP stage 2). The plant's
// two Token-2022 instructions are a create's alone: no liquidity kind may carry either
// one, in the transaction we build or in the one a wallet hands back. Both sides' own
// tests stay in intent.test.ts (the plant) and intentPool.test.ts (liquidity).
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { deriveLpMint, deriveObservation, deriveVault, sortMints } from '../../../solana/cpswap/program';
import { PROGRAMS_BY_KIND, decodeIntent } from './intent';
import { LP_KINDS } from './lpKinds';
import { plantInstructions } from './plant';
import { AMM_CONFIG, CPSWAP, cfgLocal } from './testkit.fixture';
import type { LpKind, PoolPins } from './types';

const ME = Keypair.generate().publicKey;

function pins(): PoolPins {
  const address = Keypair.generate().publicKey;
  const tokenMint = Keypair.generate().publicKey;
  const { token0, token1 } = sortMints(WSOL_MINT, tokenMint);
  const lpMint = deriveLpMint(CPSWAP, address);
  return {
    address,
    ammConfig: AMM_CONFIG,
    origin: 'standard',
    token0Mint: token0,
    token1Mint: token1,
    token0Program: TOKEN_PROGRAM_ID,
    token1Program: TOKEN_PROGRAM_ID,
    vault0: deriveVault(CPSWAP, address, token0),
    vault1: deriveVault(CPSWAP, address, token1),
    lpMint,
    observation: deriveObservation(CPSWAP, address),
    tokenMint,
    tokenProgram: TOKEN_PROGRAM_ID,
    solIsToken0: token0.equals(WSOL_MINT),
    lpAccount: associatedTokenAddress(lpMint, ME, TOKEN_PROGRAM_ID),
  };
}

describe('the plant is a create’s alone', () => {
  it('no liquidity kind lists Token-2022 among its programs', () => {
    for (const kind of Object.keys(LP_KINDS) as LpKind[]) expect(PROGRAMS_BY_KIND[kind].has('t22')).toBe(false);
  });

  it('every liquidity kind refuses the plant’s burn and its Workshop transfer, even from a wallet', () => {
    for (const kind of Object.keys(LP_KINDS) as LpKind[]) {
      for (const ix of plantInstructions(ME)) {
        for (const opts of [{}, { allowWalletGuards: true }]) {
          const r = decodeIntent([ix], { kind, signer: ME, cfg: cfgLocal, maxPriorityLamports: 1_000_000n, pins: pins() }, opts);
          expect(r.ok).toBe(false);
          expect(!r.ok && r.reason).toMatch(/a program this page never uses \(TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb\)/);
        }
      }
    }
  });
});
