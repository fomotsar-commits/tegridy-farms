// @vitest-environment node
//
// Discovery reads what ANYONE can write. Pinned here:
//   - token details decode strips padding, and a wrong owner / wrong mint is refused;
//   - the launch list keeps only SUCCESSFUL, TOP-LEVEL create_launch transactions on
//     the configured program, re-checks each curve (owner, mint, creator), keeps
//     "could not read" apart from zero, and says how many entries it looked at;
//   - the graduated pool is the one the curve records, and every field must match
//     what graduation writes: a pool squatted at the standard address is refused.
import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  IX_DISCRIMINATOR,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  curvePda,
  curveVaultPda,
  poolStatePda,
} from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import type { SolanaRpc } from '../curve/rpc';
import {
  ACCOUNT_POOL_STATE,
  POOL_STATE_LEN,
  POOL_STATE_OFFSETS,
  deriveLpMint,
  deriveObservation,
  deriveVault,
  derivePool,
  sortMints,
} from '../../../solana/cpswap/program';
import { launchIndexAddress } from '../write/config';
import { createLaunchInstructions } from '../write/launch';
import { METAPLEX_TOKEN_METADATA_ID, metadataPda } from '../write/metaplex';
import { BAYLA_MINT, WORKSHOP_BAYLA_ACCOUNT, WORKSHOP_WALLET, baylaAccountOf } from '../write/plant';
import {
  AMM_CONFIG,
  BLOCKHASH,
  CPSWAP,
  FakeChain,
  LAUNCH,
  MAKER_BAYLA,
  WORKSHOP_BAYLA,
  cfgLocal,
  encodeCurve,
  freshCurve,
  globalValue,
  rent,
  u64le,
} from '../write/testkit.fixture';
import { makerBuyFromOrigin } from '../../../../components/solana/curve/facts';
import type { OpenGate } from '../write/types';
import { decodeTokenMetadata, readTokenMetadata } from './metadata';
import {
  HIDDEN_MINTS,
  LIST_PAGE_SIZE,
  fromBase58,
  fullyDilutedValueLamports,
  listLaunchesByCreator,
  listRecentLaunches,
  parseLaunchTransaction,
  readCreatorHolding,
  readLaunchOrigin,
  shareBps,
} from './list';
import { readLaunchPool } from './pool';

// ── token details ────────────────────────────────────────────────────────────

function metadataAccount(mint: PublicKey, o: { name: string; symbol: string; uri: string; mutable?: boolean; ua?: PublicKey }): Uint8Array {
  const str = (s: string, pad: number) => {
    const b = Buffer.alloc(pad);
    Buffer.from(s, 'utf8').copy(b);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(pad);
    return Buffer.concat([len, b]);
  };
  return Uint8Array.from(Buffer.concat([
    Buffer.from([4]),
    (o.ua ?? mint).toBuffer(),
    mint.toBuffer(),
    str(o.name, 32),
    str(o.symbol, 10),
    str(o.uri, 200),
    Buffer.from([0, 0]), // sfbp
    Buffer.from([0]), // creators None
    Buffer.from([0]), // primary sale
    Buffer.from([o.mutable ? 1 : 0]),
    Buffer.from([1, 255, 1, 2]), // edition nonce, token standard … (ignored)
  ]));
}

describe('token details', () => {
  const MINT = Keypair.generate().publicKey;
  it('decodes and strips the NUL padding Metaplex stores', () => {
    const d = decodeTokenMetadata(metadataAccount(MINT, { name: 'Tegridy \u{1F33F}', symbol: 'TGD', uri: 'https://ipfs.io/ipfs/x' }), MINT);
    expect(d.ok && d.value).toMatchObject({ name: 'Tegridy \u{1F33F}', symbol: 'TGD', uri: 'https://ipfs.io/ipfs/x', isMutable: false });
  });
  it('reports editable details so the page can warn', () => {
    const d = decodeTokenMetadata(metadataAccount(MINT, { name: 'A', symbol: 'B', uri: 'u', mutable: true }), MINT);
    expect(d.ok && d.value.isMutable).toBe(true);
  });
  it('another token’s details are refused', () => {
    expect(decodeTokenMetadata(metadataAccount(Keypair.generate().publicKey, { name: 'A', symbol: 'B', uri: 'u' }), MINT).ok).toBe(false);
  });
  it('read: absent / wrong owner / unreadable are three different answers', async () => {
    const chain = new FakeChain();
    expect((await readTokenMetadata(chain, MINT)).kind).toBe('absent');
    chain.set(metadataPda(MINT), { lamports: 1, owner: Keypair.generate().publicKey, data: metadataAccount(MINT, { name: 'A', symbol: 'B', uri: 'u' }) });
    expect(await readTokenMetadata(chain, MINT)).toEqual({ kind: 'undecodable', reason: 'wrong-discriminator' });
    chain.set(metadataPda(MINT), { lamports: 1, owner: METAPLEX_TOKEN_METADATA_ID, data: metadataAccount(MINT, { name: 'A', symbol: 'B', uri: 'u' }) });
    expect((await readTokenMetadata(chain, MINT)).kind).toBe('ok');
    chain.getAccountInfo = async () => {
      throw new Error('down');
    };
    expect((await readTokenMetadata(chain, MINT)).kind).toBe('unreadable');
  });
});

// ── the launch list ──────────────────────────────────────────────────────────

const gate = { kind: 'open', cfg: cfgLocal, global: globalValue(), paused: false } as unknown as OpenGate;
const INDEX = launchIndexAddress(LAUNCH);

interface Launch {
  sig: string;
  creator: Keypair;
  mint: Keypair;
  buyTokens?: bigint | 'unreadable';
  /** Tokens another account received in the same transaction (a second wallet, or a buy through another program). */
  otherBought?: bigint;
  /** The wallet that owns the account `otherBought` lands in. Defaults to a fresh one. */
  otherOwner?: PublicKey;
  /** $BAYLA balances the RPC reports for this transaction (null = not in that list). */
  bayla?: BaylaEntry[];
  /** The record came back without its "before" balances. */
  noPre?: boolean;
  /** The RPC left the owner off the launch token's balances. */
  noOwner?: boolean;
  programId?: PublicKey;
  failed?: boolean;
  /** Who the config named as fee recipient when this launch was created. Defaults to the fixture's. */
  feeRecipient?: PublicKey;
  /** The RPC's record of create_launch's own calls: reported (default), or left out. */
  innerCalls?: 'reported' | 'missing';
}

interface BaylaEntry {
  account: PublicKey;
  owner: PublicKey;
  pre: bigint | null;
  post: bigint | null;
  /** The token program the RPC names for the account. Defaults to Token-2022, as on chain; null = left off. */
  programId?: PublicKey | null;
  amount?: string;
}

/** The platform reserve every fixture launch pays: 3.69% of the 1e15 supply. */
const RESERVE = 36_900_000_000_000n;
/** What the fixture's curve vault holds after the launch. */
const VAULT_AFTER = 900_000_000_000_000n;

/** Whole $BAYLA in base units (6 decimals). */
const B = (n: bigint) => n * 1_000_000n;

/** The plant as this site builds it: 50,000 burned from the maker's account and 50,000 to the Workshop's. */
function plantBalances(maker: PublicKey, burned = B(50_000n), toWorkshop = B(50_000n)): BaylaEntry[] {
  return [
    { account: baylaAccountOf(maker), owner: maker, pre: MAKER_BAYLA, post: MAKER_BAYLA - burned - toWorkshop },
    { account: WORKSHOP_BAYLA_ACCOUNT, owner: WORKSHOP_WALLET, pre: WORKSHOP_BAYLA, post: WORKSHOP_BAYLA + toWorkshop },
  ];
}

/** Bytes to base58, as the RPC encodes an inner instruction's data. */
function toBase58(bytes: Uint8Array): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = A[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}

function launchTx(l: Launch): unknown {
  const fee = l.feeRecipient ?? gate.global.feeRecipient;
  const ixs = createLaunchInstructions(
    { ...gate, cfg: { ...cfgLocal, programId: l.programId ?? LAUNCH } } as OpenGate,
    { creator: l.creator.publicKey, mint: l.mint, metadata: { name: 'N', symbol: 'SS', uri: 'https://ipfs.io/ipfs/x' } },
    rent(82),
    l.buyTokens !== undefined ? { maxLamportsIn: 1_000n, minTokensOut: 1n } : null,
    fee,
  );
  const tx = new Transaction({ feePayer: l.creator.publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 1 }).add(...ixs);
  const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  // Token balances as the RPC reports them: the curve vault is always there (create_launch
  // fills it); 'unreadable' = the record came back without them.
  const keys = tx.compileMessage().accountKeys;
  const m58 = l.mint.publicKey.toBase58();
  const program = l.programId ?? LAUNCH;
  const at = (k: PublicKey) => keys.findIndex((x) => x.equals(k));
  const entry = (accountIndex: number, owner: PublicKey, amount: bigint) => ({
    accountIndex,
    mint: m58,
    ...(l.noOwner ? {} : { owner: owner.toBase58() }),
    uiTokenAmount: { amount: amount.toString() },
  });
  const post: unknown[] = [];
  const pre: unknown[] = [];
  const writable: string[] = [];
  const vault = curveVaultPda(l.mint.publicKey, program);
  const treasuryToken = associatedTokenAddress(l.mint.publicKey, fee);
  const creatorAta = associatedTokenAddress(l.mint.publicKey, l.creator.publicKey);
  // $BAYLA is a Token-2022 mint: the RPC names that program on each of its balances.
  for (const b of l.bayla ?? []) {
    const index = at(b.account);
    if (index < 0) throw new Error('fixture: that $BAYLA account is not in the transaction');
    const e = (amount: bigint) => ({
      accountIndex: index,
      mint: BAYLA_MINT.toBase58(),
      owner: b.owner.toBase58(),
      ...(b.programId === null ? {} : { programId: (b.programId ?? TOKEN_2022_PROGRAM_ID).toBase58() }),
      uiTokenAmount: { amount: b.amount ?? amount.toString() },
    });
    if (b.pre !== null) pre.push(e(b.pre));
    if (b.post !== null) post.push(e(b.post));
  }
  if (l.buyTokens !== 'unreadable') {
    post.push(entry(at(vault), curvePda(l.mint.publicKey, program), VAULT_AFTER));
    // create_launch pays the platform reserve to the treasury's token account in the same
    // instruction. When the treasury's own wallet launches and buys, its buy lands there too.
    const sameAccount = creatorAta.equals(treasuryToken);
    const bought = typeof l.buyTokens === 'bigint' ? l.buyTokens : 0n;
    post.push(entry(at(treasuryToken), fee, RESERVE + (sameAccount ? bought : 0n)));
    if (l.buyTokens !== undefined && !sameAccount) {
      post.push(entry(at(creatorAta), l.creator.publicKey, l.buyTokens));
    }
    if (l.otherBought !== undefined) {
      const other = l.otherOwner ?? Keypair.generate().publicKey;
      writable.push(associatedTokenAddress(l.mint.publicKey, other).toBase58());
      post.push(entry(keys.length, other, l.otherBought));
    }
  }
  // create_launch's own calls to the token program: mint the supply to the vault, then
  // pay the reserve from the vault to the treasury's token account.
  const createIndex = ixs.findIndex(
    (i) => i.programId.equals(program) && Buffer.from(i.data.subarray(0, 8)).equals(Buffer.from(IX_DISCRIMINATOR.createLaunch)),
  );
  const tokenCall = (tag: number, amount: bigint, accounts: PublicKey[]) => ({
    programIdIndex: at(TOKEN_PROGRAM_ID),
    accounts: accounts.map(at),
    data: toBase58(Uint8Array.from([tag, ...u64le(amount)])),
  });
  const innerInstructions =
    l.innerCalls === 'missing'
      ? null
      : [
          {
            index: createIndex,
            instructions: [
              tokenCall(7, 1_000_000_000_000_000n, [l.mint.publicKey, vault, l.creator.publicKey]),
              tokenCall(3, RESERVE, [vault, treasuryToken, curvePda(l.mint.publicKey, program)]),
            ],
          },
        ];
  return {
    blockTime: 1_700_000_000,
    meta: {
      err: l.failed ? { InstructionError: [0, 'Custom'] } : null,
      preTokenBalances: l.noPre ? null : pre,
      postTokenBalances: post,
      loadedAddresses: { writable, readonly: [] },
      innerInstructions,
    },
    transaction: [raw, 'base64'],
  };
}

function noiseTx(from: Keypair): unknown {
  // Only MENTIONS the index address (anyone can do this for ~5,000 lamports).
  const ix = SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: from.publicKey, lamports: 1 });
  ix.keys.push({ pubkey: INDEX, isSigner: false, isWritable: false });
  const tx = new Transaction({ feePayer: from.publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 1 }).add(ix);
  return {
    blockTime: 1,
    meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
    transaction: [tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), 'base64'],
  };
}

class FakeJsonRpc {
  sigs = new Map<string, Array<{ signature: string; err: unknown; blockTime: number }>>();
  txs = new Map<string, unknown>();
  accounts = new Map<string, { data: Uint8Array; owner: PublicKey; lamports: number }>();
  calls: string[] = [];
  fail = new Set<string>();
  rpc: SolanaRpc = async (method, params) => {
    this.calls.push(method);
    if (this.fail.has(method)) throw new Error(`${method} down`);
    if (method === 'getSignaturesForAddress') {
      const [addr, opts] = params as [string, { limit: number; before?: string }];
      const all = this.sigs.get(addr) ?? [];
      const start = opts.before ? all.findIndex((s) => s.signature === opts.before) + 1 : 0;
      return all.slice(start, start + opts.limit);
    }
    if (method === 'getTransaction') return this.txs.get((params as [string])[0]) ?? null;
    if (method === 'getMultipleAccounts') {
      const keys = (params as [string[]])[0];
      return {
        context: { slot: 1 },
        value: keys.map((k) => {
          const a = this.accounts.get(k);
          return a ? { data: [Buffer.from(a.data).toString('base64'), 'base64'], owner: a.owner.toBase58(), lamports: a.lamports, executable: false } : null;
        }),
      };
    }
    throw new Error(`unexpected ${method}`);
  };
  index(address: PublicKey, entries: Array<{ sig: string; tx: unknown; err?: unknown }>) {
    this.sigs.set(address.toBase58(), entries.map((e) => ({ signature: e.sig, err: e.err ?? null, blockTime: 1 })));
    for (const e of entries) this.txs.set(e.sig, e.tx);
  }
  curve(mint: PublicKey, creator: PublicKey, owner: PublicKey = LAUNCH) {
    this.accounts.set(curvePda(mint, LAUNCH).toBase58(), { data: encodeCurve(freshCurve(mint, creator)), owner, lamports: rent(179) });
  }
}

const sig = (n: number) => `sig${n}`.padEnd(88, '1');

describe('parseLaunchTransaction', () => {
  it('a real create with an opening buy: creator, mint, the tokens the creator got', () => {
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), buyTokens: 12_345n };
    const o = parseLaunchTransaction(launchTx(l), l.sig, LAUNCH);
    expect(o?.creator.equals(l.creator.publicKey)).toBe(true);
    expect(o?.mint.equals(l.mint.publicKey)).toBe(true);
    expect(o?.openingBuyTokens).toBe(12_345n);
  });
  it('no opening buy = 0 (a real finding); a buy whose amount is missing = null (could not read)', () => {
    const a: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    expect(parseLaunchTransaction(launchTx(a), a.sig, LAUNCH)?.openingBuyTokens).toBe(0n);
    const b: Launch = { ...a, buyTokens: 'unreadable' };
    expect(parseLaunchTransaction(launchTx(b), b.sig, LAUNCH)?.openingBuyTokens).toBeNull();
  });
  // F3: counted from the token balances, so a buy we do not recognise as a top-level
  // creator buy (through another program, or from a second wallet bundled into the
  // launch) is still counted, never shown as a real-looking 0.
  it('counts tokens ANY wallet got in the launch transaction, not only a top-level creator buy', () => {
    const wrapped: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), otherBought: 500n };
    expect(parseLaunchTransaction(launchTx(wrapped), wrapped.sig, LAUNCH)?.openingBuyTokens).toBe(500n);
    const both: Launch = { ...wrapped, buyTokens: 12_345n };
    expect(parseLaunchTransaction(launchTx(both), both.sig, LAUNCH)?.openingBuyTokens).toBe(12_845n);
  });
  // Reserve at create (2026-09-26): the treasury's 3.69% arrives in the launch
  // transaction too. It is the platform reserve, not anyone's opening buy.
  it('the platform reserve paid to the treasury is not counted as bought in the launch', () => {
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    const t = launchTx(l) as { meta: { postTokenBalances: Array<{ owner: string }> } };
    expect(t.meta.postTokenBalances.some((b) => b.owner === gate.global.feeRecipient.toBase58())).toBe(true);
    expect(parseLaunchTransaction(t, l.sig, LAUNCH)?.openingBuyTokens).toBe(0n);
    const withBuy: Launch = { ...l, buyTokens: 12_345n };
    expect(parseLaunchTransaction(launchTx(withBuy), withBuy.sig, LAUNCH)?.openingBuyTokens).toBe(12_345n);
  });
  // When the treasury's own wallet launches and buys, its buy and the reserve land in
  // ONE token account. Only the reserve is taken off; the buy still counts.
  it('the treasury wallet launching with a buy: the buy counts, the reserve does not', () => {
    const treasury = Keypair.generate();
    const l: Launch = { sig: sig(1), creator: treasury, mint: Keypair.generate(), feeRecipient: treasury.publicKey, buyTokens: 12_345n };
    const o = parseLaunchTransaction(launchTx(l), l.sig, LAUNCH);
    expect(o?.openingBuyTokens).toBe(12_345n);
    expect(parseLaunchTransaction(launchTx({ ...l, buyTokens: undefined }), l.sig, LAUNCH)?.openingBuyTokens).toBe(0n);
  });
  it('the reserve is read from create_launch itself: not reported = "could not read", never a guess', () => {
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), buyTokens: 12_345n, innerCalls: 'missing' };
    expect(parseLaunchTransaction(launchTx(l), l.sig, LAUNCH)?.openingBuyTokens).toBeNull();
  });
  // update_global can change fee_recipient after a launch. Who was paid is the fee
  // recipient in the launch's own create_launch, never today's config.
  it("records who received the reserve from the launch's own transaction", () => {
    const then = Keypair.generate().publicKey;
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), feeRecipient: then };
    const o = parseLaunchTransaction(launchTx(l), l.sig, LAUNCH);
    expect(o?.reserveRecipient?.equals(then)).toBe(true);
    expect(o?.reserveRecipient?.equals(gate.global.feeRecipient)).toBe(false);
  });
  it('reads base58 the way the RPC writes it, leading zero bytes included', () => {
    const k = Keypair.generate().publicKey;
    expect(Buffer.from(fromBase58(k.toBase58()) ?? []).equals(Buffer.from(k.toBytes()))).toBe(true);
    expect(Array.from(fromBase58(toBase58(Uint8Array.from([0, 0, 3, 1]))) ?? [])).toEqual([0, 0, 3, 1]);
    expect(fromBase58('0OIl')).toBeNull();
  });
  it('balances that do not include the curve vault are "could not read", never 0', () => {
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    const t = launchTx(l) as { meta: { postTokenBalances: unknown[] | null } };
    t.meta.postTokenBalances = [];
    expect(parseLaunchTransaction(t, l.sig, LAUNCH)?.openingBuyTokens).toBeNull();
    t.meta.postTokenBalances = null;
    expect(parseLaunchTransaction(t, l.sig, LAUNCH)?.openingBuyTokens).toBeNull();
  });
  it('refuses failed transactions, other programs and mere mentions', () => {
    const base: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    expect(parseLaunchTransaction(launchTx({ ...base, failed: true }), base.sig, LAUNCH)).toBeNull();
    expect(parseLaunchTransaction(launchTx({ ...base, programId: Keypair.generate().publicKey }), base.sig, LAUNCH)).toBeNull();
    expect(parseLaunchTransaction(noiseTx(base.creator), base.sig, LAUNCH)).toBeNull();
    expect(parseLaunchTransaction(null, base.sig, LAUNCH)).toBeNull();
  });
});

// Ruling 3 (2026-10-01): every launch page shows the maker's create-buy as a share of
// the supply, with the wallet, and whether its launch transaction carried the plant.
// All of it is read from the launch transaction's own token balances.
describe("the maker's plates, read from the launch transaction", () => {
  const byOwner = (o: ReturnType<typeof parseLaunchTransaction>) =>
    o?.boughtByOwner ? Object.fromEntries(o.boughtByOwner.map((b) => [b.owner.toBase58(), b.tokens])) : null;

  it('two wallets got tokens in the launch transaction: each is kept apart, and the maker figure counts only the maker', () => {
    const other = Keypair.generate().publicKey;
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), buyTokens: 12_345n, otherBought: 500n, otherOwner: other };
    const o = parseLaunchTransaction(launchTx(l), l.sig, LAUNCH);
    expect(byOwner(o)).toEqual({ [l.creator.publicKey.toBase58()]: 12_345n, [other.toBase58()]: 500n });
    // The any-wallet total is unchanged.
    expect(o?.openingBuyTokens).toBe(12_845n);
    const maker = makerBuyFromOrigin({ kind: 'ok', value: o! }, l.creator.publicKey);
    expect(maker).toEqual({
      kind: 'ok',
      value: { tokens: 12_345n, othersTokens: 500n, others: 1, birthSupply: VAULT_AFTER + RESERVE + 12_845n },
    });
  });

  it("a maker's buy split over two of its own accounts is still the maker's", () => {
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), buyTokens: 12_345n, otherBought: 500n };
    l.otherOwner = l.creator.publicKey;
    const o = parseLaunchTransaction(launchTx(l), l.sig, LAUNCH);
    expect(byOwner(o)).toEqual({ [l.creator.publicKey.toBase58()]: 12_845n });
    const maker = makerBuyFromOrigin({ kind: 'ok', value: o! }, l.creator.publicKey);
    expect(maker.kind === 'ok' && maker.value).toMatchObject({ tokens: 12_845n, othersTokens: 0n, others: 0 });
  });

  it("the platform reserve is nobody's buy: the treasury wallet launching with a buy is its buy only", () => {
    const treasury = Keypair.generate();
    const l: Launch = { sig: sig(1), creator: treasury, mint: Keypair.generate(), feeRecipient: treasury.publicKey, buyTokens: 12_345n };
    expect(byOwner(parseLaunchTransaction(launchTx(l), l.sig, LAUNCH))).toEqual({ [treasury.publicKey.toBase58()]: 12_345n });
    const none: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    expect(byOwner(parseLaunchTransaction(launchTx(none), none.sig, LAUNCH))).toEqual({});
  });

  it('a balance with no owner, or balances that cannot be read: the per-wallet figure is "could not read", never 0', () => {
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), buyTokens: 12_345n, noOwner: true };
    const o = parseLaunchTransaction(launchTx(l), l.sig, LAUNCH);
    expect(o?.boughtByOwner).toBeNull();
    expect(makerBuyFromOrigin({ kind: 'ok', value: o! }, l.creator.publicKey).kind).toBe('unreadable');
    const gone: Launch = { ...l, noOwner: false, buyTokens: 'unreadable' };
    expect(parseLaunchTransaction(launchTx(gone), gone.sig, LAUNCH)?.boughtByOwner).toBeNull();
    const noReserve: Launch = { ...l, noOwner: false, innerCalls: 'missing' };
    expect(parseLaunchTransaction(launchTx(noReserve), noReserve.sig, LAUNCH)?.boughtByOwner).toBeNull();
  });

  it("the supply at birth is the sum of the mint's balances after the launch transaction, vault included", () => {
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), buyTokens: 12_345n, otherBought: 500n };
    expect(parseLaunchTransaction(launchTx(l), l.sig, LAUNCH)?.birthSupply).toBe(VAULT_AFTER + RESERVE + 12_845n);
    const gone: Launch = { ...l, buyTokens: 'unreadable', otherBought: undefined };
    expect(parseLaunchTransaction(launchTx(gone), gone.sig, LAUNCH)?.birthSupply).toBeNull();
    const t = launchTx(l) as { meta: { postTokenBalances: Array<{ uiTokenAmount: { amount: string } }> } };
    t.meta.postTokenBalances[0]!.uiTokenAmount.amount = '1e9';
    expect(parseLaunchTransaction(t, l.sig, LAUNCH)?.birthSupply).toBeNull();
  });

  it("the plant, carried: exactly 50,000 $BAYLA burned and 50,000 to the Workshop's Token-2022 account", () => {
    const creator = Keypair.generate();
    const l: Launch = { sig: sig(1), creator, mint: Keypair.generate(), bayla: plantBalances(creator.publicKey) };
    expect(parseLaunchTransaction(launchTx(l), l.sig, LAUNCH)?.plant).toEqual({ burned: B(50_000n), toWorkshop: B(50_000n) });
  });

  it('no plant: a launch transaction that moved no $BAYLA reads 0 and 0, a real finding', () => {
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), buyTokens: 5n };
    expect(parseLaunchTransaction(launchTx(l), l.sig, LAUNCH)?.plant).toEqual({ burned: 0n, toWorkshop: 0n });
  });

  it('other amounts are read as they are', () => {
    const creator = Keypair.generate();
    const l: Launch = { sig: sig(1), creator, mint: Keypair.generate(), bayla: plantBalances(creator.publicKey, B(25_000n), B(10_000n)) };
    expect(parseLaunchTransaction(launchTx(l), l.sig, LAUNCH)?.plant).toEqual({ burned: B(25_000n), toWorkshop: B(10_000n) });
  });

  it('the plant read is "could not read", never 0: missing balances, a bad amount, a $BAYLA balance not under Token-2022, more after than before', () => {
    const creator = Keypair.generate();
    const base: Launch = { sig: sig(1), creator, mint: Keypair.generate(), bayla: plantBalances(creator.publicKey) };
    const plant = (l: Launch) => parseLaunchTransaction(launchTx(l), l.sig, LAUNCH)?.plant;
    expect(plant({ ...base, noPre: true })).toBeNull();
    const [maker, workshop] = plantBalances(creator.publicKey);
    expect(plant({ ...base, bayla: [{ ...maker!, amount: '12.5' }, workshop!] })).toBeNull();
    expect(plant({ ...base, bayla: [{ ...maker!, programId: TOKEN_PROGRAM_ID }, workshop!] })).toBeNull();
    expect(plant({ ...base, bayla: [maker!, { ...workshop!, programId: null }] })).toBeNull();
    expect(plant({ ...base, bayla: [{ ...maker!, pre: null, post: B(10n) }] })).toBeNull();
  });
});

describe('listRecentLaunches', () => {
  it('keeps real launches only, re-checks each curve, and reports what it scanned', async () => {
    const f = new FakeJsonRpc();
    const good: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), buyTokens: 5n };
    const wrongOwner: Launch = { sig: sig(2), creator: Keypair.generate(), mint: Keypair.generate() };
    const failed: Launch = { sig: sig(3), creator: Keypair.generate(), mint: Keypair.generate() };
    const other: Launch = { sig: sig(4), creator: Keypair.generate(), mint: Keypair.generate(), programId: Keypair.generate().publicKey };
    f.index(INDEX, [
      { sig: good.sig, tx: launchTx(good) },
      { sig: sig(9), tx: noiseTx(good.creator) },
      { sig: wrongOwner.sig, tx: launchTx(wrongOwner) },
      { sig: failed.sig, tx: launchTx(failed), err: { InstructionError: [0, 'x'] } },
      { sig: other.sig, tx: launchTx(other) },
    ]);
    f.curve(good.mint.publicKey, good.creator.publicKey);
    f.curve(wrongOwner.mint.publicKey, wrongOwner.creator.publicKey, Keypair.generate().publicKey);
    f.accounts.set(metadataPda(good.mint.publicKey).toBase58(), { data: metadataAccount(good.mint.publicKey, { name: 'Good', symbol: 'GD', uri: 'https://ipfs.io/ipfs/x' }), owner: METAPLEX_TOKEN_METADATA_ID, lamports: 1 });

    const r = await listRecentLaunches(f.rpc, cfgLocal);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.items.map((i) => i.mint.toBase58())).toEqual([good.mint.publicKey.toBase58(), wrongOwner.mint.publicKey.toBase58()]);
    const [g, w] = r.value.items;
    expect(g!.curve.kind).toBe('ok');
    expect(g!.metadata.kind === 'ok' && g!.metadata.value.name).toBe('Good');
    expect(g!.openingBuyTokens).toBe(5n);
    expect(w!.curve).toEqual({ kind: 'undecodable', reason: 'wrong-discriminator' });
    expect(w!.metadata.kind).toBe('absent');
    expect(r.value.scanned).toBe(5);
    expect(r.value.before).toBeNull(); // fewer than a page: nothing older
    // The failed entry was skipped by its signature status; its transaction was never fetched.
    expect(f.calls.filter((c) => c === 'getTransaction')).toHaveLength(4);
    expect(f.calls.filter((c) => c === 'getMultipleAccounts')).toHaveLength(2);
  });

  it('a curve whose creator differs from the transaction’s is not accepted', async () => {
    const f = new FakeJsonRpc();
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    f.index(INDEX, [{ sig: l.sig, tx: launchTx(l) }]);
    f.curve(l.mint.publicKey, Keypair.generate().publicKey);
    const r = await listRecentLaunches(f.rpc, cfgLocal);
    expect(r.kind === 'ok' && r.value.items[0]!.curve).toEqual({ kind: 'undecodable', reason: 'malformed' });
  });

  it('unreadable stays unreadable: a failed account read is never a zero or an absence', async () => {
    const f = new FakeJsonRpc();
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    f.index(INDEX, [{ sig: l.sig, tx: launchTx(l) }]);
    f.fail.add('getMultipleAccounts');
    const r = await listRecentLaunches(f.rpc, cfgLocal);
    expect(r.kind === 'ok' && r.value.items[0]!.curve.kind).toBe('unreadable');
    expect(r.kind === 'ok' && r.value.items[0]!.metadata.kind).toBe('unreadable');
    const g = new FakeJsonRpc();
    g.fail.add('getSignaturesForAddress');
    expect((await listRecentLaunches(g.rpc, cfgLocal)).kind).toBe('unreadable');
  });

  it('pages at most 3 × 20 entries of noise, then returns a cursor and "scanned", not "no launches"', async () => {
    const f = new FakeJsonRpc();
    const spam = Keypair.generate();
    const entries = Array.from({ length: 70 }, (_, i) => ({ sig: sig(100 + i), tx: noiseTx(spam) }));
    f.index(INDEX, entries);
    const r = await listRecentLaunches(f.rpc, cfgLocal);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.items).toHaveLength(0);
    expect(r.value.scanned).toBe(3 * LIST_PAGE_SIZE);
    expect(r.value.before).toBe(sig(100 + 59));
    const next = await listRecentLaunches(f.rpc, cfgLocal, { before: r.value.before! });
    expect(next.kind === 'ok' && next.value.scanned).toBe(10);
    expect(next.kind === 'ok' && next.value.before).toBeNull();
  });

  // R6-1: the cursor jumped to the end of a page even when the list filled up halfway
  // through it, so "Load more" never showed the rest of that page (1 noise entry then
  // 44 launches: 25 of 44 were ever listed).
  it('"Load more" lists EVERY launch once, when the list fills up partway through a page', async () => {
    const f = new FakeJsonRpc();
    const spam = Keypair.generate();
    const launches: Launch[] = Array.from({ length: 44 }, (_, i) => ({ sig: sig(10_000 + i), creator: Keypair.generate(), mint: Keypair.generate() }));
    f.index(INDEX, [{ sig: sig(9_999), tx: noiseTx(spam) }, ...launches.map((l) => ({ sig: l.sig, tx: launchTx(l) }))]);
    for (const l of launches) f.curve(l.mint.publicKey, l.creator.publicKey);
    const listed: string[] = [];
    let before: string | undefined;
    let scanned = 0;
    for (let load = 0; load < 10; load++) {
      const r = await listRecentLaunches(f.rpc, cfgLocal, before ? { before } : {});
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') return;
      listed.push(...r.value.items.map((i) => i.mint.toBase58()));
      scanned += r.value.scanned;
      if (r.value.before === null) break;
      before = r.value.before;
    }
    expect(listed).toEqual(launches.map((l) => l.mint.publicKey.toBase58()));
    // Every entry is counted once across the loads.
    expect(scanned).toBe(45);
  });

  it('by creator pages the same way: no launch skipped', async () => {
    const f = new FakeJsonRpc();
    const me = Keypair.generate();
    const mine: Launch[] = Array.from({ length: 30 }, (_, i) => ({ sig: sig(20_000 + i), creator: me, mint: Keypair.generate() }));
    f.index(me.publicKey, [{ sig: sig(19_999), tx: noiseTx(me) }, ...mine.map((l) => ({ sig: l.sig, tx: launchTx(l) }))]);
    const listed: string[] = [];
    let before: string | undefined;
    for (let load = 0; load < 10; load++) {
      const r = await listLaunchesByCreator(f.rpc, cfgLocal, me.publicKey, { limit: 7, ...(before ? { before } : {}) });
      if (r.kind !== 'ok') throw new Error(r.kind);
      listed.push(...r.value.items.map((i) => i.mint.toBase58()));
      if (r.value.before === null) break;
      before = r.value.before;
    }
    expect(listed).toEqual(mine.map((l) => l.mint.publicKey.toBase58()));
  });

  it('a mint on the committed hide list is never listed, and is counted', async () => {
    const f = new FakeJsonRpc();
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    f.index(INDEX, [{ sig: l.sig, tx: launchTx(l) }]);
    (HIDDEN_MINTS as Set<string>).add(l.mint.publicKey.toBase58());
    try {
      const r = await listRecentLaunches(f.rpc, cfgLocal);
      expect(r.kind === 'ok' && r.value.items).toHaveLength(0);
      expect(r.kind === 'ok' && r.value.hidden).toBe(1);
    } finally {
      (HIDDEN_MINTS as Set<string>).delete(l.mint.publicKey.toBase58());
    }
  });

  it('by creator: only launches that wallet created', async () => {
    const f = new FakeJsonRpc();
    const me = Keypair.generate();
    const mine: Launch = { sig: sig(1), creator: me, mint: Keypair.generate() };
    const theirs: Launch = { sig: sig(2), creator: Keypair.generate(), mint: Keypair.generate() };
    f.index(me.publicKey, [{ sig: mine.sig, tx: launchTx(mine) }, { sig: theirs.sig, tx: launchTx(theirs) }]);
    const r = await listLaunchesByCreator(f.rpc, cfgLocal, me.publicKey);
    expect(r.kind === 'ok' && r.value.items.map((i) => i.mint.toBase58())).toEqual([mine.mint.publicKey.toBase58()]);
  });
});

describe('the launch transaction behind a mint page', () => {
  it('found through the token details account, oldest first', async () => {
    const f = new FakeJsonRpc();
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), buyTokens: 77n };
    f.index(metadataPda(l.mint.publicKey), [{ sig: sig(5), tx: noiseTx(l.creator) }, { sig: l.sig, tx: launchTx(l) }]);
    const r = await readLaunchOrigin(f.rpc, cfgLocal, l.mint.publicKey);
    expect(r.kind === 'ok' && r.value.openingBuyTokens).toBe(77n);
    expect(r.kind === 'ok' && r.value.signature).toBe(l.sig);
  });
  // Anyone can mention the token details account for a few lamports. Twenty such
  // mentions used to end the lookup at "too much history" without trying the curve.
  it('a token details account with too much history falls through to the curve account', async () => {
    const f = new FakeJsonRpc();
    const spam = Keypair.generate();
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), buyTokens: 77n };
    f.index(metadataPda(l.mint.publicKey), Array.from({ length: 20 }, (_, i) => ({ sig: sig(500 + i), tx: null })));
    f.index(curvePda(l.mint.publicKey, LAUNCH), [{ sig: sig(7), tx: noiseTx(spam) }, { sig: l.sig, tx: launchTx(l) }]);
    const r = await readLaunchOrigin(f.rpc, cfgLocal, l.mint.publicKey);
    expect(r.kind === 'ok' && r.value.signature).toBe(l.sig);
    expect(r.kind === 'ok' && r.value.openingBuyTokens).toBe(77n);
  });
  it('too much history on both, or on the token details with nothing on the curve: could not read, never absent', async () => {
    const f = new FakeJsonRpc();
    const mint = Keypair.generate().publicKey;
    f.index(metadataPda(mint), Array.from({ length: 20 }, (_, i) => ({ sig: sig(500 + i), tx: null })));
    const r = await readLaunchOrigin(f.rpc, cfgLocal, mint);
    expect(r).toEqual({ kind: 'unreadable', detail: 'this launch has too much history to find its first transaction' });
    f.index(curvePda(mint, LAUNCH), Array.from({ length: 1000 }, (_, i) => ({ sig: sig(2_000 + i), tx: null })));
    expect((await readLaunchOrigin(f.rpc, cfgLocal, mint)).kind).toBe('unreadable');
  });
  it('absent when nothing is found; unreadable when the read fails', async () => {
    const f = new FakeJsonRpc();
    expect((await readLaunchOrigin(f.rpc, cfgLocal, Keypair.generate().publicKey)).kind).toBe('absent');
    f.fail.add('getSignaturesForAddress');
    expect((await readLaunchOrigin(f.rpc, cfgLocal, Keypair.generate().publicKey)).kind).toBe('unreadable');
  });
  it('creator holding: no account = holds 0 there; a failed read is unreadable, not 0', async () => {
    const chain = new FakeChain();
    const mint = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    expect(await readCreatorHolding(chain, mint, creator)).toEqual({ kind: 'ok', value: { amount: 0n, accountExists: false } });
    chain.tokenAccount(associatedTokenAddress(mint, creator), mint, creator, 42n);
    expect(await readCreatorHolding(chain, mint, creator)).toEqual({ kind: 'ok', value: { amount: 42n, accountExists: true } });
    chain.getAccountInfo = async () => {
      throw new Error('down');
    };
    expect((await readCreatorHolding(chain, mint, creator)).kind).toBe('unreadable');
    expect(shareBps(42n, 0n)).toBeNull();
    expect(shareBps(1n, 4n)).toBe(2_500n);
  });
  it('fully diluted value counts the whole supply at spot', () => {
    const c = freshCurve(Keypair.generate().publicKey, Keypair.generate().publicKey);
    const g = globalValue();
    expect(fullyDilutedValueLamports(c, g.tokenTotalSupply)).toBe(
      ((c.virtualSolReserves + c.realSolReserves) * g.tokenTotalSupply) / (c.virtualTokenReserves + c.realTokenReserves),
    );
  });
});

// ── the graduated pool ───────────────────────────────────────────────────────

describe('readLaunchPool', () => {
  const MINT = Keypair.generate().publicKey;
  const POOL = poolStatePda(MINT, LAUNCH);
  const { token0, token1 } = sortMints(WSOL_MINT, MINT);

  function poolBytes(over: Partial<Record<keyof typeof POOL_STATE_OFFSETS, PublicKey | number | bigint>> = {}): Uint8Array {
    const d = new Uint8Array(POOL_STATE_LEN);
    d.set(ACCOUNT_POOL_STATE, 0);
    const o = POOL_STATE_OFFSETS;
    const keys: Record<string, PublicKey> = {
      ammConfig: AMM_CONFIG, poolCreator: MINT, token0Vault: deriveVault(CPSWAP, POOL, token0), token1Vault: deriveVault(CPSWAP, POOL, token1),
      lpMint: deriveLpMint(CPSWAP, POOL), token0Mint: token0, token1Mint: token1, token0Program: TOKEN_PROGRAM_ID, token1Program: TOKEN_PROGRAM_ID,
      observationKey: deriveObservation(CPSWAP, POOL),
    };
    for (const [k, v] of Object.entries(keys)) d.set(((over[k as keyof typeof o] as PublicKey | undefined) ?? v).toBytes(), o[k as keyof typeof o]);
    d[o.status] = Number((over.status as number | undefined) ?? 0);
    d[o.lpMintDecimals] = 9;
    d.set(u64le(BigInt((over.openTime as bigint | undefined) ?? 0n)), o.openTime);
    return d;
  }

  function chainWith(poolData: Uint8Array, poolOwner: PublicKey = CPSWAP): FakeChain {
    const c = FakeChain.healthy();
    c.set(POOL, { lamports: 1, owner: poolOwner, data: poolData });
    c.tokenAccount(deriveVault(CPSWAP, POOL, token0), token0, POOL, 10_000_000n);
    c.tokenAccount(deriveVault(CPSWAP, POOL, token1), token1, POOL, 20_000_000n);
    return c;
  }
  const graduated = () => ({ ...freshCurve(MINT, MINT), complete: true, pool: POOL });

  // F4: the operator may point global.amm_config at new settings for FUTURE
  // graduations. A pool keeps the one it was created with, and is still tradeable.
  it('a pool created under earlier fee settings is still ok, with ITS OWN settings', async () => {
    const r = await readLaunchPool(chainWith(poolBytes()), cfgLocal, MINT, graduated(), globalValue({ ammConfig: Keypair.generate().publicKey }), 100);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.ammConfigAddress.equals(AMM_CONFIG)).toBe(true);
  });
  it('ok when every field is what graduation writes', async () => {
    const r = await readLaunchPool(chainWith(poolBytes()), cfgLocal, MINT, graduated(), globalValue(), 100);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.address.equals(POOL)).toBe(true);
  });
  it('not graduated: no pool', async () => {
    expect((await readLaunchPool(chainWith(poolBytes()), cfgLocal, MINT, freshCurve(MINT, MINT), globalValue())).kind).toBe('not-graduated');
  });
  it('a curve pointing at the STANDARD pair address (squattable) is a mismatch', async () => {
    const squat = derivePool(CPSWAP, AMM_CONFIG, token0, token1);
    const r = await readLaunchPool(chainWith(poolBytes()), cfgLocal, MINT, { ...graduated(), pool: squat }, globalValue());
    expect(r.kind).toBe('mismatch');
  });
  it('a pool account owned by another program is not a pool', async () => {
    expect((await readLaunchPool(chainWith(poolBytes(), Keypair.generate().publicKey), cfgLocal, MINT, graduated(), globalValue())).kind).toBe('not-a-pool');
  });
  it.each([
    ['ammConfig', Keypair.generate().publicKey],
    ['token0Mint', Keypair.generate().publicKey],
    ['token1Vault', Keypair.generate().publicKey],
    ['observationKey', Keypair.generate().publicKey],
    ['lpMint', Keypair.generate().publicKey],
    ['token0Program', new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')],
  ] as const)('a wrong %s is a mismatch', async (field, value) => {
    const r = await readLaunchPool(chainWith(poolBytes({ [field]: value })), cfgLocal, MINT, graduated(), globalValue());
    expect(r.kind).toBe('mismatch');
  });
  it('open-time is judged by the CHAIN clock (Clock sysvar), not the viewer clock', async () => {
    const clockAt = (t: bigint) => { const b = new Uint8Array(40); new DataView(b.buffer).setBigInt64(32, t, true); return b; };
    const c = chainWith(poolBytes({ openTime: 500n }));
    const CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');
    c.set(CLOCK, { lamports: 1, owner: new PublicKey('Sysvar1111111111111111111111111111111111111'), data: clockAt(501n) });
    const r = await readLaunchPool(c, cfgLocal, MINT, graduated(), globalValue());
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && r.value.chainTime).toBe(501n);
    c.set(CLOCK, { lamports: 1, owner: new PublicKey('Sysvar1111111111111111111111111111111111111'), data: clockAt(499n) });
    expect((await readLaunchPool(c, cfgLocal, MINT, graduated(), globalValue())).kind).toBe('closed-to-swaps');
    c.accounts.delete(CLOCK.toBase58());
    expect((await readLaunchPool(c, cfgLocal, MINT, graduated(), globalValue())).kind).toBe('unreadable');
  });

  it('swaps switched off, or not open yet: closed-to-swaps (no swap offered)', async () => {
    expect((await readLaunchPool(chainWith(poolBytes({ status: 4 })), cfgLocal, MINT, graduated(), globalValue(), 100)).kind).toBe('closed-to-swaps');
    expect((await readLaunchPool(chainWith(poolBytes({ openTime: 500n })), cfgLocal, MINT, graduated(), globalValue(), 100)).kind).toBe('closed-to-swaps');
  });
});
