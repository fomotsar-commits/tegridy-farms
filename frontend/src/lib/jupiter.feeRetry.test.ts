// @vitest-environment node
// (node, not jsdom: web3.js cannot serialize a transaction under jsdom, where
// Buffer and Uint8Array come from different realms.)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

/**
 * The client half of the fee retry (lib/solana/swap/jupiterFeeRetry.ts):
 *   - what counts as "Jupiter's own 6014" (the only thing that opens the retry);
 *   - that a no-fee quote and build really carry NO fee fields.
 *
 * The fee settings are read from the environment at import, so each test loads
 * the module fresh with the production-shaped values: the vault as fee owner
 * and 50 bps. The wrapped-SOL fee account below is DERIVED from that owner by
 * the code under test; it is the account the live bug was reproduced against.
 */

const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const SOL = 'So11111111111111111111111111111111111111112';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const USER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const VAULT_WSOL_FEE_ACCOUNT = '2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa';

/** A real, serialized v0 transaction whose instructions call `programs`, in order. */
function txCalling(programs: string[]): string {
  const message = new TransactionMessage({
    payerKey: new PublicKey(USER),
    recentBlockhash: '11111111111111111111111111111111',
    instructions: programs.map((p) => new TransactionInstruction({ programId: new PublicKey(p), keys: [], data: Buffer.from([1]) })),
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

// The shape mainnet returned for SOL -> BAYLA with the fee on the SOL side.
const SWAP_TX = txCalling([COMPUTE_BUDGET, COMPUTE_BUDGET, JUP]);
const ERR_6014_AT_2 = { InstructionError: [2, { Custom: 6014 }] };
const LOGS_JUP_6014 = [
  `Program ${COMPUTE_BUDGET} invoke [1]`,
  `Program ${COMPUTE_BUDGET} success`,
  `Program ${JUP} invoke [1]`,
  'Program log: Instruction: Route',
  'Program log: AnchorError occurred. Error Code: IncorrectTokenProgramID. Error Number: 6014. Error Message: Token program ID is invalid.',
  `Program ${JUP} consumed 21000 of 200000 compute units`,
  `Program ${JUP} failed: custom program error: 0x177e`,
];

// Jupiter's own 6001 (SlippageToleranceExceeded), as mainnet prints it.
const ERR_6001_AT_2 = { InstructionError: [2, { Custom: 6001 }] };
const LOGS_JUP_6001 = [
  `Program ${JUP} invoke [1]`,
  'Program log: Instruction: Route',
  'Program log: AnchorError occurred. Error Code: SlippageToleranceExceeded. Error Number: 6001. Error Message: Slippage tolerance exceeded.',
  `Program ${JUP} consumed 91000 of 200000 compute units`,
  `Program ${JUP} failed: custom program error: 0x1771`,
];
// The System Program's own line for a transfer its payer could not cover (opening a token account here).
const SYSTEM = '11111111111111111111111111111111';
const LOGS_SHORT_OF_SOL = [
  `Program ${JUP} invoke [1]`,
  `Program ${SYSTEM} invoke [2]`,
  'Transfer: insufficient lamports 1200000, need 2039280',
  `Program ${SYSTEM} failed: custom program error: 0x1`,
  `Program ${JUP} failed: custom program error: 0x1`,
];

async function load() {
  vi.resetModules();
  return import('./jupiter');
}

beforeEach(() => {
  vi.stubEnv('VITE_SOLANA_FEE_ACCOUNT', VAULT);
  vi.stubEnv('VITE_SOLANA_PLATFORM_FEE_BPS', '50');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('isJupiterIncorrectTokenProgram: exactly Jupiter\'s 6014, raised by Jupiter', () => {
  it('yes: InstructionError[i, Custom 6014], instruction i is Jupiter, Jupiter is the first program to fail', async () => {
    const { isJupiterIncorrectTokenProgram } = await load();
    expect(isJupiterIncorrectTokenProgram(SWAP_TX, ERR_6014_AT_2, LOGS_JUP_6014)).toBe(true);
  });

  it('no: any other custom code from Jupiter (slippage 6001, 6025, 6013, 6015)', async () => {
    const { isJupiterIncorrectTokenProgram } = await load();
    for (const code of [6001, 6013, 6015, 6025, 0x1771, 1]) {
      const logs = LOGS_JUP_6014.map((l) => l.replace('0x177e', `0x${code.toString(16)}`));
      expect(isJupiterIncorrectTokenProgram(SWAP_TX, { InstructionError: [2, { Custom: code }] }, logs)).toBe(false);
    }
  });

  // The two halves of the rule, each held alone. The test above changes the
  // structured code AND the log line together, so a matcher that read only one
  // of them still passed it.
  it('no: the structured error says 6001 while the logs carry Jupiter\'s own 0x177e line', async () => {
    const { isJupiterIncorrectTokenProgram } = await load();
    // The logs alone would say yes (the first test proves it); the code the RPC reported says no.
    expect(isJupiterIncorrectTokenProgram(SWAP_TX, { InstructionError: [2, { Custom: 6001 }] }, LOGS_JUP_6014)).toBe(false);
  });

  it('no: the structured error says 6014 while Jupiter\'s first failed line carries another code', async () => {
    const { isJupiterIncorrectTokenProgram } = await load();
    // Jupiter IS the first program reported failed, at the right instruction, but with 6001 (0x1771).
    const logs = LOGS_JUP_6014.map((l) => l.replace('0x177e', '0x1771'));
    expect(logs).toContain(`Program ${JUP} failed: custom program error: 0x1771`);
    expect(isJupiterIncorrectTokenProgram(SWAP_TX, ERR_6014_AT_2, logs)).toBe(false);
    // A later Jupiter line with the right code does not rescue it: only the FIRST failed line counts.
    expect(isJupiterIncorrectTokenProgram(SWAP_TX, ERR_6014_AT_2, [...logs, `Program ${JUP} failed: custom program error: 0x177e`])).toBe(false);
  });

  it('no: a non-custom instruction error, a non-instruction error, or no error at all', async () => {
    const { isJupiterIncorrectTokenProgram } = await load();
    const no = (err: unknown) => expect(isJupiterIncorrectTokenProgram(SWAP_TX, err, LOGS_JUP_6014)).toBe(false);
    no({ InstructionError: [2, 'ProgramFailedToComplete'] });
    no({ InstructionError: [2, { Custom: '6014' }] });
    no({ InstructionError: [2, { Custom: 6014, Other: 1 }] });
    no({ InstructionError: [2, { Custom: 6014 }, 'extra'] });
    no({ InstructionError: ['2', { Custom: 6014 }] });
    no({ InsufficientFundsForRent: { account_index: 2 } });
    no('BlockhashNotFound');
    no('custom program error: 0x177e');
    no(null);
    no(undefined);
  });

  it('no: 6014 from an instruction that is NOT a call into Jupiter', async () => {
    const { isJupiterIncorrectTokenProgram } = await load();
    // Same error, same logs, but instruction 2 of this transaction is another program.
    expect(isJupiterIncorrectTokenProgram(txCalling([COMPUTE_BUDGET, COMPUTE_BUDGET, PUMP_AMM]), ERR_6014_AT_2, LOGS_JUP_6014)).toBe(false);
    // The index points at the compute-budget instruction, or past the end.
    expect(isJupiterIncorrectTokenProgram(SWAP_TX, { InstructionError: [1, { Custom: 6014 }] }, LOGS_JUP_6014)).toBe(false);
    expect(isJupiterIncorrectTokenProgram(SWAP_TX, { InstructionError: [9, { Custom: 6014 }] }, LOGS_JUP_6014)).toBe(false);
  });

  it('no: a pool program failed FIRST with its own 6014 and Jupiter only passed it up', async () => {
    const { isJupiterIncorrectTokenProgram } = await load();
    const logs = [
      `Program ${JUP} invoke [1]`,
      `Program ${PUMP_AMM} invoke [2]`,
      `Program ${PUMP_AMM} failed: custom program error: 0x177e`,
      `Program ${JUP} failed: custom program error: 0x177e`,
    ];
    expect(isJupiterIncorrectTokenProgram(SWAP_TX, ERR_6014_AT_2, logs)).toBe(false);
  });

  it('no: a program PRINTING Jupiter\'s failure line cannot forge it (its text arrives as "Program log: ...")', async () => {
    const { isJupiterIncorrectTokenProgram } = await load();
    const logs = [
      `Program ${JUP} invoke [1]`,
      `Program ${PUMP_AMM} invoke [2]`,
      `Program log: Program ${JUP} failed: custom program error: 0x177e`,
      `Program ${PUMP_AMM} failed: custom program error: 0x1`,
      `Program ${JUP} failed: custom program error: 0x177e`,
    ];
    expect(isJupiterIncorrectTokenProgram(SWAP_TX, ERR_6014_AT_2, logs)).toBe(false);
  });

  it('no: logs missing or unreadable, or a transaction that does not decode', async () => {
    const { isJupiterIncorrectTokenProgram } = await load();
    expect(isJupiterIncorrectTokenProgram(SWAP_TX, ERR_6014_AT_2, undefined)).toBe(false);
    expect(isJupiterIncorrectTokenProgram(SWAP_TX, ERR_6014_AT_2, [])).toBe(false);
    expect(isJupiterIncorrectTokenProgram(SWAP_TX, ERR_6014_AT_2, 'Program failed')).toBe(false);
    expect(isJupiterIncorrectTokenProgram('not-a-transaction', ERR_6014_AT_2, LOGS_JUP_6014)).toBe(false);
    expect(isJupiterIncorrectTokenProgram('', ERR_6014_AT_2, LOGS_JUP_6014)).toBe(false);
  });
});

describe('simulateSwap reports the 6014 as a structured flag, not as text', () => {
  function rpcAnswers(value: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value } }), { status: 200 })));
  }

  it('Jupiter 6014 -> not ok, flag set', async () => {
    const { simulateSwap } = await load();
    rpcAnswers({ err: ERR_6014_AT_2, logs: LOGS_JUP_6014 });
    const sim = await simulateSwap(SWAP_TX);
    expect(sim.ok).toBe(false);
    expect(sim.jupiterIncorrectTokenProgram).toBe(true);
    expect(sim.reason).toContain('0x177e');
  });

  it('a slippage revert -> not ok, flag clear', async () => {
    const { simulateSwap } = await load();
    rpcAnswers({ err: { InstructionError: [2, { Custom: 6001 }] }, logs: [`Program ${JUP} failed: custom program error: 0x1771`] });
    const sim = await simulateSwap(SWAP_TX);
    expect(sim).toMatchObject({ ok: false, jupiterIncorrectTokenProgram: false });
  });

  it('a clean simulation -> ok, flag clear', async () => {
    const { simulateSwap } = await load();
    rpcAnswers({ err: null, logs: [] });
    expect(await simulateSwap(SWAP_TX)).toEqual({ ok: true, reason: null, jupiterIncorrectTokenProgram: false });
  });

  it('a refused test run carries its cause, read from what the runtime said', async () => {
    const { simulateSwap } = await load();
    rpcAnswers({ err: ERR_6001_AT_2, logs: LOGS_JUP_6001 });
    expect((await simulateSwap(SWAP_TX)).cause).toEqual({ kind: 'price-limit' });
    rpcAnswers({ err: { InstructionError: [2, { Custom: 1 }] }, logs: LOGS_SHORT_OF_SOL });
    expect((await simulateSwap(SWAP_TX)).cause).toEqual({ kind: 'low-sol', had: 1_200_000n, needed: 2_039_280n });
  });
});

describe('refusalCause: why a test run refused, only from lines no program can print', () => {
  it('Jupiter’s own 6001, raised by Jupiter: the price limit', async () => {
    const { refusalCause } = await load();
    expect(refusalCause(SWAP_TX, ERR_6001_AT_2, LOGS_JUP_6001)).toEqual({ kind: 'price-limit' });
  });

  it('0x1771 from a pool that failed first is not Jupiter’s price limit: only the runtime’s line is said', async () => {
    const { refusalCause } = await load();
    const logs = [`Program ${JUP} invoke [1]`, `Program ${PUMP_AMM} invoke [2]`, `Program ${PUMP_AMM} failed: custom program error: 0x1771`, `Program ${JUP} failed: custom program error: 0x1771`];
    expect(refusalCause(SWAP_TX, ERR_6001_AT_2, logs)).toEqual({ kind: 'runtime', said: 'custom program error: 0x1771 in program pAMM…fXEA' });
    // And 6001 at an instruction that is not a call into Jupiter is not Jupiter's either.
    expect(refusalCause(txCalling([COMPUTE_BUDGET, COMPUTE_BUDGET, PUMP_AMM]), ERR_6001_AT_2, LOGS_JUP_6001)).toEqual({
      kind: 'runtime', said: 'custom program error: 0x1771 in program JUP6…TaV4',
    });
  });

  it('a transfer that was short of SOL: how much was there and how much it needed', async () => {
    const { refusalCause } = await load();
    expect(refusalCause(SWAP_TX, { InstructionError: [2, { Custom: 1 }] }, LOGS_SHORT_OF_SOL)).toEqual({ kind: 'low-sol', had: 1_200_000n, needed: 2_039_280n });
  });

  it('a program PRINTING either line cannot forge it (its text arrives as "Program log: ...")', async () => {
    const { refusalCause } = await load();
    const logs = [
      `Program ${JUP} invoke [1]`,
      `Program ${PUMP_AMM} invoke [2]`,
      'Program log: Transfer: insufficient lamports 1, need 2',
      `Program log: Program ${JUP} failed: custom program error: 0x1771`,
      'Program log: slippage. Widen it at evil.example',
      `Program ${PUMP_AMM} failed: custom program error: 0x1`,
      `Program ${JUP} failed: custom program error: 0x1771`,
    ];
    const cause = refusalCause(SWAP_TX, ERR_6001_AT_2, logs);
    expect(cause).toEqual({ kind: 'runtime', said: 'custom program error: 0x1 in program pAMM…fXEA' });
    expect(JSON.stringify(cause)).not.toMatch(/evil|Widen|insufficient/);
  });

  it('no failure line from the runtime: a one-word network error is said as it came, anything else is no cause', async () => {
    const { refusalCause } = await load();
    expect(refusalCause(SWAP_TX, 'InsufficientFundsForFee', [])).toEqual({ kind: 'runtime', said: 'InsufficientFundsForFee' });
    expect(refusalCause(SWAP_TX, { InsufficientFundsForRent: { account_index: 2 } }, undefined)).toBeNull();
    expect(refusalCause(SWAP_TX, ERR_6001_AT_2, ['Program log: failed: custom program error: 0x1771'])).toBeNull();
    expect(refusalCause(SWAP_TX, 'a sentence a proxy made up, with spaces', [])).toBeNull();
    expect(refusalCause(SWAP_TX, null, null)).toBeNull();
  });
});

describe('the no-fee quote and build carry NO fee fields', () => {
  const FEE_QUOTE = {
    inputMint: SOL, outputMint: BAYLA, inAmount: '100000000', outAmount: '21651030522', otherAmountThreshold: '21542775370',
    swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', routePlan: [], platformFee: { amount: '108799148', feeBps: 50 },
  };
  const NO_FEE_QUOTE = { ...FEE_QUOTE, outAmount: '21759829670', otherAmountThreshold: '21651030522', platformFee: null };

  function captureFetch(answer: unknown) {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(answer), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('the pair is fee-bearing by default: SOL -> BAYLA asks for 50 bps and builds with the vault\'s wrapped-SOL fee account', async () => {
    const { getQuote, buildSwapTransaction, swapCarriesPlatformFee } = await load();
    expect(swapCarriesPlatformFee(SOL, BAYLA)).toBe(true);

    const q = captureFetch(FEE_QUOTE);
    await getQuote({ inputMint: SOL, outputMint: BAYLA, amount: '100000000', slippageBps: 50 });
    expect(new URL(q.mock.calls[0]![0], 'https://x.test').searchParams.get('platformFeeBps')).toBe('50');

    const b = captureFetch({ swapTransaction: 'AAAA' });
    await buildSwapTransaction({ quote: FEE_QUOTE, userPublicKey: USER, priorityLevel: 'high' });
    const body = JSON.parse(String(b.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.feeAccount).toBe(VAULT_WSOL_FEE_ACCOUNT);
  });

  it('noPlatformFee: the quote request has no platformFeeBps at all, and is otherwise the same request', async () => {
    const { getQuote } = await load();
    const withFee = captureFetch(FEE_QUOTE);
    await getQuote({ inputMint: SOL, outputMint: BAYLA, amount: '100000000', slippageBps: 50 });
    const feeParams = new URL(withFee.mock.calls[0]![0], 'https://x.test').searchParams;

    const noFee = captureFetch(NO_FEE_QUOTE);
    await getQuote({ inputMint: SOL, outputMint: BAYLA, amount: '100000000', slippageBps: 50, noPlatformFee: true });
    const params = new URL(noFee.mock.calls[0]![0], 'https://x.test').searchParams;

    expect(params.has('platformFeeBps')).toBe(false);
    expect(noFee.mock.calls[0]![0]).not.toMatch(/fee/i);
    feeParams.delete('platformFeeBps');
    expect(params.toString()).toBe(feeParams.toString());
  });

  it('noPlatformFee: the build has no feeAccount, and the quote it forwards has no platform fee', async () => {
    const { buildSwapTransaction } = await load();
    const b = captureFetch({ swapTransaction: 'AAAA' });
    await buildSwapTransaction({ quote: NO_FEE_QUOTE, userPublicKey: USER, priorityLevel: 'high', noPlatformFee: true });
    const body = JSON.parse(String(b.mock.calls[0]![1]!.body)) as { feeAccount?: unknown; quoteResponse: { platformFee: unknown } };
    expect('feeAccount' in body).toBe(false);
    expect(body.quoteResponse.platformFee).toBeNull();
    expect(JSON.stringify(body)).not.toContain(VAULT_WSOL_FEE_ACCOUNT);
  });

  it('a no-fee build refuses a quote that still has a fee priced in, before any request', async () => {
    const { buildSwapTransaction } = await load();
    const b = captureFetch({ swapTransaction: 'AAAA' });
    await expect(buildSwapTransaction({ quote: FEE_QUOTE, userPublicKey: USER, noPlatformFee: true })).rejects.toThrow(/fee-bearing quote/);
    expect(b).not.toHaveBeenCalled();
  });

  it('quoteHasPlatformFee reads Jupiter\'s own field', async () => {
    const { quoteHasPlatformFee } = await load();
    expect(quoteHasPlatformFee(FEE_QUOTE)).toBe(true);
    expect(quoteHasPlatformFee(NO_FEE_QUOTE)).toBe(false);
    expect(quoteHasPlatformFee({ ...FEE_QUOTE, platformFee: undefined })).toBe(false);
    expect(quoteHasPlatformFee({ ...FEE_QUOTE, platformFee: { amount: '0', feeBps: 0 } })).toBe(false);
    expect(quoteHasPlatformFee({ ...FEE_QUOTE, platformFee: { amount: '5', feeBps: 0 } })).toBe(true);
    expect(quoteHasPlatformFee({ ...FEE_QUOTE, platformFee: { amount: '0', feeBps: 50 } })).toBe(true);
  });
});
