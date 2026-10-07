// The Solana swap page in a real browser, end to end: the route line, the press that settles
// the venue again on fresh numbers, the review, the wallet's signature and the chain's answer.
// No network: /api/solrpc answers from accounts in the pool program's own layout (LP testkit),
// a swap worked out by its own sum here, never by the code under test. Jupiter, the pool index
// and prices are fixtures. The wallet signs in Node; its key never enters the page.
import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../src/lib/launcher/solana/curve/program';
import { associatedTokenAddress } from '../src/lib/launcher/solana/curve/ix';
import { IX_SWAP_BASE_INPUT, LIVE_PROGRAM_ID, decodeAmmConfig } from '../src/lib/solana/cpswap/program';
import { BAYLA_QUOTE } from '../src/lib/solana/lp/quotes';
import { PROGRAM as CPSWAP, buildPool, clockAccount, mintBytes, tokenAccountBytes, type BuiltPool } from '../src/lib/solana/lp/testkit.fixture';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
// Not the upgradeable loader, so the executable flag alone settles "deployed" (readDeployment).
const LOADER = 'BPFLoader2111111111111111111111111111111111';
const SYSTEM = SYSTEM_PROGRAM_ID.toBase58();
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const WALLET_NAME = 'E2E Test Wallet';
const OWN_SWAP_JUPITER_AHEAD = 'Jupiter pays more for this trade now.';
const BAYLA = new PublicKey(BAYLA_QUOTE.mint);
const SOL = WSOL_MINT.toBase58();
const NOW = 2_000_000_000n;
const SOL_RESERVE = 10n * 10n ** 9n;
const BAYLA_RESERVE = 1_000_000n * 10n ** 6n;
const AMOUNT_IN = 500_000_000n; // 0.5 SOL
const TIER1_RATE = 10_000n; // 1% a trade: configBytes' default, as the public tier
const rent = (size: number): number => (128 + size) * 6_960;

/** cp-swap's swap_base_input in words: a ceiling trade fee, then a floored constant product. */
function expectedOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, rate: bigint): bigint {
  const fee = (amountIn * rate + 999_999n) / 1_000_000n;
  const net = amountIn - fee;
  return (reserveOut * net) / (reserveIn + net);
}
const u64At = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const b64 = (d: Uint8Array) => Buffer.from(d).toString('base64');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** A transaction id as RPC nodes print it: its first signature in base58. */
function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}

interface Jup {
  /** What Jupiter's route pays before the site fee, or 'no-route' / 'down'. */
  gross: bigint | 'no-route' | 'down';
}

interface Acc { lamports: number; owner: string; data: Uint8Array; executable?: boolean }

interface World {
  accounts: Map<string, Acc>;
  me: Keypair;
  pool: BuiltPool;
  ownOut: bigint;
  jup: Jup;
  rpc: string[];
  sent: { signature: string; programs: string[] }[];
  signed: { programs: string[] }[];
  api: string[];
  errors: string[];
  /** The wallet says no, as a person pressing Cancel there. */
  decline?: boolean;
}

function amountAt(w: World, k: PublicKey): bigint | null {
  const a = w.accounts.get(k.toBase58());
  return a && a.data.length >= 72 ? u64At(a.data, 64) : null;
}

/** What the associated-token program charges to open `address` (testkit openAccount). */
function openAccount(w: World, address: PublicKey, size = 165): { paid: number; lamports: number } {
  const a = w.accounts.get(address.toBase58());
  if (!a) return { paid: rent(size), lamports: rent(size) };
  if (a.owner !== SYSTEM || a.data.length > 0) return { paid: 0, lamports: a.lamports };
  return { paid: Math.max(0, rent(size) - a.lamports), lamports: Math.max(a.lamports, rent(size)) };
}

type Change = { lamportsDelta?: number; tokenAmount?: bigint; mint?: PublicKey; owner?: PublicKey; closed?: boolean };

/** The accounts after a run: what is there, with the changes applied (testkit FakeChain.post). */
function post(w: World, addresses: string[], changes: Record<string, Change>): (Acc | null)[] {
  return addresses.map((addr) => {
    const cur = w.accounts.get(addr);
    const ch = changes[addr];
    if (ch?.closed) return null;
    if (!cur && !ch) return null;
    const lamports = (cur?.lamports ?? 0) + (ch?.lamportsDelta ?? 0);
    const data = ch?.tokenAmount !== undefined ? tokenAccountBytes(ch.mint ?? PublicKey.default, ch.owner ?? PublicKey.default, ch.tokenAmount) : (cur?.data ?? new Uint8Array(0));
    return { lamports: lamports || (ch?.tokenAmount !== undefined ? rent(165) : 0), owner: cur?.owner ?? ownerOfNew(w, addr), data };
  });
}

/** The swap worked out on the chain's own accounts (venueSwap.test.ts swapSimulator, for any wallet). */
function runSwap(w: World, vtx: VersionedTransaction) {
  const me = w.me.publicKey;
  const keys = vtx.message.staticAccountKeys;
  const ixs = vtx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex]!, accounts: ix.accountKeyIndexes.map((i) => keys[i]!), data: ix.data }));
  const sw = ixs.find((i) => i.program.equals(CPSWAP));
  if (!sw) return null;
  if (!IX_SWAP_BASE_INPUT.every((b, i) => sw.data[i] === b)) throw new Error('not swap_base_input');
  const amountIn = u64At(sw.data, 8);
  const minOut = u64At(sw.data, 16);
  const [, , cfgKey, , inAcc, outAcc, inVault, outVault, , , inMint, outMint] = sw.accounts;
  const cfg = decodeAmmConfig(cfgKey!.toBase58(), w.accounts.get(cfgKey!.toBase58())!.data)!;
  const out = expectedOut(amountIn, amountAt(w, inVault!)!, amountAt(w, outVault!)!, cfg.tradeFeeRate);
  const wsolAta = associatedTokenAddress(WSOL_MINT, me);
  const paidToOpen = ixs
    .filter((i) => i.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
    .reduce((n, i) => n + openAccount(w, i.accounts[1]!, i.accounts[5]!.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165).paid, 0);
  const wrapped = ixs.filter((i) => i.program.equals(SYSTEM_PROGRAM_ID)).reduce((n, i) => n + u64At(i.data, 4), 0n);
  const closes = ixs.some((i) => i.program.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9);
  const solIn = inMint!.equals(WSOL_MINT);
  const solOut = outMint!.equals(WSOL_MINT);
  const wsolLamportsAfter = BigInt(openAccount(w, wsolAta).lamports) + wrapped - (solIn ? amountIn : 0n) + (solOut ? out : 0n);
  const signerDelta = -wrapped - BigInt(paidToOpen) + (closes ? wsolLamportsAfter : 0n);
  const changes: Record<string, Change> = { [me.toBase58()]: { lamportsDelta: Number(signerDelta) } };
  const wsolBalance = (amountAt(w, wsolAta) ?? 0n) + wrapped - (solIn ? amountIn : 0n) + (solOut ? out : 0n);
  if (solIn || solOut) changes[wsolAta.toBase58()] = closes ? { closed: true } : { tokenAmount: wsolBalance, mint: WSOL_MINT, owner: me };
  if (!solIn) changes[inAcc!.toBase58()] = { tokenAmount: (amountAt(w, inAcc!) ?? 0n) - amountIn, mint: inMint!, owner: me };
  if (!solOut) changes[outAcc!.toBase58()] = { tokenAmount: (amountAt(w, outAcc!) ?? 0n) + out, mint: outMint!, owner: me };
  return { out, minOut, amountIn, changes, inVault: inVault!, outVault: outVault! };
}

function world(jup: Jup): World {
  const accounts = new Map<string, Acc>();
  accounts.set(CPSWAP.toBase58(), { lamports: 1, owner: LOADER, data: new Uint8Array(0), executable: true });
  // BAYLA as the venue holds it: a Token-2022 mint (no extensions here), paired with SOL on the public tier.
  accounts.set(BAYLA.toBase58(), { lamports: rent(82), owner: TOKEN_2022_PROGRAM_ID.toBase58(), data: mintBytes(null, 6) });
  accounts.set(SOL, { lamports: rent(82), owner: TOKEN_PROGRAM_ID.toBase58(), data: mintBytes(null, 9) });
  const pool = buildPool({ mint: BAYLA, configIndex: 1, quoteReserve: SOL_RESERVE, tokenReserve: BAYLA_RESERVE, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), openTime: 1n });
  for (const [k, a] of Object.entries(pool.accounts)) accounts.set(k, { lamports: a.lamports ?? rent(a.data.length), owner: a.owner, data: a.data });
  const clock = clockAccount(NOW);
  accounts.set('SysvarC1ock11111111111111111111111111111111', { lamports: 1, owner: clock.owner, data: clock.data });
  const me = Keypair.generate();
  accounts.set(me.publicKey.toBase58(), { lamports: 20 * 10 ** 9, owner: SYSTEM, data: new Uint8Array(0) });
  const ownOut = expectedOut(AMOUNT_IN, SOL_RESERVE, BAYLA_RESERVE, TIER1_RATE);
  return { accounts, me, pool, ownOut, jup, rpc: [], sent: [], signed: [], api: [], errors: [] };
}

/** The JSON an RPC node sends for an account. */
function accountJson(a: Acc | null | undefined) {
  if (!a) return null;
  return { data: [b64(a.data), 'base64'], executable: a.executable ?? false, lamports: a.lamports, owner: a.owner, rentEpoch: 0, space: a.data.length };
}

function ownerOfNew(w: World, address: string): string {
  if (address === w.me.publicKey.toBase58()) return SYSTEM;
  if (address === associatedTokenAddress(BAYLA, w.me.publicKey, TOKEN_2022_PROGRAM_ID).toBase58()) return TOKEN_2022_PROGRAM_ID.toBase58();
  return TOKEN_PROGRAM_ID.toBase58();
}

const isTokenProgram = (o: string) => o === TOKEN_PROGRAM_ID.toBase58() || o === TOKEN_2022_PROGRAM_ID.toBase58();

function tokenAccountsOf(w: World, owner: string, mint: string | null, programId: string | null) {
  const out: { pubkey: string; acc: Acc }[] = [];
  for (const [pubkey, acc] of w.accounts) {
    if (!isTokenProgram(acc.owner) || acc.data.length < 165) continue;
    if (new PublicKey(acc.data.subarray(32, 64)).toBase58() !== owner) continue;
    if (mint && new PublicKey(acc.data.subarray(0, 32)).toBase58() !== mint) continue;
    if (programId && acc.owner !== programId) continue;
    out.push({ pubkey, acc });
  }
  return out;
}

function parsedTokenAccount(acc: Acc) {
  const mint = new PublicKey(acc.data.subarray(0, 32)).toBase58();
  const amount = u64At(acc.data, 64);
  const decimals = mint === SOL ? 9 : 6;
  const ui = Number(amount) / 10 ** decimals;
  return {
    data: {
      program: acc.owner === TOKEN_2022_PROGRAM_ID.toBase58() ? 'spl-token-2022' : 'spl-token',
      parsed: {
        type: 'account',
        info: { isNative: mint === SOL, mint, owner: new PublicKey(acc.data.subarray(32, 64)).toBase58(), state: 'initialized', tokenAmount: { amount: amount.toString(), decimals, uiAmount: ui, uiAmountString: String(ui) } },
      },
      space: acc.data.length,
    },
    executable: false,
    lamports: acc.lamports,
    owner: acc.owner,
    rentEpoch: 0,
    space: acc.data.length,
  };
}

type Call = { id?: unknown; method?: string; params?: unknown[] };
const ctx = { slot: 600 };

function answer(w: World, c: Call): { result?: unknown; error?: unknown } {
  const p = c.params ?? [];
  const first = p[0];
  const cfg = (p[1] ?? {}) as Record<string, unknown>;
  switch (c.method) {
    case 'getGenesisHash':
      return { result: MAINNET_GENESIS };
    case 'getAccountInfo': {
      const a = w.accounts.get(String(first)) ?? null;
      if (cfg.encoding === 'jsonParsed' && a && a.data.length >= 165 && isTokenProgram(a.owner)) return { result: { context: ctx, value: parsedTokenAccount(a) } };
      return { result: { context: ctx, value: accountJson(a) } };
    }
    case 'getMultipleAccounts':
      return { result: { context: ctx, value: (first as string[]).map((k) => accountJson(w.accounts.get(k))) } };
    case 'getBalance':
      return { result: { context: ctx, value: w.accounts.get(String(first))?.lamports ?? 0 } };
    case 'getTokenAccountsByOwner': {
      const f = (p[1] ?? {}) as { mint?: string; programId?: string };
      const enc = ((p[2] ?? {}) as { encoding?: string }).encoding;
      const list = tokenAccountsOf(w, String(first), f.mint ?? null, f.programId ?? null);
      return { result: { context: ctx, value: list.map((t) => ({ pubkey: t.pubkey, account: enc === 'jsonParsed' ? parsedTokenAccount(t.acc) : accountJson(t.acc) })) } };
    }
    case 'getLatestBlockhash':
      return { result: { context: ctx, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 } } };
    case 'getBlockHeight':
      return { result: 10 };
    case 'getSlot':
      return { result: 600 };
    case 'getMinimumBalanceForRentExemption':
      return { result: rent(Number(first)) };
    case 'getRecentPrioritizationFees':
      return { result: [0, 0, 10_000, 20_000].map((f, i) => ({ slot: i + 1, prioritizationFee: f })) };
    case 'getFeeForMessage':
      return { result: { context: ctx, value: 5_000 } };
    case 'simulateTransaction': {
      const vtx = VersionedTransaction.deserialize(Buffer.from(String(first), 'base64'));
      const want = (cfg.accounts as { addresses?: string[] } | undefined)?.addresses;
      const run = runSwap(w, vtx);
      if (!run) return { result: { context: ctx, value: { err: null, logs: [`Program ${JUPITER} success`], accounts: null, unitsConsumed: 150_000, returnData: null } } };
      if (run.out < run.minOut) {
        return { result: { context: ctx, value: { err: { InstructionError: [4, { Custom: 6005 }] }, logs: [`Program ${CPSWAP.toBase58()} failed: custom program error: 0x1775`], accounts: null, unitsConsumed: 40_000, returnData: null } } };
      }
      const accounts = want ? post(w, want, run.changes).map(accountJson) : null;
      return { result: { context: ctx, value: { err: null, logs: [], accounts, unitsConsumed: 60_000, returnData: null } } };
    }
    case 'sendTransaction': {
      const vtx = VersionedTransaction.deserialize(Buffer.from(String(first), 'base64'));
      const signature = base58(vtx.signatures[0]!);
      const keys = vtx.message.staticAccountKeys;
      const programs = vtx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]!.toBase58());
      const run = runSwap(w, vtx);
      if (run) {
        // The chain moves: the wallet's side as the test run said, and the pool's vaults.
        const addrs = Object.keys(run.changes);
        post(w, addrs, run.changes).forEach((a, i) => (a ? w.accounts.set(addrs[i]!, a) : w.accounts.delete(addrs[i]!)));
        const vault = (k: PublicKey, d: bigint) => {
          const a = w.accounts.get(k.toBase58())!;
          const data = Uint8Array.from(a.data);
          new DataView(data.buffer).setBigUint64(64, u64At(a.data, 64) + d, true);
          w.accounts.set(k.toBase58(), { ...a, data });
        };
        vault(run.inVault, run.amountIn);
        vault(run.outVault, -run.out);
      }
      w.sent.push({ signature, programs });
      return { result: signature };
    }
    case 'getSignatureStatuses': {
      const sigs = first as string[];
      return { result: { context: ctx, value: sigs.map((s) => (w.sent.some((x) => x.signature === s) ? { slot: 599, confirmations: null, err: null, confirmationStatus: 'confirmed' } : null)) } };
    }
    case 'getTransaction':
      return { result: null };
    case 'getSignaturesForAddress':
      return { result: [] };
    default:
      return { error: { code: -32601, message: `fake chain: no ${c.method}` } };
  }
}

function quoteJson(w: World, url: URL) {
  const amount = url.searchParams.get('amount')!;
  const inputMint = url.searchParams.get('inputMint')!;
  const outputMint = url.searchParams.get('outputMint')!;
  const slippageBps = Number(url.searchParams.get('slippageBps'));
  const feeBps = url.searchParams.get('platformFeeBps');
  const gross = w.jup.gross as bigint;
  const fee = feeBps ? (gross * BigInt(feeBps)) / 10_000n : 0n;
  const out = gross - fee;
  return {
    inputMint,
    inAmount: amount,
    outputMint,
    outAmount: out.toString(),
    otherAmountThreshold: ((out * BigInt(10_000 - slippageBps)) / 10_000n).toString(),
    swapMode: 'ExactIn',
    slippageBps,
    platformFee: feeBps ? { amount: fee.toString(), feeBps: Number(feeBps) } : null,
    priceImpactPct: '0.0012',
    routePlan: [{ swapInfo: { ammKey: Keypair.generate().publicKey.toBase58(), label: 'Meteora DLMM', inputMint, outputMint, inAmount: amount, outAmount: gross.toString(), feeAmount: '0', feeMint: inputMint }, percent: 100 }],
    contextSlot: 600,
    timeTaken: 0.01,
  };
}

/** A transaction in Jupiter's place: one instruction of its program, the wallet paying. */
function jupiterTx(user: PublicKey): string {
  const ix = new TransactionInstruction({ programId: new PublicKey(JUPITER), keys: [{ pubkey: user, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) });
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: BLOCKHASH, instructions: [ix] }).compileToV0Message();
  return b64(new VersionedTransaction(msg).serialize());
}

async function serve(page: Page, w: World) {
  await page.route('**/api/solrpc', async (route: Route) => {
    let body: unknown = null;
    try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
    const calls = (Array.isArray(body) ? body : [body]) as Call[];
    const replies = calls.map((c) => {
      w.rpc.push(String(c?.method));
      const a = answer(w, c);
      if (a.error) w.errors.push(`rpc ${c?.method}: ${JSON.stringify(c?.params).slice(0, 200)}`);
      return { jsonrpc: '2.0', id: c?.id, ...a };
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? replies : replies[0]) });
  });
  await page.route('**/api/pools?**', async (route) => {
    const url = new URL(route.request().url());
    w.api.push(`pools ${url.search}`);
    const mint = url.searchParams.get('mint');
    const pools = mint === BAYLA.toBase58() ? [w.pool.address.toBase58()] : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mint, program: LIVE_PROGRAM_ID!.toBase58(), pools, truncated: false }) });
  });
  await page.route('**/api/jupiter/**', async (route) => {
    const url = new URL(route.request().url());
    w.api.push(`jupiter ${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/swap/v1/quote')) {
      if (w.jup.gross === 'no-route') return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No route', code: 'NO_ROUTE' }) });
      if (w.jup.gross === 'down') return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream"}' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(quoteJson(w, url)) });
    }
    if (url.pathname.endsWith('/swap/v1/swap')) {
      const body = route.request().postDataJSON() as { userPublicKey: string };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ swapTransaction: jupiterTx(new PublicKey(body.userPublicKey)), lastValidBlockHeight: 1_000 }) });
    }
    if (url.pathname.endsWith('/price/v3')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ [SOL]: { usdPrice: 150 }, [BAYLA.toBase58()]: { usdPrice: 0.0015 } }) });
    }
    if (url.pathname.includes('/shield')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ warnings: {} }) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

/** A Wallet Standard wallet that signs whatever it is handed, in Node, and records what. */
async function installWallet(context: BrowserContext, w: World) {
  await context.exposeBinding('__ownPoolE2eSign', async (_s, tx: string) => {
    const vt = VersionedTransaction.deserialize(Buffer.from(tx, 'base64'));
    const keys = vt.message.staticAccountKeys;
    if (w.decline) throw new Error('User rejected the request.');
    w.signed.push({ programs: vt.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]!.toBase58()) });
    vt.sign([w.me]);
    return b64(vt.serialize());
  });
  await context.addInitScript(
    ({ name, address, pk }) => {
      type Listener = (props: { accounts?: unknown[] }) => void;
      const listeners = new Set<Listener>();
      let connected = false;
      const enc = (u: Uint8Array) => { let s = ''; for (const c of u) s += String.fromCharCode(c); return btoa(s); };
      const dec = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      // The adapter names a localhost RPC's chain 'solana:localnet' (getChainForEndpoint), so the wallet claims all three, as e2e-solana's does.
      const chains = ['solana:mainnet', 'solana:devnet', 'solana:localnet'];
      const account = Object.freeze({ address, publicKey: new Uint8Array(pk), chains, features: ['solana:signTransaction'], label: name });
      const emit = () => { for (const l of listeners) l({ accounts: connected ? [account] : [] }); };
      const sign = (tx: string) => (window as unknown as Record<string, (a: string) => Promise<string>>).__ownPoolE2eSign(tx);
      const wallet = {
        version: '1.0.0',
        name,
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjM2I3YTU3Ii8+PC9zdmc+',
        chains,
        get accounts() { return connected ? [account] : []; },
        features: {
          'standard:connect': { version: '1.0.0', connect: async () => { connected = true; emit(); return { accounts: [account] }; } },
          'standard:disconnect': { version: '1.0.0', disconnect: async () => { connected = false; emit(); } },
          'standard:events': { version: '1.0.0', on: (event: string, l: Listener) => { if (event === 'change') listeners.add(l); return () => listeners.delete(l); } },
          'solana:signTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
              const outputs = [];
              for (const input of inputs) outputs.push({ signedTransaction: dec(await sign(enc(input.transaction))) });
              return outputs;
            },
          },
        },
      };
      const callback = ({ register }: { register: (x: unknown) => void }) => register(wallet);
      // The Wallet Standard registration event; a plain CustomEvent (a class with a private
      // field would need a helper Babel leaves out of the serialized script).
      window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback }));
      window.addEventListener('wallet-standard:app-ready', ((ev: CustomEvent) => callback(ev.detail)) as EventListener);
    },
    { name: WALLET_NAME, address: w.me.publicKey.toBase58(), pk: Array.from(w.me.publicKey.toBytes()) },
  );
}

async function open(page: Page, context: BrowserContext, w: World, width?: number) {
  page.on('pageerror', (e) => w.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') w.errors.push(`console: ${m.text().slice(0, 300)}`); });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch { /* private mode */ }
  });
  await installWallet(context, w);
  await serve(page, w);
  await context.addInitScript(() => {
    const seen: string[] = ((window as unknown as { __toasts: string[] }).__toasts = []);
    new MutationObserver(() => {
      for (const t of Array.from(document.querySelectorAll('[data-sonner-toast]'))) {
        const text = (t.textContent ?? '').trim();
        if (text && !seen.includes(text)) seen.push(text);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  if (width) await page.setViewportSize({ width, height: 900 });
  await page.goto(`/solana?out=${BAYLA.toBase58()}&amt=0.5`);
  const connect = page.getByRole('banner').getByRole('button', { name: 'Connect a Solana wallet' });
  await expect(connect).toBeVisible({ timeout: 30_000 });
  await connect.click();
  const list = page.getByRole('dialog', { name: /on Solana to continue/ });
  await list.getByRole('button', { name: new RegExp(WALLET_NAME) }).click();
  await expect(list).toHaveCount(0, { timeout: 15_000 });
}

// The wallet signs through a Playwright binding, as e2e-solana's does, and that suite runs on Chromium.
test.skip(({ browserName }) => browserName !== 'chromium', 'the signing wallet is checked in Chromium');

const routeLine = (page: Page) => page.getByTestId('solana-route-line');
const buy = (page: Page) => page.getByRole('button', { name: /^(Buy|Swap)\b/ }).first();
/** The fixture token list does not mark BAYLA verified, so the pair asks for the risk tick first. */
const ackRisk = async (page: Page) => {
  const ack = page.getByRole('checkbox', { name: /carries a risk warning/ });
  if (await ack.isVisible()) await ack.check();
};
const card = (page: Page) => page.getByRole('tabpanel', { name: 'Solana' });
const shot = (page: Page, name: string) => card(page).screenshot({ path: test.info().outputPath(`${name}.png`) });
// A failed resource is a font or image the sandbox cannot reach; a declined signature is the wallet adapter's own log.
const realErrors = (w: World) => w.errors.filter((e) => !e.startsWith('console: Failed to load resource') && !e.includes('WalletSignTransactionError: User rejected'));
const swapsBuilt = (w: World) => w.api.filter((a) => a.includes('/swap/v1/swap')).length;
const noFeeQuotes = (w: World) => w.api.filter((a) => a.includes('/swap/v1/quote') && !a.includes('platformFeeBps')).length;
const JUP_WINS = /Jupiter quotes [\d.]+% more than our pool, so Buy sends this trade to Jupiter\./;
const OWN_WINS = /Our pool quotes [\d.]+% more than Jupiter, so Buy sends it to our pool\./;

/** Sign the review in our pool and wait for the chain's answer. */
async function signOwn(page: Page) {
  await page.getByRole('button', { name: /Sign in wallet/ }).click();
  await expect(page.locator('[data-testid="tx-outcome"][data-status="confirmed"]')).toBeVisible({ timeout: 30_000 });
}
const toasts = (page: Page) => page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts);
const report = (w: World) => test.info().attach('world', { body: JSON.stringify({ rpc: [...new Set(w.rpc)], api: w.api, sent: w.sent, signed: w.signed, errors: w.errors }, null, 2), contentType: 'application/json' });

test('our pool pays more: the line says so, Buy reviews it in our pool, the wallet signs it and the chain confirms', async ({ page, context }) => {
  // Jupiter's route pays 47,000 BAYLA before the site fee; our pool about 47,165.
  const w = world({ gross: 47_000n * 10n ** 6n });
  await open(page, context, w);
  await expect(routeLine(page)).toContainText(OWN_WINS, { timeout: 30_000 });
  await shot(page, 'own-wins-line');
  await ackRisk(page);
  await buy(page).click();
  await expect(page.getByTestId('tx-review')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'own-wins-review');
  await expect(page.getByText('Review your swap in our pool')).toBeVisible();
  await signOwn(page);
  await expect(routeLine(page)).toHaveText('RouteWhat happened to this trade is below.');
  await shot(page, 'own-wins-confirmed');
  await report(w);
  expect(w.signed).toHaveLength(1);
  expect(w.signed[0]!.programs).toContain(CPSWAP.toBase58());
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]!.programs).toContain(CPSWAP.toBase58());
  // With no fee to drop, the fresh fee-bearing quote and its no-fee twin settle it: Jupiter builds nothing.
  expect(swapsBuilt(w)).toBe(0);
  const ata = associatedTokenAddress(BAYLA, w.me.publicKey, TOKEN_2022_PROGRAM_ID);
  expect(amountAt(w, ata)).toBe(w.ownOut);
  expect(realErrors(w)).toEqual([]);
});

test('Jupiter pays more: the line says so, and Buy sends the trade through Jupiter, never our pool', async ({ page, context }) => {
  const w = world({ gross: 50_000n * 10n ** 6n });
  await open(page, context, w);
  await expect(routeLine(page)).toContainText(JUP_WINS, { timeout: 30_000 });
  await shot(page, 'jupiter-wins-line');
  await ackRisk(page);
  await buy(page).click();
  await expect.poll(() => toasts(page), { timeout: 30_000 }).toContainEqual(expect.stringMatching(/^Bought BAYLA/));
  await report(w);
  expect(w.signed).toHaveLength(1);
  expect(w.signed[0]!.programs).toContain(JUPITER);
  expect(w.signed[0]!.programs).not.toContain(CPSWAP.toBase58());
  expect(w.sent.map((x) => x.programs.includes(JUPITER))).toEqual([true]);
  expect(realErrors(w)).toEqual([]);
});

test('Jupiter overtakes our pool between the screen and the press: nothing is signed, its quote is shown, the next press goes to Jupiter', async ({ page, context }) => {
  const w = world({ gross: 47_000n * 10n ** 6n });
  await open(page, context, w);
  await expect(routeLine(page)).toContainText(OWN_WINS, { timeout: 30_000 });
  await ackRisk(page);
  w.jup.gross = 50_000n * 10n ** 6n;
  await buy(page).click();
  await expect.poll(() => toasts(page), { timeout: 30_000 }).toContainEqual(expect.stringContaining(OWN_SWAP_JUPITER_AHEAD));
  await expect(routeLine(page)).toContainText(JUP_WINS);
  await shot(page, 'switch-at-press');
  expect(w.signed).toHaveLength(0);
  expect(w.sent).toHaveLength(0);
  await ackRisk(page);
  await buy(page).click();
  await expect.poll(() => toasts(page), { timeout: 30_000 }).toContainEqual(expect.stringMatching(/^Bought BAYLA/));
  await report(w);
  expect(w.signed.map((x) => x.programs.includes(JUPITER))).toEqual([true]);
  expect(realErrors(w)).toEqual([]);
});

test('a close call: our pool beats Jupiter only by less than the site fee, so the press asks Jupiter what it would really send, then reviews our pool', async ({ page, context }) => {
  // 47,400 before a 1% site fee is 46,926 after it; our pool pays 47,165: ahead of the
  // fee-bearing quote, behind the fee-free one. A build that takes no site fee (CI's) has
  // no close call: our pool is plainly behind, and Buy goes to Jupiter.
  const w = world({ gross: 47_400n * 10n ** 6n });
  await open(page, context, w);
  await expect(routeLine(page)).toContainText(/so Buy sends|Buy asks Jupiter again first/, { timeout: 30_000 });
  const feeOn = w.api.some((a) => a.includes('platformFeeBps='));
  if (!feeOn) {
    await expect(routeLine(page)).toContainText(JUP_WINS);
    return;
  }
  await expect(routeLine(page)).toContainText(/which includes this site's fee\. Buy asks Jupiter again first: if Jupiter would pay more, nothing is sent and its quote is shown\./);
  await shot(page, 'close-call-line');
  await ackRisk(page);
  const before = noFeeQuotes(w);
  await buy(page).click();
  await expect(page.getByText('Review your swap in our pool')).toBeVisible({ timeout: 30_000 });
  // The press asked the no-fee quote, found it ahead, and so built and test-ran Jupiter's own transaction.
  expect(noFeeQuotes(w)).toBe(before + 1);
  expect(swapsBuilt(w)).toBe(1);
  await signOwn(page);
  await report(w);
  expect(w.signed.map((x) => x.programs.includes(CPSWAP.toBase58()))).toEqual([true]);
  expect(realErrors(w)).toEqual([]);
});

test('Jupiter has no route: our pool takes the trade', async ({ page, context }) => {
  const w = world({ gross: 'no-route' });
  await open(page, context, w);
  await expect(routeLine(page)).toContainText('Jupiter has no route for this trade, and our pool quotes it, so Buy sends it to our pool.', { timeout: 30_000 });
  await ackRisk(page);
  await buy(page).click();
  await expect(page.getByText('Review your swap in our pool')).toBeVisible({ timeout: 30_000 });
  await signOwn(page);
  await report(w);
  expect(w.sent.map((x) => x.programs.includes(CPSWAP.toBase58()))).toEqual([true]);
  expect(realErrors(w)).toEqual([]);
});

test('Jupiter cannot be asked: our quote is not taken on trust, and nothing can be sent', async ({ page, context }) => {
  const w = world({ gross: 'down' });
  await open(page, context, w);
  await expect(routeLine(page)).toContainText("Jupiter could not be asked for a quote just now, so our pool's quote cannot be checked against it. Nothing is sent until it can.", { timeout: 30_000 });
  await shot(page, 'jupiter-down-line');
  await ackRisk(page);
  await expect(page.getByRole('button', { name: 'Quote unavailable' })).toBeDisabled();
  await report(w);
  expect(w.signed).toHaveLength(0);
  expect(realErrors(w)).toEqual([]);
});

test('the wallet says no: nothing is sent, and the form is the person\'s again', async ({ page, context }) => {
  const w = world({ gross: 47_000n * 10n ** 6n });
  await open(page, context, w);
  await expect(routeLine(page)).toContainText(OWN_WINS, { timeout: 30_000 });
  await ackRisk(page);
  await buy(page).click();
  await expect(page.getByText('Review your swap in our pool')).toBeVisible({ timeout: 30_000 });
  w.decline = true;
  await page.getByRole('button', { name: /Sign in wallet/ }).click();
  await expect(page.locator('[data-testid="tx-outcome"][data-status="not-sent"]')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'wallet-declined');
  expect(w.sent).toHaveLength(0);
  // Back to the form: the amount can be edited and Buy offers our pool again.
  const back = page.getByRole('button', { name: /^(Back|Done|Close|Start over|Try again)/ }).first();
  if (await back.isVisible()) await back.click();
  await expect(page.getByRole('textbox', { name: 'Amount of SOL to pay' })).toBeEditable({ timeout: 15_000 });
  await expect(routeLine(page)).toContainText(OWN_WINS, { timeout: 30_000 });
  await report(w);
  expect(realErrors(w)).toEqual([]);
});

for (const width of [360, 320]) {
  test(`on a ${width}px phone, the review of a swap in our pool breaks no amount in the middle`, async ({ page, context }) => {
    const w = world({ gross: 47_000n * 10n ** 6n });
    await open(page, context, w, width);
    await expect(routeLine(page)).toContainText(OWN_WINS, { timeout: 30_000 });
    await ackRisk(page);
    await buy(page).click();
    const review = page.getByTestId('tx-review');
    await expect(review).toBeVisible({ timeout: 30_000 });
    await review.screenshot({ path: test.info().outputPath(`review-${width}.png`) });
    // Every place a line wraps inside the review's text: a wrap between two characters of one figure is a split amount.
    const splits = await review.evaluate((root) => {
      const out: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent ?? '';
        let lastTop: number | null = null;
        for (let i = 0; i < text.length; i++) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          const rect = r.getClientRects()[0];
          if (!rect) continue;
          if (lastTop !== null && rect.top > lastTop + 2 && /[\d.,]/.test(text[i - 1] ?? '') && /[\d.,]/.test(text[i]!)) out.push(`${text.slice(Math.max(0, i - 12), i)}|${text.slice(i, i + 12)}`);
          lastTop = rect.top;
        }
      }
      return out;
    });
    expect(splits).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await report(w);
    expect(realErrors(w)).toEqual([]);
  });
}
