import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { PROGRAM_ID as LAUNCH_PROGRAM_ID } from '../../launcher/solana/curve/program';
import { TOKEN_PROGRAM_ID, swapBaseInputIx } from '../cpswap/ix';
import { REGISTERED_PROGRAM_ID } from '../cpswap/program';
import { quoteOwnPool } from '../cpswap/read';
import { decodeRpcAccount, getMultipleAccounts, type RawAccount } from '../lp/accounts';
import type { PoolView } from '../lp/poolFinder';
import { arbitrage, listPools, readMarketPrices, rowTokenFee } from '../lp/poolList';
import { readTokenSafety } from '../lp/tokenSafety';
import { refusedVenues, type JupiterApi } from './jupiterApi';
import {
  KEEPER_COINS,
  NEW_ACCOUNT_RENT,
  decodeJupiterRoute,
  jupiterFloor,
  jupiterLegProblem,
  lamportsInCoin,
  lastJupiterSlippage,
  lastPoolMinimum,
  planFor,
  simulationProblem,
  type KeeperLimits,
  type Plan,
} from './plan';

/**
 * One pass of the price keeper: read every pool, find the gaps worth closing, and for each
 * build the round trip, test-run it, and (live only) send it. Every refusal is a line in the
 * log and the next pool; nothing here throws past a pool.
 */

export interface KeeperIo {
  rpc: SolanaRpc;
  jupiter: JupiterApi;
  /** The keeper's wallet. A dry run names it without its key. */
  owner: PublicKey;
  /** The site's pool index (`/api/pools`), as a fetch for poolIndex.ts. */
  indexFetch: typeof fetch;
  /** Signs and sends; absent on a dry run, which stops after the test run. */
  send?: (tx: VersionedTransaction) => Promise<{ signature: string; outcome: 'confirmed' | 'reverted' | 'unknown' }>;
  log: (line: string) => void;
}

export interface KeeperSettings extends KeeperLimits {
  /** Jupiter's route may use at most this many accounts, so both swaps fit one transaction. */
  maxAccounts: number;
  /** Priority fee, in micro-lamports per compute unit. */
  microLamports: number;
  /**
   * Let Jupiter's leg go through Raydium. Off by default (owner ruling 2026-10-13: no money to
   * Raydium); the owner allowed it for the keeper on 2026-10-31, for coins Raydium alone trades.
   */
  allowRaydium: boolean;
  /** Open a token account on a coin's first trip even when that trip does not earn its rent back (owner, 2026-10-31). */
  payNewAccountRent: boolean;
}

export const DEFAULT_SETTINGS: Omit<KeeperSettings, keyof KeeperLimits> = { maxAccounts: 30, microLamports: 10_000, allowRaydium: false, payNewAccountRent: false };

const SIM_UNITS = 1_400_000;
/**
 * The route size asked for again when Jupiter finds none within `maxAccounts`: a coin traded on
 * Pump.fun's pools needs more (BAYLA, GRR, walked 2026-10-31). A route too big to sit beside our
 * pool's swap in one transaction is then refused when the transaction is built.
 */
const ROOMY_ACCOUNTS = 64;
const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';

export interface CycleResult {
  pools: number;
  gaps: number;
  sent: number;
}

export async function runCycle(io: KeeperIo, s: KeeperSettings): Promise<CycleResult> {
  const listed = await listPools(io.rpc, { programId: REGISTERED_PROGRAM_ID, launchProgramId: LAUNCH_PROGRAM_ID, fetchImpl: io.indexFetch });
  if (listed.kind === 'unread') {
    io.log(`Pools not read: ${listed.detail}`);
    return { pools: 0, gaps: 0, sent: 0 };
  }
  const { pools, chainNow } = listed.list;
  const prices = await readMarketPrices(pools, (m) => io.jupiter.prices(m));
  if (prices.kind === 'unread') {
    io.log('Jupiter prices not read: nothing is traded this pass');
    return { pools: pools.length, gaps: 0, sent: 0 };
  }
  // The list skips the coins the site names itself; the keeper reads every token's fee.
  const safety = await readTokenSafety(io.rpc, pools.map((v) => v.tokenMint));
  const refused = s.allowRaydium ? refusedVenues({}, true) : refusedVenues(await io.jupiter.labels());
  if (!s.allowRaydium && !refused.names.length) {
    io.log('Jupiter’s venue list names no Raydium venue, so Raydium cannot be left out: nothing is traded this pass');
    return { pools: pools.length, gaps: 0, sent: 0 };
  }
  let gaps = 0;
  let sent = 0;
  for (const view of pools) {
    const checked = safety.get(view.tokenMint) ?? null;
    // The token's own claim, untrusted: the whole address is always beside it.
    const name = `${checked?.kind === 'read' && checked.symbol ? checked.symbol : '?'} (${view.tokenMint}) / ${view.quote.symbol}`;
    const fee = rowTokenFee(view, checked);
    if (fee !== null) {
      io.log(`${name}: skipped, ${fee === 'unread' ? 'the token’s fee was not read' : 'the token keeps a transfer fee'}`);
      continue;
    }
    const arb = arbitrage(view, prices.usd, chainNow, null);
    if (!arb) continue;
    gaps++;
    const plan = planFor(view, arb, prices.usd, s);
    if (typeof plan === 'string') {
      io.log(`${name}: gap of up to $${arb.profitUsd.toFixed(2)} at Jupiter's listed price, skipped (${plan})`);
      continue;
    }
    try {
      const done = await roundTrip(io, s, view, plan, chainNow, prices.usd, refused, name);
      if (done !== 'none') sent++;
      if (done === 'unsure') {
        // Until it is known whether that trip landed, no balance read can be trusted.
        io.log('A sent trip is not confirmed yet: the rest of this pass waits for the next read');
        break;
      }
    } catch (e) {
      const said = e instanceof Error ? e.message : String(e);
      // The usual reason, said plainly: the coin's only market Jupiter knows is a refused venue's.
      io.log(`${name}: ${/NO_ROUTES_FOUND/.test(said) && refused.names.length ? 'skipped, Jupiter has no route for it that avoids Raydium' : `stopped, ${said}`}`);
    }
  }
  return { pools: pools.length, gaps, sent };
}

async function roundTrip(
  io: KeeperIo,
  s: KeeperSettings,
  view: PoolView,
  plan: Plan,
  chainNow: bigint | null,
  usd: ReadonlyMap<string, number>,
  refused: { names: string[]; programs: Set<string> },
  name: string,
): Promise<'none' | 'sent' | 'unsure'> {
  const { pool } = view.snapshot;
  if (!view.config || chainNow === null) throw new Error('pool fees or the clock not read');
  const owner = io.owner;
  const amt = (raw: bigint) => `${(Number(raw) / 10 ** view.quote.decimals).toFixed(Math.min(view.quote.decimals, 6))} ${view.quote.symbol}`;
  const coinMint = new PublicKey(plan.coinMint);
  const tokenMint = new PublicKey(plan.tokenMint);
  const tokenProgram = new PublicKey(view.quoteIsToken0 ? pool.token1Program : pool.token0Program);
  const coinAta = getAssociatedTokenAddressSync(coinMint, owner, true, TOKEN_PROGRAM_ID);
  const tokenAta = getAssociatedTokenAddressSync(tokenMint, owner, true, tokenProgram);
  // The keeper's other float (USDC on a SOL trip, wrapped SOL on a USDC one): watched, never
  // touched. In the SOL/USDC pool the token IS that float, already watched as the token.
  const other = KEEPER_COINS.find((c) => c.mint !== plan.coinMint && c.mint !== plan.tokenMint);
  const otherAta = other ? getAssociatedTokenAddressSync(new PublicKey(other.mint), owner, true, TOKEN_PROGRAM_ID) : tokenAta;
  const coinVault = new PublicKey(view.quoteIsToken0 ? pool.token0Vault : pool.token1Vault);
  const tokenVault = new PublicKey(view.quoteIsToken0 ? pool.token1Vault : pool.token0Vault);
  const ownSwap = (input: 'coin' | 'token', amountIn: bigint, minimumAmountOut: bigint) =>
    swapBaseInputIx({
      programId: REGISTERED_PROGRAM_ID,
      payer: owner,
      ammConfig: new PublicKey(pool.ammConfig),
      poolState: new PublicKey(view.address),
      inputTokenAccount: input === 'coin' ? coinAta : tokenAta,
      outputTokenAccount: input === 'coin' ? tokenAta : coinAta,
      inputVault: input === 'coin' ? coinVault : tokenVault,
      outputVault: input === 'coin' ? tokenVault : coinVault,
      inputTokenProgram: input === 'coin' ? TOKEN_PROGRAM_ID : tokenProgram,
      outputTokenProgram: input === 'coin' ? tokenProgram : TOKEN_PROGRAM_ID,
      inputTokenMint: input === 'coin' ? coinMint : tokenMint,
      outputTokenMint: input === 'coin' ? tokenMint : coinMint,
      observationState: new PublicKey(pool.observationKey),
      amountIn,
      minimumAmountOut,
    });

  const before = await balances(io.rpc, [coinAta, tokenAta, otherAta, owner]);
  if (before.coin < plan.coinIn) {
    io.log(`${name}: skipped, the keeper holds ${amt(before.coin)} and the trade needs ${amt(plan.coinIn)}`);
    return 'none';
  }
  if (!before.tokenExists && !s.payNewAccountRent) {
    // The first trip in a token opens the keeper's account for it: that rent is this trip's cost.
    const rent = lamportsInCoin(NEW_ACCOUNT_RENT, view.quote, usd);
    if (rent === null) {
      io.log(`${name}: skipped, no SOL price to count the new token account’s rent`);
      return 'none';
    }
    plan = { ...plan, minProfit: plan.minProfit + rent };
  }
  const need = plan.coinIn + plan.minProfit;
  const quote = async (p: Omit<Parameters<JupiterApi['quote']>[0], 'maxAccounts'>) => {
    try {
      return await io.jupiter.quote({ ...p, maxAccounts: s.maxAccounts });
    } catch (e) {
      if (!(e instanceof Error && /NO_ROUTES_FOUND/.test(e.message)) || s.maxAccounts >= ROOMY_ACCOUNTS) throw e;
      return io.jupiter.quote({ ...p, maxAccounts: ROOMY_ACCOUNTS });
    }
  };
  const legExpect = { owner, refused: refused.programs, untouchable: other ? [otherAta] : [] };
  let legs: TransactionInstruction[];
  let lookupTables: string[];
  if (plan.side === 'buy') {
    const own = quoteOwnPool(view.snapshot, view.config, plan.coinMint, plan.coinIn, Number(chainNow));
    if (!own || own.outAmount <= 0n) throw new Error('our pool would not quote the buy');
    const q = await quote({ inputMint: plan.tokenMint, outputMint: plan.coinMint, amount: own.outAmount, slippageBps: s.slippageBps, excludeDexes: refused.names });
    const bps = lastJupiterSlippage(BigInt(q.outAmount), need, s.slippageBps);
    if (bps === null) {
      io.log(`${name}: skipped, Jupiter pays back ${amt(BigInt(q.outAmount))} for ${amt(plan.coinIn)}: under the profit floor`);
      return 'none';
    }
    const minOut = jupiterFloor(BigInt(q.outAmount), bps);
    const si = await io.jupiter.swapInstructions({ ...q, slippageBps: bps, otherAmountThreshold: minOut.toString() }, owner);
    if (si.extra) throw new Error('Jupiter added instructions the keeper does not sign');
    const problem = jupiterLegProblem(si.swap, { ...legExpect, inputMint: tokenMint, inputProgram: tokenProgram, outputMint: coinMint, outputProgram: TOKEN_PROGRAM_ID, inAmount: own.outAmount, minOut });
    if (problem) throw new Error(problem);
    legs = [ownSwap('coin', plan.coinIn, own.outAmount), si.swap];
    lookupTables = si.lookupTables;
  } else {
    const q = await quote({ inputMint: plan.coinMint, outputMint: plan.tokenMint, amount: plan.coinIn, slippageBps: s.slippageBps, excludeDexes: refused.names });
    const si = await io.jupiter.swapInstructions(q, owner);
    if (si.extra) throw new Error('Jupiter added instructions the keeper does not sign');
    const route = decodeJupiterRoute(si.swap.data);
    if (!route) throw new Error('the swap is not a route_v2 Jupiter swap');
    // What Jupiter must deliver, as the chain will hold it to: the most our pool can be sold.
    // Anything Jupiter pays over that stays with the keeper as a little of the token.
    const tokensIn = jupiterFloor(route.quotedOutAmount, route.slippageBps);
    const problem = jupiterLegProblem(si.swap, { ...legExpect, inputMint: coinMint, inputProgram: TOKEN_PROGRAM_ID, outputMint: tokenMint, outputProgram: tokenProgram, inAmount: plan.coinIn, minOut: tokensIn });
    if (problem) throw new Error(problem);
    const own = quoteOwnPool(view.snapshot, view.config, plan.tokenMint, tokensIn, Number(chainNow));
    const ownMin = own ? lastPoolMinimum(own.outAmount, need, s.slippageBps) : null;
    if (ownMin === null) {
      io.log(`${name}: skipped, our pool pays ${amt(own?.outAmount ?? 0n)} for what ${amt(plan.coinIn)} buys on Jupiter: under the profit floor`);
      return 'none';
    }
    legs = [si.swap, ownSwap('token', tokensIn, ownMin)];
    lookupTables = si.lookupTables;
  }

  const alts = await lookupTablesOf(io.rpc, lookupTables);
  const build = async (units: number) => {
    const { blockhash } = (await io.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]) as { value: { blockhash: string } }).value;
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: s.microLamports }),
      createAssociatedTokenAccountIdempotentInstruction(owner, tokenAta, owner, tokenMint, tokenProgram),
      ...legs,
    ];
    return new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message(alts));
  };

  const trial = await build(SIM_UNITS);
  const sim = await simulate(io.rpc, trial, [coinAta, tokenAta, otherAta, owner]);
  if (sim.err) {
    io.log(`${name}: test run refused (${JSON.stringify(sim.err)})${sim.lastLog ? `: ${sim.lastLog}` : ''}`);
    return 'none';
  }
  const after = sim.after;
  const problem = simulationProblem(
    {
      coinBefore: before.coin, coinAfter: after.coin, tokenBefore: before.token, tokenAfter: after.token,
      otherCoinBefore: before.other, otherCoinAfter: after.other, lamportsBefore: before.lamports, lamportsAfter: after.lamports,
    },
    plan,
  );
  const gained = after.coin - before.coin;
  if (problem) {
    io.log(`${name}: test run not sent, ${problem}`);
    return 'none';
  }
  io.log(`${name}: ${plan.side === 'buy' ? 'buy here, sell on Jupiter' : 'buy on Jupiter, sell here'}, ${amt(plan.coinIn)} in, test run gains ${amt(gained)} (floor ${amt(plan.minProfit)})`);
  if (!io.send) return 'none';
  const tx = await build(Math.ceil(sim.units * 1.2) + 10_000);
  const r = await io.send(tx);
  io.log(`${name}: sent ${r.signature}: ${r.outcome}`);
  return r.outcome === 'unknown' ? 'unsure' : 'sent';
}

interface Balances {
  coin: bigint;
  token: bigint;
  tokenExists: boolean;
  other: bigint;
  lamports: bigint;
}

/** A token account's amount (offset 64), or 0 when the account does not exist yet. */
function tokenAmount(a: { data: Uint8Array } | null): bigint {
  if (!a || a.data.length < 72) return 0n;
  return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true);
}

/** Read at 'confirmed', the commitment the test run uses, so the two compare like with like. */
async function balances(rpc: SolanaRpc, keys: PublicKey[]): Promise<Balances> {
  const addresses = keys.map((k) => k.toBase58());
  const r = (await rpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])) as { value?: unknown[] };
  if (!Array.isArray(r?.value) || r.value.length !== addresses.length) throw new Error('the keeper’s balances were not read');
  const [c, t, x, o] = r.value.map((v, i) => (v === null ? null : decodeRpcAccount('getMultipleAccounts', addresses[i]!, v)));
  return { coin: tokenAmount(c ?? null), token: tokenAmount(t ?? null), tokenExists: !!t, other: tokenAmount(x ?? null), lamports: BigInt(o?.lamports ?? 0) };
}

async function lookupTablesOf(rpc: SolanaRpc, addresses: string[]): Promise<AddressLookupTableAccount[]> {
  if (!addresses.length) return [];
  const got = await getMultipleAccounts(rpc, addresses);
  return got.map((a: RawAccount | null, i) => {
    if (!a || a.owner !== ALT_PROGRAM) throw new Error(`lookup table ${addresses[i]} not read`);
    return new AddressLookupTableAccount({ key: new PublicKey(addresses[i]!), state: AddressLookupTableAccount.deserialize(a.data) });
  });
}

interface Simulated {
  err: unknown;
  lastLog: string | null;
  units: number;
  after: Balances;
}

async function simulate(rpc: SolanaRpc, tx: VersionedTransaction, keys: PublicKey[]): Promise<Simulated> {
  let bytes: Uint8Array;
  try {
    bytes = tx.serialize();
  } catch {
    throw new Error('Jupiter’s route and our pool’s swap do not fit in one transaction');
  }
  const b64 = Buffer.from(bytes).toString('base64');
  const r = (await rpc('simulateTransaction', [
    b64,
    {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses: keys.map((k) => k.toBase58()) },
    },
  ])) as { value: { err: unknown; logs?: string[] | null; unitsConsumed?: number; accounts?: ({ data: [string, string]; lamports: number } | null)[] | null } };
  const v = r.value;
  const acc = v.accounts ?? [];
  const data = (i: number) => {
    const a = acc[i];
    return a ? { data: Uint8Array.from(Buffer.from(a.data[0], 'base64')) } : null;
  };
  const logs = v.logs ?? [];
  // An account the answer leaves out reads as empty, which every check then refuses.
  return {
    err: v.err,
    lastLog: logs.length ? logs[logs.length - 1]! : null,
    units: v.unitsConsumed ?? SIM_UNITS,
    after: { coin: tokenAmount(data(0)), token: tokenAmount(data(1)), tokenExists: !!acc[1], other: tokenAmount(data(2)), lamports: BigInt(acc[3]?.lamports ?? 0) },
  };
}
