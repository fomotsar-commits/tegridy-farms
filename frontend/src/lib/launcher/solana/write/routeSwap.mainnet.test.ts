// @vitest-environment node
//
// MAINNET DRY RUNS for the swap page's own-pool route (SPEC_S3 5.7: DR-1 and DR-2).
// Skipped unless SOLANA_MAINNET_DRYRUN=1, so CI shows it as skipped.
//
//   SOLANA_MAINNET_DRYRUN=1 npx vitest run src/lib/launcher/solana/write/routeSwap.mainnet.test.ts
//
// NOTHING IS SIGNED OR SENT. The builder is handed a wallet's PUBLIC key only;
// `buildAndSimulate` never signs, and its two simulations run with signature checks off.
// The connection this file hands the builder throws if anything tries to send.
//
// DR-2 runs the REAL `prepareRouteSwap` against Raydium's own CPMM program as the stand-in
// for our fork (the same code with other admin keys: the same 637-byte pool, the same
// seeds, fee tiers at index 0 and 1), before any pool of ours exists. A `Prepared` that is
// ok is therefore a dry run of the exact bytes under MAINNET'S token program and rent:
// the checker, both simulations and every balance row included. The local validator runs
// the old token program and the old rent, so this is the only place these are proven:
//   - the sync's re-price of a kept wrapped-SOL account's stored reserve (`syncCredit`);
//   - the site fee as one TransferChecked: the fee account gains exactly the fee;
//   - the rent band at mainnet's rent, for a classic and a Token-2022 (170-byte) account.
//
// DR-1 asks Jupiter for live quotes and runs the REAL `jupiterNet` on each: its number
// must be provable as "after our 0.5% fee" on the day, or our pools would never compete.
//
// Wallets are found at run time among each pool's recent traders (public data) and
// logged; none is typed here. More can be offered with SOLANA_MAINNET_DRYRUN_WALLETS
// (comma-separated public keys). The log is written to SOLANA_MAINNET_DRYRUN_OUT if set.
//
// A GREEN RUN MEANS ALL FOUR CASES RAN, on every pool: buy and sell, each from a wallet
// with no wrapped-SOL account and from one that keeps wrapped SOL, and the kept buy's
// sync credit was MORE THAN ZERO (an account set up under an older rent: the only place
// mainnet's re-price is proven). A case with no wallet is a RED run that names the case;
// supply a wallet with SOLANA_MAINNET_DRYRUN_WALLETS and run again. (Before the dark
// review, three of the four were skipped silently and the run still read green.)
//
// DR-3, THE FLIP GATE: the same matrix against one of OUR OWN pools. Set all three of
//   SOLANA_MAINNET_DRYRUN_PROGRAM  the pool program id (ours, on the flip day)
//   SOLANA_MAINNET_DRYRUN_POOL     the pool
//   SOLANA_MAINNET_DRYRUN_MINT     its token
// and the file runs against that pool instead of Raydium's two. For every case it then
// also takes a LIVE Jupiter quote for the same trade, proves its meaning (`jupiterNet`),
// probes whether Jupiter's own transaction carries the fee (`probeJupiterFee`, simulated
// with signature checks off), and hands the builder those real numbers with the amount
// the page would have shown: ours must be built exactly when it pays at least what
// Jupiter pays after the same fee, with a guaranteed amount within 2 units of Jupiter's
// own threshold (T-INV), and refused in the builder's own words otherwise.
//
// The four addresses typed below are public on-chain ids, listed in .gitleaks.toml.
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { PLATFORM_TREASURY_VAULT, PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { SOL_MINT, USDC_MINT } from '../../../solana';
import { COMPARABLE_PLATFORM_FEE_BPS, isJupiterIncorrectTokenProgram, jupiterNet, type JupiterQuote } from '../../../jupiter';
import { deriveAmmConfig, derivePool, sortMints } from '../../../solana/cpswap/program';
import { spendableSol } from '../../../solana/lp/liquidityMath';
import { probeJupiterFee, type JupiterFeeProof } from '../../../solana/swap/jupiterFeeProbe';
import { SITE_FEE_WSOL_ACCOUNT } from '../../../solana/swap/siteFeeAccount';
import { LP_FEE_RESERVE } from './liquidity';
import { bodySteps } from './prepare';
import { BAYLA_MINT } from './plant';
import { ROUTE_COPY, prepareRouteSwap, type RouteSwapArgs } from './routeSwap';
import type { CurveWriteConfig, LpOpenGate, Prepared, PreparedTx, RouteSwapSummary, WriteRpc } from './types';
import { syncCredit } from './wsol';

const ENABLED = process.env.SOLANA_MAINNET_DRYRUN === '1';
const RPC_URL = 'https://api.mainnet-beta.solana.com';
const JUPITER = 'https://lite-api.jup.ag/swap/v1';

/** Raydium's CPMM program: the code our pool program is a fork of. The stand-in for DR-2. */
const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
/** USELESS: a classic token whose USELESS/SOL pool sits at the standard address of Raydium's tier 0. */
const USELESS_MINT = new PublicKey('Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk');
/** ai16z: a Token-2022 token with a name and picture only, in a pool at a one-off address on tier 0. */
const AI16Z_MINT = new PublicKey('HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC');
const AI16Z_POOL = new PublicKey('7qAVrzrbULwg1B13YseqA95Uapf8EVp9jQE5uipqFMoP');

// DR-3: all three, or none. Half a target is a mistake, said before anything runs.
const DR3_ENV = {
  program: (process.env.SOLANA_MAINNET_DRYRUN_PROGRAM ?? '').trim(),
  pool: (process.env.SOLANA_MAINNET_DRYRUN_POOL ?? '').trim(),
  mint: (process.env.SOLANA_MAINNET_DRYRUN_MINT ?? '').trim(),
};
const DR3_SET = Object.values(DR3_ENV).filter((v) => v !== '').length;
if (ENABLED && DR3_SET !== 0 && DR3_SET !== 3) {
  throw new Error('DR-3 needs all three of SOLANA_MAINNET_DRYRUN_PROGRAM, SOLANA_MAINNET_DRYRUN_POOL and SOLANA_MAINNET_DRYRUN_MINT (or none, for DR-2).');
}
const DR3 = ENABLED && DR3_SET === 3;
/** The pool program the builder is pointed at: ours for DR-3, Raydium's identical one for DR-2. */
const POOL_PROGRAM = DR3 ? new PublicKey(DR3_ENV.program) : RAYDIUM_CPMM;

const cfg: CurveWriteConfig = { programId: PROGRAM_ID, cpSwapProgram: POOL_PROGRAM, cluster: 'mainnet' };
const GATE: LpOpenGate = { kind: 'open', cfg, mode: 'on' };
const ON = { routeMode: 'on' as const, feeEnv: { account: PLATFORM_TREASURY_VAULT.toBase58(), bps: 50 } };
const SLIP = 50n;

// ── a paced, retrying, read-only connection ──────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let queue: Promise<unknown> = Promise.resolve();
let rpcCalls = 0;

/** One call at a time, a pause between calls, and a 429 or a dropped connection retried with a growing wait (every call here is a read). */
function paced<T>(call: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        rpcCalls++;
        const r = await call();
        await sleep(450);
        return r;
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        if (attempt >= 8 || !/429|Too Many Requests|rate limit|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|50[234]/i.test(text)) throw e;
        await sleep(2_500 * (attempt + 1));
      }
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

function readOnly(conn: Connection): WriteRpc {
  const never = async (): Promise<never> => {
    throw new Error('a dry run never sends');
  };
  return {
    getLatestBlockhash: (...a: Parameters<Connection['getLatestBlockhash']>) => paced(() => conn.getLatestBlockhash(...a)),
    simulateTransaction: ((...a: unknown[]) => paced(() => (conn.simulateTransaction as (...x: unknown[]) => Promise<unknown>)(...a))) as Connection['simulateTransaction'],
    getRecentPrioritizationFees: (...a: Parameters<Connection['getRecentPrioritizationFees']>) => paced(() => conn.getRecentPrioritizationFees(...a)),
    getAccountInfo: (...a: Parameters<Connection['getAccountInfo']>) => paced(() => conn.getAccountInfo(...a)),
    getMinimumBalanceForRentExemption: (...a: Parameters<Connection['getMinimumBalanceForRentExemption']>) => paced(() => conn.getMinimumBalanceForRentExemption(...a)),
    getMultipleAccountsInfo: (...a: Parameters<Connection['getMultipleAccountsInfo']>) => paced(() => conn.getMultipleAccountsInfo(...a)),
    getBlockHeight: (...a: Parameters<Connection['getBlockHeight']>) => paced(() => conn.getBlockHeight(...a)),
    getSlot: (...a: Parameters<Connection['getSlot']>) => paced(() => conn.getSlot(...a)),
    sendRawTransaction: never,
    getSignatureStatuses: never,
    getTransaction: never,
  } as unknown as WriteRpc;
}

// ── the log ──────────────────────────────────────────────────────────────────

const log: Record<string, unknown> = { at: new Date().toISOString(), rpc: RPC_URL, feeAccount: SITE_FEE_WSOL_ACCOUNT.toBase58(), run: DR3 ? 'DR-3' : 'DR-2', poolProgram: POOL_PROGRAM.toBase58() };
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof PublicKey ? x.toBase58() : x)));

afterAll(() => {
  if (!ENABLED) return;
  log.rpcCalls = rpcCalls;
  const out = process.env.SOLANA_MAINNET_DRYRUN_OUT;
  if (out) writeFileSync(out, JSON.stringify(plain(log), null, 2));
});

// ── finding wallets among a pool's recent traders ────────────────────────────

interface Candidate {
  owner: PublicKey;
  lamports: bigint;
  tokens: bigint;
  hasTokenAccount: boolean;
  /** Its wrapped-SOL account, or null when it has none. */
  wsol: { amount: bigint; lamports: bigint; reserve: bigint | null; delegated: bigint; closeAuthority: boolean } | null;
}

const u64At = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);
const u32At = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(at, true);

async function look(conn: Connection, owners: PublicKey[], mint: PublicKey, tokenProgram: PublicKey): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (let i = 0; i < owners.length; i += 30) {
    const part = owners.slice(i, i + 30);
    const keys = part.flatMap((o) => [o, associatedTokenAddress(mint, o, tokenProgram), associatedTokenAddress(WSOL_MINT, o)]);
    const infos = await paced(() => conn.getMultipleAccountsInfo(keys, 'confirmed'));
    part.forEach((owner, n) => {
      const [wallet, tok, wsol] = [infos[3 * n], infos[3 * n + 1], infos[3 * n + 2]];
      // A plain wallet (the System program's, no data) with something to spend.
      if (!wallet || !wallet.owner.equals(PublicKey.default) || wallet.data.length !== 0 || wallet.lamports < 30_000_000) return;
      const tokOk = !!tok && tok.owner.equals(tokenProgram) && tok.data.length >= 165 && tok.data[108] === 1;
      const wsolOk = !!wsol && wsol.owner.equals(TOKEN_PROGRAM_ID) && wsol.data.length === 165 && wsol.data[108] === 1;
      if (wsol && !wsolOk) return;
      out.push({
        owner,
        lamports: BigInt(wallet.lamports),
        tokens: tokOk && tok ? u64At(tok.data, 64) : 0n,
        hasTokenAccount: tokOk,
        wsol:
          wsolOk && wsol
            ? {
                amount: u64At(wsol.data, 64),
                lamports: BigInt(wsol.lamports),
                reserve: u32At(wsol.data, 109) === 1 ? u64At(wsol.data, 113) : null,
                delegated: u32At(wsol.data, 72) === 1 ? u64At(wsol.data, 121) : 0n,
                closeAuthority: u32At(wsol.data, 129) === 1,
              }
            : null,
      });
    });
  }
  return out;
}

/** The fee payers of the pool's recent successful transactions, plus any wallets offered by env. */
async function traders(conn: Connection, pool: PublicKey, scan: number): Promise<PublicKey[]> {
  const seen = new Map<string, PublicKey>();
  for (const k of (process.env.SOLANA_MAINNET_DRYRUN_WALLETS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const key = new PublicKey(k);
    seen.set(key.toBase58(), key);
  }
  const sigs = await paced(() => conn.getSignaturesForAddress(pool, { limit: scan }, 'confirmed'));
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await paced(() => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })).catch(() => null);
    const payer = tx?.transaction.message.staticAccountKeys[0];
    if (payer) seen.set(payer.toBase58(), payer);
  }
  return [...seen.values()];
}

// ── one dry run ──────────────────────────────────────────────────────────────

const usable = (w: NonNullable<Candidate['wsol']>) => w.delegated === 0n && !w.closeAuthority;
const kept = (c: Candidate) => c.wsol !== null && c.wsol.amount > 0n && usable(c.wsol);
const closed = (c: Candidate) => c.wsol === null || (c.wsol.amount === 0n && usable(c.wsol));

interface Target {
  name: string;
  pool: PublicKey;
  mint: PublicKey;
  /** null: read from the mint's owner (DR-3, where the token is whatever the pool pairs). */
  tokenProgram: PublicKey | null;
}
type Resolved = Target & { tokenProgram: PublicKey };

// ── DR-3: Jupiter's live answer for the same trade ───────────────────────────

type LiveJupiter =
  | { kind: 'net'; net: bigint; threshold: string; fee: JupiterFeeProof; /** Why the probe did not say 'charged', in the build's or the simulation's own words. */ feeDetail: string | null }
  | { kind: 'no-route' }
  | { kind: 'unread'; detail: string };

/** The codes our proxy turns into "no route" (api/aggregator.js noRouteErrorCodes). Anything else is unread. */
const NO_ROUTE_CODES = ['TOKEN_NOT_TRADABLE', 'NO_ROUTES_FOUND', 'COULD_NOT_FIND_ANY_ROUTE'];

async function liveJupiter(conn: Connection, t: Resolved, owner: PublicKey, side: 'buy' | 'sell', amountIn: bigint): Promise<LiveJupiter> {
  const [inputMint, outputMint] = side === 'buy' ? [SOL_MINT, t.mint.toBase58()] : [t.mint.toBase58(), SOL_MINT];
  const amount = amountIn.toString();
  const qs = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: SLIP.toString(), swapMode: 'ExactIn', restrictIntermediateTokens: 'true', platformFeeBps: String(COMPARABLE_PLATFORM_FEE_BPS) });
  let res: Response | null = null;
  for (let i = 0; i < 5; i++) {
    res = await fetch(`${JUPITER}/quote?${qs}`, { headers: { Accept: 'application/json' } }).catch(() => null);
    if (res && res.status !== 429) break;
    await sleep(3_000 * (i + 1));
  }
  await sleep(900);
  if (!res) return { kind: 'unread', detail: 'Jupiter could not be reached' };
  const text = await res.text();
  if (res.status === 400) {
    let code: unknown = null;
    try {
      code = (JSON.parse(text) as { errorCode?: unknown } | null)?.errorCode;
    } catch {
      /* not JSON: unread below */
    }
    if (typeof code === 'string' && NO_ROUTE_CODES.includes(code)) return { kind: 'no-route' };
  }
  if (!res.ok) return { kind: 'unread', detail: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  let quote: JupiterQuote;
  try {
    quote = JSON.parse(text) as JupiterQuote;
  } catch {
    return { kind: 'unread', detail: 'the quote was not JSON' };
  }
  const net = jupiterNet({ kind: 'quote', quote, feeBpsSent: COMPARABLE_PLATFORM_FEE_BPS }, { inputMint, outputMint, amount });
  if (net === null) return { kind: 'unread', detail: 'the quote does not prove its amount is after our fee' };
  // Does Jupiter's OWN transaction for this quote carry the fee? The real probe, on the
  // fee-bearing build Jupiter returns, simulated with signature checks off.
  let feeDetail: string | null = null;
  const fee = await probeJupiterFee(
    {
      swapCarriesPlatformFee: () => true,
      buildSwapTransaction: async (p) => {
        const r = await fetch(`${JUPITER}/swap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ quoteResponse: p.quote, userPublicKey: p.userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, feeAccount: SITE_FEE_WSOL_ACCOUNT.toBase58() }),
        });
        await sleep(900);
        if (!r.ok) {
          feeDetail = `Jupiter could not build the swap (HTTP ${r.status}: ${(await r.text()).slice(0, 160)})`;
          throw new Error(feeDetail);
        }
        const j = (await r.json()) as { swapTransaction?: string; lastValidBlockHeight?: number };
        if (!j.swapTransaction) {
          feeDetail = 'Jupiter returned no transaction';
          throw new Error(feeDetail);
        }
        return { swapTransaction: j.swapTransaction, lastValidBlockHeight: j.lastValidBlockHeight ?? null };
      },
      simulateSwap: async (b64) => {
        // The same call lib/jupiter.ts simulateSwap makes: Jupiter's own bytes, as they came, never re-encoded here.
        let value: { err: unknown; logs?: string[] | null };
        try {
          const answer = await paced(async () => {
            const r = await fetch(RPC_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [b64, { encoding: 'base64', replaceRecentBlockhash: true, sigVerify: false, commitment: 'processed' }] }),
            });
            if (!r.ok) throw new Error(`the RPC answered ${r.status}`);
            return (await r.json()) as { result?: { value?: { err?: unknown; logs?: string[] | null } }; error?: { message?: string } };
          });
          if (!answer.result?.value) throw new Error(answer.error?.message ?? 'no simulation result');
          value = { err: answer.result.value.err ?? null, logs: answer.result.value.logs };
        } catch (e) {
          feeDetail = `its simulation could not be run: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
          throw e;
        }
        if (value.err === null) return { ok: true, reason: null, jupiterIncorrectTokenProgram: false };
        feeDetail = `its simulation failed: ${JSON.stringify(value.err)}; ${(value.logs ?? []).slice(-3).join(' / ')}`;
        return { ok: false, reason: JSON.stringify(value.err), jupiterIncorrectTokenProgram: isJupiterIncorrectTokenProgram(b64, value.err, value.logs) };
      },
    },
    { quote, inputMint, outputMint, user: owner.toBase58() },
  );
  return { kind: 'net', net, threshold: String(quote.otherAmountThreshold), fee, feeDetail: fee === 'charged' ? null : feeDetail };
}

function record(p: PreparedTx, c: Candidate) {
  const s = p.summary as RouteSwapSummary;
  const d = (k: PublicKey) => p.simulated.tokenDeltas.find((x) => x.account.equals(k))!.delta;
  const wsolAta = associatedTokenAddress(WSOL_MINT, c.owner);
  const pre = p.check.pre.tokens.get(wsolAta.toBase58());
  return {
    wallet: c.owner,
    walletLamportsBefore: p.check.pre.signerLamports,
    wsolBefore: pre?.exists ? { amount: pre.amount, lamports: pre.lamports, storedReserve: pre.nativeReserve } : null,
    side: s.side,
    amountIn: s.amountIn,
    swap: s.swap,
    fee: s.fee.amount,
    quoteOut: s.quote.outAmount,
    steps: bodySteps(p.steps).map((x) => x.kind),
    sizeBytes: p.sizeBytes,
    unitsConsumed: p.simulation.unitsConsumed,
    priorityFeeLamports: p.fees.priorityLamports,
    newAccountRentLamports: p.fees.newAccountRentLamports,
    expect: p.check.expect,
    simulated: { walletLamports: p.simulated.signerLamportsDelta, token: d(associatedTokenAddress(s.tokenMint, c.owner, p.check.intent.kind === 'lp-swap' ? p.check.intent.pins.tokenProgram : TOKEN_PROGRAM_ID)), wsol: d(wsolAta), feeAccount: d(SITE_FEE_WSOL_ACCOUNT) },
    logsTail: p.simulation.logs.slice(-8),
  };
}

describe.skipIf(!ENABLED)(DR3 ? 'DR-3: the real builder against one of OUR OWN pools on mainnet, with Jupiter’s live numbers (nothing signed, nothing sent)' : 'DR-2: the real builder against Raydium’s identical pool program on mainnet (nothing signed, nothing sent)', () => {
  const conn = new Connection(RPC_URL, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  const rpc = readOnly(conn);
  const tier0 = deriveAmmConfig(RAYDIUM_CPMM, 0);
  const useless = sortMints(WSOL_MINT, USELESS_MINT);
  const targets: Target[] = DR3
    ? [{ name: `our pool ${DR3_ENV.pool} for ${DR3_ENV.mint} on ${DR3_ENV.program}`, pool: new PublicKey(DR3_ENV.pool), mint: new PublicKey(DR3_ENV.mint), tokenProgram: null }]
    : [
        { name: 'USELESS/SOL (classic token, standard address, tier 0)', pool: derivePool(RAYDIUM_CPMM, tier0, useless.token0, useless.token1), mint: USELESS_MINT, tokenProgram: TOKEN_PROGRAM_ID },
        { name: 'ai16z/SOL (Token-2022, one-off address, tier 0)', pool: AI16Z_POOL, mint: AI16Z_MINT, tokenProgram: TOKEN_2022_PROGRAM_ID },
      ];
  const runs: Record<string, unknown> = {};
  log.dr2 = runs;

  const args = (t: Resolved, c: Candidate, decimals: number, side: 'buy' | 'sell', amountIn: bigint): RouteSwapArgs => ({
    owner: c.owner,
    pool: t.pool,
    tokenMint: t.mint,
    tokenDecimals: decimals,
    side,
    amountIn,
    slippageBps: SLIP,
    // The SHAPE pass. The ranking is not under test here: any pool beats a Jupiter net of
    // 1 and a shown net of 1. (DR-3 then runs the same trade with Jupiter's live numbers.)
    jupiterNet: 1n,
    jupiterFee: 'charged',
    shownNet: 1n,
  });

  /**
   * DR-3 only: the same trade again, with what the PAGE would hand the builder. Jupiter's
   * live amount for it, proven to be after our fee; the probe's answer on whether
   * Jupiter's own transaction carries that fee; and the amount this pool just showed.
   * The builder must then decide as the route rule says, and say so in its own words.
   */
  async function withLiveNumbers(t: Resolved, c: Candidate, decimals: number, side: 'buy' | 'sell', amountIn: bigint, shape: PreparedTx, key: string) {
    const shown = (shape.summary as RouteSwapSummary).netExpected;
    const j = await liveJupiter(conn, t, c.owner, side, amountIn);
    const entry = runs[key] as Record<string, unknown>;
    entry.live = { jupiter: j, shownNet: shown };
    // Unread is never "no competitor": the run is red (softly, so the other cases still run and are logged).
    expect.soft(j.kind, `${key}: Jupiter's live answer could not be read (${j.kind === 'unread' ? j.detail : ''}); run again`).not.toBe('unread');
    if (j.kind === 'unread') return;
    const real = await prepareRouteSwap(rpc, GATE, { ...args(t, c, decimals, side, amountIn), jupiterNet: j.kind === 'net' ? j.net : null, jupiterFee: j.kind === 'net' ? j.fee : 'unchecked', shownNet: shown }, ON);
    (entry.live as Record<string, unknown>).builder = real.ok ? { built: true, netExpected: (real.prepared.summary as RouteSwapSummary).netExpected, netGuaranteed: (real.prepared.summary as RouteSwapSummary).netGuaranteed } : { built: false, message: real.outcome.message };
    if (j.kind === 'no-route') {
      // Only the token's launch pool may run, and only with a provably honest price.
      if (!real.ok) {
        const noRouteRefusals: string[] = [ROUTE_COPY.noRouteNotLaunch, ROUTE_COPY.launchPriceUnread, ROUTE_COPY.launchReservesMoved, ROUTE_COPY.launchTooQuiet];
        expect(noRouteRefusals.includes(real.outcome.message) ||/% from its own average/.test(real.outcome.message), real.outcome.message).toBe(true);
      }
      return;
    }
    if (j.fee !== 'charged') {
      // Jupiter's trade goes out without the fee (or that could not be checked): ours must not be built against its number.
      expect(real.ok, `${key}: built against a Jupiter number whose fee is '${j.fee}'`).toBe(false);
      if (!real.ok) expect(real.outcome.message).toBe(j.fee === 'waived' ? ROUTE_COPY.jupiterFeeWaived : ROUTE_COPY.jupiterFeeUnchecked);
      return;
    }
    if (!real.ok) {
      expect(real.outcome.message, `${key}: refused, but not because Jupiter pays more`).toBe(ROUTE_COPY.jupiterPaysMore);
      // The pool is live, so ours may have moved since the shape pass. Read it once more
      // and log it, so a reader can see what ours paid around the refusal.
      const again = await prepareRouteSwap(rpc, GATE, args(t, c, decimals, side, amountIn), ON);
      (entry.live as Record<string, unknown>).oursAfterRefusal = again.ok ? (again.prepared.summary as RouteSwapSummary).netExpected : again.outcome.message;
      return;
    }
    const s = real.prepared.summary as RouteSwapSummary;
    expect(s.versus).toBe(j.net);
    // Built only when ours pays at least what Jupiter pays after the same fee...
    expect(s.netExpected).toBeGreaterThanOrEqual(j.net);
    // ...and then the trader's worst case is within 2 units of Jupiter's own (T-INV).
    const jupiterThreshold = (j.net * (10_000n - SLIP) + 9_999n) / 10_000n;
    expect(s.netGuaranteed).toBeGreaterThanOrEqual(jupiterThreshold - 2n);
    proven(real.prepared, c, t);
  }

  /** The first candidate the builder prepares for, with every refusal on the way logged. */
  async function firstPrepared(t: Resolved, pick: Candidate[], decimals: number, side: 'buy' | 'sell', amountOf: (c: Candidate) => bigint, key: string): Promise<{ p: PreparedTx; c: Candidate } | null> {
    const tried: unknown[] = [];
    for (const c of pick.slice(0, 6)) {
      const r: Prepared = await prepareRouteSwap(rpc, GATE, args(t, c, decimals, side, amountOf(c)), ON);
      if (r.ok) {
        runs[key] = { ...record(r.prepared, c), triedFirst: tried };
        if (DR3) await withLiveNumbers(t, c, decimals, side, amountOf(c), r.prepared, key);
        return { p: r.prepared, c };
      }
      tried.push({ wallet: c.owner.toBase58(), outcome: r.outcome });
    }
    runs[key] = { notRun: pick.length ? 'the builder refused every wallet found' : 'no wallet of this kind among the traders scanned', tried };
    return null;
  }

  /** Why a required case did not run, for the failure line: the kind of wallet missing, or each refusal. */
  const whyNot = (key: string): string => {
    const e = runs[key] as { notRun?: string; tried?: Array<{ wallet: string; outcome: { message?: string } }> } | undefined;
    const refusals = (e?.tried ?? []).map((x) => `${x.wallet}: ${x.outcome.message ?? 'refused'}`).join(' | ');
    return `REQUIRED CASE DID NOT RUN: "${key}" (${e?.notRun ?? 'not attempted'}). ${refusals} Offer a wallet of this kind with SOLANA_MAINNET_DRYRUN_WALLETS, or scan more with SOLANA_MAINNET_DRYRUN_SCAN, and run again. A run without this case proves nothing about it.`;
  };

  /** What every prepared dry run must show (3.6), from the simulation of the final bytes. */
  function proven(p: PreparedTx, c: Candidate, t: Resolved) {
    const s = p.summary as RouteSwapSummary;
    const wsolAta = associatedTokenAddress(WSOL_MINT, c.owner);
    const tokenAta = associatedTokenAddress(t.mint, c.owner, t.tokenProgram);
    const d = (k: PublicKey) => p.simulated.tokenDeltas.find((x) => x.account.equals(k))!.delta;
    const rowOf = (k: PublicKey) => p.check.expect.tokens.find((x) => x.account.equals(k))!;
    expect(p.kind).toBe('lp-swap');
    // The fee account gains exactly the fee: one TransferChecked, no sync, no re-price.
    expect(d(SITE_FEE_WSOL_ACCOUNT)).toBe(s.fee.amount);
    expect(s.fee.to.equals(SITE_FEE_WSOL_ACCOUNT)).toBe(true);
    expect(p.simulation.logs.some((l) => /Instruction: SwapBaseInput/.test(l))).toBe(true);
    expect(p.simulation.logs.some((l) => l.includes(`Program ${POOL_PROGRAM.toBase58()} success`))).toBe(true);
    if (s.side === 'buy') {
      expect(s.fee.amount).toBe((s.amountIn * 50n) / 10_000n);
      expect(d(tokenAta)).toBeGreaterThanOrEqual(s.swap.minimumAmountOut);
      // Exact, on mainnet's token program: 0 when it is closed, and when kept exactly what
      // the sync credits from lamports the account already held.
      const row = rowOf(wsolAta);
      expect(row.minDelta).toBe(row.maxDelta);
      expect(d(wsolAta)).toBe(row.minDelta);
    } else {
      expect(s.fee.amount).toBe((s.swap.minimumAmountOut * 50n) / 10_000n);
      expect(d(tokenAta)).toBe(-s.amountIn);
    }
  }

  for (const t0 of targets) {
    it(
      t0.name,
      async () => {
        const slug = t0.mint.toBase58().slice(0, 4);
        const mintInfo = await rpc.getAccountInfo(t0.mint, 'confirmed');
        expect(mintInfo, 'the token mint could not be read').not.toBeNull();
        const mintOwner = mintInfo!.owner;
        // The token's program is the mint's owner, and it must be one of the two token programs.
        expect(mintOwner.equals(TOKEN_PROGRAM_ID) || mintOwner.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
        if (t0.tokenProgram) expect(mintOwner.equals(t0.tokenProgram)).toBe(true);
        const t: Resolved = { ...t0, tokenProgram: mintOwner };
        const decimals = mintInfo!.data[44]!;
        const rent165 = BigInt(await rpc.getMinimumBalanceForRentExemption(165));
        const owners = await traders(conn, t.pool, Number(process.env.SOLANA_MAINNET_DRYRUN_SCAN ?? 60));
        const found = await look(conn, owners, t.mint, t.tokenProgram);
        const credit = (c: Candidate) => (c.wsol ? syncCredit({ exists: true, amount: c.wsol.amount, lamports: c.wsol.lamports, nativeReserve: c.wsol.reserve }, rent165) : 0n);
        runs[`${slug} wallets`] = {
          scanned: owners.length,
          usable: found.length,
          rent165,
          found: found.map((c) => ({ wallet: c.owner, lamports: c.lamports, tokens: c.tokens, wsol: c.wsol, syncCredit: credit(c) })),
        };

        // Smaller wallets first, so a refusal names something a person would see; among
        // kept accounts, the largest sync credit first (an account set up under an older rent).
        const bySize = (a: Candidate, b: Candidate) => (a.lamports < b.lamports ? -1 : 1);
        const byCredit = (a: Candidate, b: Candidate) => (credit(a) > credit(b) ? -1 : credit(a) < credit(b) ? 1 : 0);
        const noWsol = found.filter(closed).sort(bySize);
        const keeps = found.filter(kept).sort(byCredit);
        const BUY = 20_000_000n;
        const half = (c: Candidate) => (c.tokens > 1n ? c.tokens / 2n : c.tokens);

        // (a) a wallet with no wrapped-SOL account, or an empty one: closed after.
        // ALL FOUR CASES ARE REQUIRED. Each is attempted and logged first, so one red run
        // names every case that is missing; then each is held to its own numbers.
        const KEY = { buyA: `${slug} buy, wSOL closed after`, buyB: `${slug} buy, wSOL kept`, sellA: `${slug} sell, wSOL closed after`, sellB: `${slug} sell, wSOL kept` };
        const buyA = await firstPrepared(t, noWsol.filter((c) => c.lamports > 100_000_000n), decimals, 'buy', () => BUY, KEY.buyA);
        // (b) Only a kept account whose sync credit is MORE THAN ZERO proves mainnet's re-price
        // of the stored reserve: an account already at today's rent shows a row of exactly 0
        // whether the token program re-prices or not.
        const buyB = await firstPrepared(t, keeps.filter((c) => c.lamports > 100_000_000n && credit(c) > 0n), decimals, 'buy', () => BUY, KEY.buyB);
        const sellA = await firstPrepared(t, noWsol.filter((c) => c.tokens > 0n), decimals, 'sell', half, KEY.sellA);
        // The largest holder first, so the fee is more than a lamport or two.
        const keepsWithTokens = keeps.filter((c) => c.tokens > 0n).sort((a, b) => (a.tokens > b.tokens ? -1 : 1));
        const sellB = await firstPrepared(t, keepsWithTokens, decimals, 'sell', half, KEY.sellB);
        const missing = (Object.keys(KEY) as Array<keyof typeof KEY>).filter((k) => ({ buyA, buyB, sellA, sellB })[k] === null);
        runs[`${slug} required cases`] = { ran: 4 - missing.length, of: 4, missing: missing.map((k) => KEY[k]) };
        // A SOFT expectation: the run is red from here on, whatever happens below, and the
        // cases that did run are still checked and the rent band still runs and is logged.
        expect.soft(missing.map((k) => whyNot(KEY[k])), missing.map((k) => whyNot(KEY[k])).join('\n')).toEqual([]);

        if (buyA) {
          proven(buyA.p, buyA.c, t);
          const s = buyA.p.summary as RouteSwapSummary;
          expect(s.unwrapsWsol).toBe(true);
          expect(buyA.p.check.expect.tokens.find((x) => x.account.equals(associatedTokenAddress(WSOL_MINT, buyA.c.owner)))).toMatchObject({ minDelta: 0n, maxDelta: 0n });
          // The wallet pays the SOL typed and, at most, the new token account's deposit, plus network fees.
          const fees = buyA.p.fees.baseLamports + buyA.p.fees.priorityLamports;
          expect(-buyA.p.simulated.signerLamportsDelta).toBeLessThanOrEqual(BUY + buyA.p.fees.newAccountRentLamports + fees);
          expect(-buyA.p.simulated.signerLamportsDelta).toBeGreaterThanOrEqual(BUY + buyA.p.fees.newAccountRentLamports);
        }

        // (b) a wallet that keeps wrapped SOL: never unwrapped, never spent, and the sync's credit is exact.
        if (buyB) {
          proven(buyB.p, buyB.c, t);
          const wsolAta = associatedTokenAddress(WSOL_MINT, buyB.c.owner);
          const pre = buyB.p.check.pre.tokens.get(wsolAta.toBase58());
          const want = syncCredit(pre, rent165);
          expect((buyB.p.summary as RouteSwapSummary).unwrapsWsol).toBe(false);
          // On the builder's own read too, not only the scan's: the re-price is really exercised.
          expect(want, 'the kept account was already at today’s rent when the builder read it, so the re-price was not exercised; run again').toBeGreaterThan(0n);
          expect(buyB.p.simulated.tokenDeltas.find((x) => x.account.equals(wsolAta))!.delta).toBe(want);
          (runs[KEY.buyB] as Record<string, unknown>).syncCreditPredicted = want;
        }

        if (sellA) {
          proven(sellA.p, sellA.c, t);
          const s = sellA.p.summary as RouteSwapSummary;
          // What the pool paid less the fee reaches the wallet as SOL (it pays only network fees).
          const fees = sellA.p.fees.baseLamports + sellA.p.fees.priorityLamports;
          expect(sellA.p.simulated.signerLamportsDelta + fees).toBeGreaterThanOrEqual(s.swap.minimumAmountOut - s.fee.amount);
        }

        if (sellB) {
          proven(sellB.p, sellB.c, t);
          const s = sellB.p.summary as RouteSwapSummary;
          const wsolAta = associatedTokenAddress(WSOL_MINT, sellB.c.owner);
          expect(s.unwrapsWsol).toBe(false);
          // No sync on a sell: the wrapped balance gains what the pool paid less the fee, at least the minimum.
          expect(sellB.p.simulated.tokenDeltas.find((x) => x.account.equals(wsolAta))!.delta).toBeGreaterThanOrEqual(s.swap.minimumAmountOut - s.fee.amount);
        }

        // The rent band at mainnet's rent: the builder names the most this wallet can swap;
        // one lamport more is refused, exactly that much prepares.
        const bandWallet = buyA?.c ?? noWsol[0];
        if (bandWallet) {
          const over = await prepareRouteSwap(rpc, GATE, args(t, bandWallet, decimals, 'buy', bandWallet.lamports), ON);
          expect(over.ok).toBe(false);
          const said = !over.ok ? /The most you can swap from this wallet is ([0-9.]+) SOL\.$/.exec(over.outcome.message) : null;
          expect(said, !over.ok ? over.outcome.message : '').not.toBeNull();
          if (said) {
            const [whole, frac = ''] = said[1]!.split('.');
            const most = BigInt(whole!) * 10n ** 9n + BigInt(frac.padEnd(9, '0'));
            // The same number worked out here from mainnet's rents, read apart from the builder:
            // the balance, less the fee reserve, a missing token account's deposit, and the larger
            // of a missing wrapped-SOL account's deposit and the wallet's own floor.
            const rent0 = BigInt(await rpc.getMinimumBalanceForRentExemption(0));
            const tokenRent = BigInt(await rpc.getMinimumBalanceForRentExemption(t.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165));
            const walletNow = BigInt((await rpc.getAccountInfo(bandWallet.owner, 'confirmed'))?.lamports ?? 0);
            const byHand = spendableSol({
              lamports: walletNow,
              walletFloor: rent0,
              feeReserve: LP_FEE_RESERVE,
              lpAccountRent: bandWallet.hasTokenAccount ? 0n : tokenRent,
              wsolCreateRent: bandWallet.wsol ? 0n : rent165,
            });
            expect(most).toBe(byHand);
            const above = await prepareRouteSwap(rpc, GATE, args(t, bandWallet, decimals, 'buy', most + 1n), ON);
            expect(above.ok).toBe(false);
            if (!above.ok) expect(above.outcome.message).toBe(ROUTE_COPY.rentBand(said[1]!));
            const at = await prepareRouteSwap(rpc, GATE, args(t, bandWallet, decimals, 'buy', most), ON);
            runs[`${slug} rent band`] = {
              wallet: bandWallet.owner,
              walletLamports: walletNow,
              rents: { wallet: rent0, wsolAccount: rent165, tokenAccount: tokenRent },
              most,
              atMost: at.ok ? record(at.prepared, bandWallet) : at.outcome,
              oneAbove: !above.ok ? above.outcome.message : 'PREPARED (wrong)',
            };
            expect(at.ok, at.ok ? '' : at.outcome.message).toBe(true);
            if (at.ok) proven(at.prepared, bandWallet, t);
          }
        }
      },
      1_500_000,
    );
  }
});

// ── DR-1 ─────────────────────────────────────────────────────────────────────

describe.skipIf(!ENABLED)('DR-1: Jupiter’s quote still means "after our fee" today (the real jupiterNet on live quotes)', () => {
  const USELESS = USELESS_MINT.toBase58();
  const AI16Z = AI16Z_MINT.toBase58();
  const BAYLA = BAYLA_MINT.toBase58();
  // Both directions; large amounts to draw out split routes; a token-to-token pair for hops.
  const pairs: Array<[string, string, string, string]> = [
    ['SOL -> USDC, 1,000 SOL', SOL_MINT, USDC_MINT, '1000000000000'],
    ['USDC -> SOL, 200,000 USDC', USDC_MINT, SOL_MINT, '200000000000'],
    ['SOL -> USELESS, 0.1 SOL', SOL_MINT, USELESS, '100000000'],
    ['SOL -> USELESS, 300 SOL', SOL_MINT, USELESS, '300000000000'],
    ['USELESS -> SOL', USELESS, SOL_MINT, '50000000000'],
    ['SOL -> ai16z, 1 SOL', SOL_MINT, AI16Z, '1000000000'],
    ['ai16z -> SOL', AI16Z, SOL_MINT, '5000000000000'],
    ['SOL -> BAYLA, 0.1 SOL', SOL_MINT, BAYLA, '100000000'],
    ['BAYLA -> SOL', BAYLA, SOL_MINT, '2000000000'],
    ['USELESS -> ai16z (token to token)', USELESS, AI16Z, '50000000000'],
  ];

  it(
    'jupiterNet is a number, not "unread", for every quote Jupiter answers',
    async () => {
      const rows: unknown[] = [];
      log.dr1 = rows;
      let answered = 0;
      for (const [name, inputMint, outputMint, amount] of pairs) {
        const qs = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: '50', swapMode: 'ExactIn', restrictIntermediateTokens: 'true', platformFeeBps: String(COMPARABLE_PLATFORM_FEE_BPS) });
        let res: Response | null = null;
        for (let i = 0; i < 5; i++) {
          res = await fetch(`${JUPITER}/quote?${qs}`, { headers: { Accept: 'application/json' } });
          if (res.status !== 429) break;
          await sleep(3_000 * (i + 1));
        }
        await sleep(900);
        if (!res || !res.ok) {
          rows.push({ name, status: res?.status ?? null, body: res ? (await res.text()).slice(0, 200) : null });
          continue;
        }
        const quote = (await res.json()) as JupiterQuote;
        answered++;
        const net = jupiterNet({ kind: 'quote', quote, feeBpsSent: COMPARABLE_PLATFORM_FEE_BPS }, { inputMint, outputMint, amount });
        const legs = quote.routePlan.map((l) => (l as { swapInfo: { label?: string; outputMint: string; outAmount: string } }).swapInfo);
        const finals = legs.filter((l) => l.outputMint === outputMint);
        rows.push({
          name,
          outAmount: quote.outAmount,
          otherAmountThreshold: quote.otherAmountThreshold,
          platformFee: quote.platformFee,
          legs: legs.length,
          finalLegs: finals.length,
          hops: legs.length - finals.length,
          sumOfFinalLegs: finals.reduce((n, l) => n + BigInt(l.outAmount), 0n),
          labels: legs.map((l) => l.label),
          jupiterNet: net,
        });
        expect(net, `${name}: Jupiter's number could not be proven to be after our fee`).not.toBeNull();
        expect(net).toBe(BigInt(quote.outAmount));
      }
      expect(answered).toBeGreaterThanOrEqual(6);
    },
    300_000,
  );
});
