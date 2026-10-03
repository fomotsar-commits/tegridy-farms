// @vitest-environment node
//
// A liquidity transaction through the shared pipeline: the pool pins hold on the
// transaction the wallet hands back, and a failure is said in the liquidity kind's
// own words wherever the pipeline explains one (the test run, the first send, a
// landed refusal, and Check again). The launch-program kinds are pinned, unedited,
// in submit.test.ts and prepare.test.ts.
import { describe, it, expect } from 'vitest';
import { Keypair, Transaction, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { deriveLpMint, deriveObservation, deriveVault, sortMints } from '../../../solana/cpswap/program';
import { withdrawIx } from '../../../solana/cpswap/ix';
import { buildAndSimulate } from './prepare';
import { LIGHTHOUSE_PROGRAM_ID } from './intent';
import { recheckOutcome, submitPrepared } from './submit';
import { AMM_CONFIG, CPSWAP, FakeChain, cfgLocal } from './testkit.fixture';
import type { PoolIntent, PoolPins, PreparedTx, TxSigner, WriteRpc } from './types';

const W = (c: FakeChain) => c as unknown as WriteRpc;

const WALLET = Keypair.generate();
const ME = WALLET.publicKey;
const STRANGER = Keypair.generate().publicKey;
const CP = CPSWAP.toBase58();
const failed = (code: number) => `Program ${CP} failed: custom program error: 0x${code.toString(16)}`;
const WITHDRAW_OFF =
  "Withdrawals are switched off on this pool by the pool program's admin (the team's vault). Only the vault can switch them back on. Your pool shares are still in your wallet.";

function pinsFor(): PoolPins {
  const address = Keypair.generate().publicKey;
  const tokenMint = Keypair.generate().publicKey;
  const { token0, token1 } = sortMints(WSOL_MINT, tokenMint);
  const lpMint = deriveLpMint(CPSWAP, address);
  return {
    address, ammConfig: AMM_CONFIG, origin: 'standard',
    token0Mint: token0, token1Mint: token1, token0Program: TOKEN_PROGRAM_ID, token1Program: TOKEN_PROGRAM_ID,
    vault0: deriveVault(CPSWAP, address, token0), vault1: deriveVault(CPSWAP, address, token1),
    lpMint, observation: deriveObservation(CPSWAP, address),
    tokenMint, tokenProgram: TOKEN_PROGRAM_ID, quoteIsToken0: token0.equals(WSOL_MINT),
    lpAccount: associatedTokenAddress(lpMint, ME),
  };
}

function withdrawFor(p: PoolPins) {
  return withdrawIx({
    programId: CPSWAP, owner: ME, poolState: p.address, ownerLpToken: p.lpAccount,
    token0Account: associatedTokenAddress(p.token0Mint, ME), token1Account: associatedTokenAddress(p.token1Mint, ME),
    token0Vault: p.vault0, token1Vault: p.vault1, vault0Mint: p.token0Mint, vault1Mint: p.token1Mint, lpMint: p.lpMint,
    lpTokenAmount: 1_000n, minimumToken0Amount: 5n, minimumToken1Amount: 7n,
  });
}

async function preparedWithdraw(o: { failWith?: number; finalOnly?: boolean } = {}) {
  const chain = FakeChain.healthy();
  chain.fund(ME, 10_000_000_000);
  const pins = pinsFor();
  chain.simulate = (_v, config) =>
    o.failWith !== undefined && (!o.finalOnly || config?.accounts)
      ? { err: { InstructionError: [2, { Custom: o.failWith }] }, logs: [failed(o.failWith)], unitsConsumed: 40_000 }
      : {
          err: null,
          logs: [],
          unitsConsumed: 40_000,
          ...(config?.accounts ? { accounts: chain.post(config.accounts.addresses, {}) } : {}),
        };
  const intent: PoolIntent = { kind: 'lp-withdraw', signer: ME, cfg: cfgLocal, maxPriorityLamports: 1_000_000n, pins };
  const r = await buildAndSimulate(W(chain), {
    kind: 'lp-withdraw',
    body: [withdrawFor(pins)],
    extraSigners: [],
    intent,
    watch: { signer: ME, tokenAccounts: [] },
    expect: () => ({ maxSolOut: 0n, tokens: [] }),
    newAccountRent: () => 0n,
    summarize: (steps) =>
      steps.some((s) => s.kind === 'pool-withdraw')
        ? {
            kind: 'lp-withdraw', pool: pins.address, origin: 'standard', config: null, tokenMint: pins.tokenMint,
            tokenDecimals: 6, quoteIsToken0: pins.quoteIsToken0, lpAccount: pins.lpAccount, lpAmount: 1_000n, lpDecimals: 9,
            heldBefore: 1_000n, all: true, keep: 0n, quoted: { sol: 10n, token: 10n }, min: { sol: 5n, token: 7n },
            tokenAccount: associatedTokenAddress(pins.tokenMint, ME), tokenAccountRent: 0n, unwrapsWsol: true, notices: [],
          }
        : 'no withdrawal',
  });
  chain.calls = [];
  return { chain, r, pins };
}

const walletSigner = (edit?: (tx: Transaction) => Transaction): TxSigner => ({
  publicKey: ME,
  async signTransaction<T extends Transaction>(tx: T): Promise<T> {
    let copy = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    if (edit) copy = edit(copy);
    copy.partialSign(WALLET);
    return copy as T;
  },
});

const deps = { sleep: async () => {}, intervalMs: 1 };

const ready = async () => {
  const { chain, r, pins } = await preparedWithdraw();
  if (!r.ok) throw new Error(r.outcome.message);
  return { chain, p: r.prepared as PreparedTx, pins };
};

describe('a liquidity withdrawal through the shared pipeline', () => {
  it('prepares, and decodes into one pool-withdraw step', async () => {
    const { p } = await ready();
    expect(p.kind).toBe('lp-withdraw');
    expect(p.steps.filter((s) => s.kind === 'pool-withdraw')).toHaveLength(1);
  });

  it('a test run the pool refuses is said in the withdrawal’s words (buildAndSimulate passes the kind)', async () => {
    const { r } = await preparedWithdraw({ failWith: 6000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toMatchObject({ status: 'not-sent', stage: 'simulate', message: WITHDRAW_OFF });
  });

  it('so is a refusal on the second test run, of the final bytes', async () => {
    const { r } = await preparedWithdraw({ failWith: 6000, finalOnly: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toMatchObject({ status: 'not-sent', stage: 'simulate', message: WITHDRAW_OFF });
  });

  it('and so is a refusal of the version the wallet handed back', async () => {
    const { chain, p } = await ready();
    chain.simulate = () => ({ err: { InstructionError: [2, { Custom: 6000 }] }, logs: [failed(6000)], unitsConsumed: 1 });
    const guard = new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from([1]) });
    const o = await submitPrepared(W(chain), walletSigner((tx) => tx.add(guard)), p, deps);
    expect(o).toMatchObject({ status: 'not-sent', stage: 'sign' });
    if (o.status === 'not-sent') expect(o.message).toContain(WITHDRAW_OFF);
  });

  // withdraw.rs checks only the mint of the payout accounts; the pins are what stop
  // a wallet that rewrites one to a stranger's account after the review.
  it('a wallet that swaps payout slot 4 for a stranger’s account after signing: refused, nothing sent', async () => {
    const { chain, p, pins } = await ready();
    const strangerAta = associatedTokenAddress(pins.token0Mint, STRANGER);
    const o = await submitPrepared(
      W(chain),
      walletSigner((tx) => {
        const ix = tx.instructions.find((i) => i.programId.equals(CPSWAP))!;
        ix.keys[4] = { ...ix.keys[4]!, pubkey: strangerAta };
        return tx;
      }),
      p,
      deps,
    );
    expect(o).toMatchObject({ status: 'not-sent', stage: 'sign' });
    if (o.status === 'not-sent') expect(o.message).toMatch(/pays out to an account that is not yours/);
    expect(chain.calls).not.toContain('sendRawTransaction');
  });

  it('a first send the network turns away is said in the withdrawal’s words', async () => {
    const { chain, p } = await ready();
    chain.sendRawTransaction = async () => {
      throw Object.assign(new Error('Transaction simulation failed'), { logs: [failed(6000)] });
    };
    const o = await submitPrepared(W(chain), walletSigner(), p, deps);
    expect(o.status).toBe('not-sent');
    if (o.status === 'not-sent') expect(o.message).toContain(WITHDRAW_OFF);
  });

  it('a withdrawal that landed and was refused is said in the withdrawal’s words', async () => {
    const { chain, p } = await ready();
    chain.getSignatureStatuses = async () => ({ value: [{ err: { InstructionError: [2, { Custom: 6000 }] }, confirmationStatus: 'confirmed', slot: 9 }] });
    chain.getTransaction = async () => ({ meta: { logMessages: [failed(6000)] } });
    const o = await submitPrepared(W(chain), walletSigner(), p, deps);
    expect(o).toMatchObject({ status: 'reverted', program: 'cp-swap', code: 6000, message: WITHDRAW_OFF });
  });
});

describe('Check again on a liquidity withdrawal', () => {
  const sig = '5'.repeat(88);
  const reverted = (c: FakeChain) => {
    c.getTransaction = async () => ({ meta: { logMessages: [failed(6000)] } });
  };

  it('a refusal found on Check again carries the liquidity copy when the kind is passed (and the general one without it)', async () => {
    const c = new FakeChain();
    c.getSignatureStatuses = async () => ({ value: [{ err: { InstructionError: [2, { Custom: 6000 }] }, confirmationStatus: 'finalized', slot: 9 }] });
    reverted(c);
    expect(await recheckOutcome(W(c), sig, { cfg: cfgLocal, kind: 'lp-withdraw' })).toMatchObject({ status: 'reverted', message: WITHDRAW_OFF });
    expect(await recheckOutcome(W(c), sig, { cfg: cfgLocal })).toMatchObject({ status: 'reverted', message: expect.stringMatching(/not taking swaps/) });
  });

  it('past its window, a refusal found by the history read still carries the kind', async () => {
    const c = new FakeChain();
    let n = 0;
    // First read: no record. Past the height, the history read finds it refused.
    c.getSignatureStatuses = async () => ({
      context: { slot: FakeChain.FINALIZED_SLOT },
      value: [n++ === 0 ? null : { err: { InstructionError: [2, { Custom: 6000 }] }, confirmationStatus: 'finalized', slot: 9 }],
    });
    c.getBlockHeight = async () => 2_000;
    reverted(c);
    const o = await recheckOutcome(W(c), sig, { lastValidBlockHeight: 1_000, cfg: cfgLocal, kind: 'lp-withdraw' });
    expect(o).toMatchObject({ status: 'reverted', message: WITHDRAW_OFF });
  });
});
