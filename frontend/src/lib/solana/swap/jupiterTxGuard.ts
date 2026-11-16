// Every transaction Jupiter builds is read here before a wallet sees it, and refused unless it is
// the trade on screen: one signer, the visitor; compute budget within the disclosed cap; SOL wrapped
// only when SOL is sold, into the visitor's own account; token accounts created for, or closed back
// to, the visitor; one instruction of the flow's Jupiter program (layouts from its on-chain IDLs)
// selling from the visitor's own account of the coin sold, with the amounts, coins and destination
// shown. balanceRefusal then holds the swap's test run to the same trade. The real captures pass.

import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();
const ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
export const JUPITER_SWAP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const JUPITER_TRIGGER_PROGRAM = 'j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X';
export const JUPITER_RECURRING_PROGRAM = 'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M';

// Anchor discriminators (sha256("global:<name>")[0..8]) from Jupiter's on-chain IDLs.
const ROUTE_V2 = 'bb64facc31c4af14';
const SHARED_ACCOUNTS_ROUTE_V2 = 'd19853937cfed8e9';
const INITIALIZE_ORDER = '856e4aaf709ff59f';
const CANCEL_ORDER = '5f81edf00831df84';
const CANCEL_DUST_ORDER = 'c570bda44f3017f6';
const OPEN_DCA_V2 = '8e772b6da2340bb1';
const CLOSE_DCA = '16072162a8b722f3';
const DCA_WITHDRAW = 'b712469c946da122';

/** A Solana transaction is refused with no compute-unit limit as if it used the max. */
const MAX_COMPUTE_UNITS = 1_400_000n;

export type JupiterTxExpectation =
  | {
    kind: 'swap';
    user: string;
    /** The quote the user saw, which the swap was built from. */
    quote: { inputMint: string; outputMint: string; inAmount: string; outAmount: string; slippageBps: number };
    /** The venue fee the site attached: its bps and the venue's own fee account, or 0 and null. */
    feeBps: number;
    feeAccount: string | null;
    maxPriorityLamports: number;
  }
  | { kind: 'trigger-create'; user: string; inputMint: string; outputMint: string; makingAmount: string; takingAmount: string; maxPriorityLamports: number }
  | { kind: 'trigger-cancel'; user: string; order: string; maxPriorityLamports: number }
  | {
    kind: 'recurring-create';
    user: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    numberOfOrders: number;
    intervalSeconds: number;
    maxPriorityLamports: number;
  }
  | { kind: 'recurring-cancel'; user: string; order: string; maxPriorityLamports: number };

const FLOW_PROGRAM: Record<JupiterTxExpectation['kind'], string> = {
  swap: JUPITER_SWAP_PROGRAM,
  'trigger-create': JUPITER_TRIGGER_PROGRAM,
  'trigger-cancel': JUPITER_TRIGGER_PROGRAM,
  'recurring-create': JUPITER_RECURRING_PROGRAM,
  'recurring-cancel': JUPITER_RECURRING_PROGRAM,
};

/** Jupiter's answer is not the trade on screen. Nothing is signed, and every caller says it in these words. */
export class NotTheTradeShown extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotTheTradeShown';
  }
}

/** Thrown by the Jupiter client when a transaction fails this check. Nothing is signed. */
export class JupiterTxRefused extends NotTheTradeShown {
  readonly reason: string;
  constructor(reason: string) {
    super(`Jupiter built a transaction this site will not sign: ${reason}. Nothing was signed.`);
    this.name = 'JupiterTxRefused';
    this.reason = reason;
  }
}

function usersAta(user: string, mint: string): Set<string> {
  const owner = new PublicKey(user);
  const m = new PublicKey(mint);
  return new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((p) => getAssociatedTokenAddressSync(m, owner, true, p).toBase58()));
}

const u64 = (b: Uint8Array, at: number): bigint | null => (b.length >= at + 8 ? new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true) : null);
const u16 = (b: Uint8Array, at: number): number | null => (b.length >= at + 2 ? new DataView(b.buffer, b.byteOffset + at, 2).getUint16(0, true) : null);
const u32 = (b: Uint8Array, at: number): number | null => (b.length >= at + 4 ? new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0, true) : null);
const hex8 = (b: Uint8Array): string => Array.from(b.subarray(0, 8), (x) => x.toString(16).padStart(2, '0')).join('');
const big = (s: string): bigint | null => (/^\d+$/.test(s) ? BigInt(s) : null);

/**
 * @param b64     the base64 transaction Jupiter returned
 * @param expect  the trade on screen
 * @returns why the transaction must not be signed, or null when it may
 */
export function jupiterTxRefusal(b64: string, expect: JupiterTxExpectation): string | null {
  // A check that cannot finish is a refusal, never a pass.
  try {
    return refusalOf(b64, expect);
  } catch {
    return 'it could not be checked';
  }
}

function refusalOf(b64: string, expect: JupiterTxExpectation): string | null {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return 'it could not be read';
  }
  const m = tx.message;
  const keys = m.staticAccountKeys.map((k) => k.toBase58());
  const user = expect.user;
  if (m.header.numRequiredSignatures !== 1 || keys[0] !== user) return 'it is not signed by your wallet alone';

  // An account loaded from a lookup table cannot be read without the chain, so any
  // account a rule below depends on must be a static key; otherwise it is refused.
  const at = (ix: { accountKeyIndexes: number[] }, n: number): string | null => {
    const i = ix.accountKeyIndexes[n];
    return (i !== undefined && i < keys.length ? keys[i] : undefined) ?? null;
  };
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(user), true, TOKEN_PROGRAM_ID).toBase58();
  const flowProgram = FLOW_PROGRAM[expect.kind];
  // SOL is wrapped only when SOL is the coin sold, and never more than is sold.
  const solSold = (mint: string, amount: string) => (mint === NATIVE_MINT.toBase58() ? big(amount) : 0n);
  const wrapCap = expect.kind === 'swap' ? solSold(expect.quote.inputMint, expect.quote.inAmount)
    : expect.kind === 'trigger-create' ? solSold(expect.inputMint, expect.makingAmount)
    : expect.kind === 'recurring-create' ? solSold(expect.inputMint, expect.inAmount)
    : 0n;

  let cuLimit: bigint | null = null;
  let cuPrice = 0n;
  let flowIxs = 0;
  let wrapped = 0n;
  for (const ix of m.compiledInstructions) {
    if (ix.programIdIndex >= keys.length) return 'it runs a program from a lookup table';
    const program = keys[ix.programIdIndex];
    const data = ix.data;

    if (program === COMPUTE_BUDGET) {
      if (data[0] === 2) {
        const limit = u32(data, 1);
        if (limit === null) return 'its compute limit could not be read';
        cuLimit = BigInt(limit);
      } else if (data[0] === 3) {
        const price = u64(data, 1);
        if (price === null) return 'its priority fee could not be read';
        cuPrice = price;
      } else if (data[0] !== 1 && data[0] !== 4) {
        return 'it sets an unknown compute budget';
      }
      continue;
    }

    if (program === SYSTEM) {
      // Only wrapping SOL into the user's own wrapped-SOL account. Not a durable
      // nonce (AdvanceNonceAccount, 4), not a payment anywhere else.
      if (u32(data, 0) !== 2) return 'it makes a system call other than wrapping SOL';
      if (at(ix, 0) !== user || at(ix, 1) !== wsolAta) return 'it sends SOL somewhere other than your own wrapped-SOL account';
      wrapped += u64(data, 4) ?? 0n;
      continue;
    }

    if (program === TOKEN || program === TOKEN_2022) {
      if (data[0] === 17 && data.length === 1) {
        if (at(ix, 0) !== wsolAta) return 'it syncs a token account that is not your wrapped-SOL account';
        continue;
      }
      if (data[0] === 9 && data.length === 1) {
        if (at(ix, 1) !== user || at(ix, 2) !== user) return 'it closes a token account into another wallet';
        continue;
      }
      // Approve, SetAuthority, Transfer, Burn and every other token call.
      return 'it makes a token call outside the trade (an approval, transfer or authority change)';
    }

    if (program === ATA) {
      if (!(data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1)))) return 'it makes an unknown token-account call';
      // The ATA program itself derives the address from the wallet, so this is the user's own account.
      if (at(ix, 0) !== user || at(ix, 2) !== user) return "it creates a token account that is not yours";
      continue;
    }

    if (program !== flowProgram) return 'it calls a program this trade does not use';
    flowIxs += 1;
    const why = flowRefusal(expect, ix, at, data);
    if (why) return why;
  }
  if (flowIxs !== 1) return flowIxs === 0 ? 'it does not contain the trade' : 'it contains more than one trade';
  if (wrapCap === null || wrapped > wrapCap) return 'it wraps more SOL than the trade sells';
  // Priority lamports = price (micro-lamports per unit) × units / 1e6, rounded up.
  const units = cuLimit ?? MAX_COMPUTE_UNITS;
  if ((cuPrice * units + 999_999n) / 1_000_000n > BigInt(expect.maxPriorityLamports)) return 'its priority fee is above the disclosed cap';
  return null;
}

type At = (ix: { accountKeyIndexes: number[] }, n: number) => string | null;

function flowRefusal(expect: JupiterTxExpectation, ix: { accountKeyIndexes: number[] }, at: At, data: Uint8Array): string | null {
  const disc = hex8(data);
  const user = expect.user;
  switch (expect.kind) {
    case 'swap': {
      // route_v2: 0 user_transfer_authority, 1 user_source_token_account,
      // 2 user_destination_token_account, 7 destination_token_account (the program id
      // when unused), args after the discriminator. shared_accounts_route_v2: 1 authority,
      // 2 source, 5 destination, and a one-byte id first. The venue's fee account is the
      // first account after the named ones (10, or 12), as every captured fee-bearing swap shows.
      const shared = disc === SHARED_ACCOUNTS_ROUTE_V2;
      if (!shared && disc !== ROUTE_V2) return 'it is a kind of Jupiter swap this site does not sign';
      const o = shared ? 9 : 8;
      const authority = at(ix, shared ? 1 : 0);
      const source = at(ix, shared ? 2 : 1);
      const destination = at(ix, shared ? 5 : 2);
      const override = shared ? null : at(ix, 7);
      if (authority !== user) return 'the swap is authorised by another wallet';
      if (!source || !usersAta(user, expect.quote.inputMint).has(source)) return 'the swap sells from an account that is not your account of the coin shown';
      if (!destination || !usersAta(user, expect.quote.outputMint).has(destination)) return 'the swap pays into an account that is not yours';
      if (!shared && override !== JUPITER_SWAP_PROGRAM && override !== destination) return 'the swap redirects what you receive';
      const inAmount = u64(data, o);
      const quotedOut = u64(data, o + 8);
      const slippage = u16(data, o + 16);
      const feeBps = u16(data, o + 18);
      const positiveSlippage = u16(data, o + 20);
      if (inAmount === null || inAmount !== big(expect.quote.inAmount)) return 'the swap sells a different amount than shown';
      if (quotedOut === null || quotedOut !== big(expect.quote.outAmount) || slippage !== expect.quote.slippageBps) {
        return 'the swap accepts a worse price than shown';
      }
      if (positiveSlippage !== 0) return 'the swap keeps part of a better fill';
      if (feeBps !== expect.feeBps) return 'the swap charges a different fee than the venue set';
      if (expect.feeBps > 0 && (!expect.feeAccount || at(ix, shared ? 12 : 10) !== expect.feeAccount)) {
        return "the swap pays the venue's fee to another account";
      }
      return null;
    }
    case 'trigger-create': {
      if (disc !== INITIALIZE_ORDER) return 'it is not a limit-order placement';
      if (at(ix, 0) !== user || at(ix, 1) !== user) return 'the order is placed for another wallet';
      if (at(ix, 7) !== expect.inputMint || at(ix, 8) !== expect.outputMint) return 'the order trades different coins than shown';
      const from = at(ix, 4);
      if (!from || !usersAta(user, expect.inputMint).has(from)) return 'the order is funded from an account that is not yours';
      if (u64(data, 16) !== big(expect.makingAmount) || u64(data, 24) !== big(expect.takingAmount)) return 'the order has different amounts than shown';
      return null;
    }
    case 'trigger-cancel': {
      if (disc !== CANCEL_ORDER && disc !== CANCEL_DUST_ORDER) return 'it is not a limit-order cancel';
      if (at(ix, 0) !== user || at(ix, 1) !== user || at(ix, 2) !== expect.order) return 'it cancels a different order';
      const mint = at(ix, 5);
      const refundTo = at(ix, 4);
      if (!mint || !refundTo || !usersAta(user, mint).has(refundTo)) return 'the refund goes to an account that is not yours';
      return null;
    }
    case 'recurring-create': {
      if (disc !== OPEN_DCA_V2) return 'it is not a recurring-buy placement';
      if (at(ix, 1) !== user || at(ix, 2) !== user) return 'the recurring buy is placed for another wallet';
      if (at(ix, 3) !== expect.inputMint || at(ix, 4) !== expect.outputMint) return 'the recurring buy trades different coins than shown';
      const from = at(ix, 5);
      if (!from || !usersAta(user, expect.inputMint).has(from)) return 'the recurring buy is funded from an account that is not yours';
      const total = big(expect.inAmount);
      const perCycle = total === null || expect.numberOfOrders <= 0 ? null : total / BigInt(expect.numberOfOrders);
      if (u64(data, 16) !== total || u64(data, 24) !== perCycle) return 'the recurring buy has different amounts than shown';
      const freq = data.length >= 40 ? new DataView(data.buffer, data.byteOffset + 32, 8).getBigInt64(0, true) : null;
      if (freq !== BigInt(expect.intervalSeconds)) return 'the recurring buy runs on a different schedule than shown';
      return null;
    }
    case 'recurring-cancel': {
      // close_dca: 0 user, 1 dca, 2 inputMint, 3 outputMint, 6 userInAta, 7 userOutAta.
      // withdraw:  0 user, 1 dca, 2 inputMint, 3 outputMint, 5 userInAta, 6 userOutAta.
      const close = disc === CLOSE_DCA;
      if (!close && disc !== DCA_WITHDRAW) return 'it is not a recurring-buy cancel';
      if (at(ix, 0) !== user || at(ix, 1) !== expect.order) return 'it cancels a different recurring buy';
      const inMint = at(ix, 2);
      const outMint = at(ix, 3);
      const inTo = at(ix, close ? 6 : 5);
      const outTo = at(ix, close ? 7 : 6);
      if (!inMint || !outMint || !inTo || !outTo || !usersAta(user, inMint).has(inTo) || !usersAta(user, outMint).has(outTo)) {
        return 'the refund goes to an account that is not yours';
      }
      return null;
    }
  }
}

/** The trade on screen as its test run is held to it: whose wallet, the coin sold, how much. */
export interface TradeShown { user: string; inputMint: string; inAmount: string }

/**
 * Rent for accounts a route opens that hold no coin (an exchange's own record of a wallet:
 * 1,346,200 lamports for PumpSwap's, read 2026-11-16), at most 0.005 SOL in one run.
 */
export const ROUTE_RENT_CAP_LAMPORTS = 5_000_000n;

type TokenRow = { accountIndex?: unknown; mint?: unknown; owner?: unknown; uiTokenAmount?: { amount?: unknown } };

/**
 * Why a test run that passed must not reach the wallet, from the payer's balances before and after
 * it (every account it loads, a lookup table's too), or null. Only the coin sold may end lower, by
 * no more than shown; SOL (the wallet and every token account it owns) also pays the network fee and
 * ROUTE_RENT_CAP_LAMPORTS at most. A coin's transfer fee needs no room: it is taken from what arrives.
 * Throws when the run gave no balances: no verdict. It trusts the site's RPC to answer honestly.
 */
export function balanceRefusal(
  run: { fee?: unknown; preBalances?: unknown; postBalances?: unknown; preTokenBalances?: unknown; postTokenBalances?: unknown },
  shown: TradeShown,
): string | null {
  const lamports = (list: unknown): bigint[] => {
    if (!Array.isArray(list) || list.length === 0) throw new Error('the test run gave no balances');
    return list.map((n: unknown) => {
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error('a balance could not be read');
      return BigInt(n);
    });
  };
  const pre = lamports(run.preBalances);
  const post = lamports(run.postBalances);
  const [fee] = lamports([run.fee]);
  const sold = big(shown.inAmount);
  if (pre.length !== post.length || fee === undefined || sold === null) throw new Error('the test run could not be read');
  const native = NATIVE_MINT.toBase58();
  // Every token account, the payer's (its wallet is account 0), and what they hold of each coin but SOL.
  const held = (rows: unknown) => {
    if (!Array.isArray(rows)) throw new Error('the test run gave no token balances');
    const tokens = new Set<number>();
    const accounts = new Set<number>([0]);
    const coins = new Map<string, bigint>();
    for (const r of rows as TokenRow[]) {
      const amount = typeof r?.uiTokenAmount?.amount === 'string' ? big(r.uiTokenAmount.amount) : null;
      const i = r?.accountIndex;
      if (typeof r?.owner !== 'string' || typeof r.mint !== 'string' || typeof i !== 'number' || !Number.isInteger(i) || i < 1 || i >= pre.length || amount === null) {
        throw new Error('a token balance could not be read');
      }
      tokens.add(i);
      if (r.owner !== shown.user) continue;
      accounts.add(i);
      if (r.mint !== native) coins.set(r.mint, (coins.get(r.mint) ?? 0n) + amount);
    }
    return { tokens, accounts, coins };
  };
  const before = held(run.preTokenBalances);
  const after = held(run.postTokenBalances);
  for (const mint of new Set([...before.coins.keys(), ...after.coins.keys()])) {
    const drop = (before.coins.get(mint) ?? 0n) - (after.coins.get(mint) ?? 0n);
    if (drop <= 0n) continue;
    if (mint !== shown.inputMint) return 'its test run takes a coin you are not selling';
    if (drop > sold) return 'its test run takes more than the amount shown';
  }
  let opened = 0n;
  for (let i = 1; i < pre.length; i += 1) if (pre[i] === 0n && post[i]! > 0n && !after.tokens.has(i)) opened += post[i]!;
  const rent = opened < ROUTE_RENT_CAP_LAMPORTS ? opened : ROUTE_RENT_CAP_LAMPORTS;
  const sum = (list: bigint[], at: Set<number>) => [...at].reduce((s, i) => s + list[i]!, 0n);
  const spent = sum(pre, before.accounts) - sum(post, after.accounts);
  if (spent > fee + rent + (shown.inputMint === native ? sold : 0n)) return 'its test run takes more than the amount shown';
  return null;
}
