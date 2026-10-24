// @vitest-environment node
//
// The panels' wallet read: one account call, and an unread wallet is never a 0.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { associatedTokenAddress } from '../../launcher/solana/curve/ix';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { readWalletFacts } from './walletFacts';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from './quotes';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from './tokenSafety';
import { fakeRpc, key, mintBytes, tokenAccountBytes, type FakeAccount } from './testkit.fixture';

const ata = (mint: PublicKey, owner: PublicKey, program = TOKEN_PROGRAM) => associatedTokenAddress(mint, owner, new PublicKey(program)).toBase58();
const rentFor = (n: number) => BigInt((128 + n) * 6960);
const SYSTEM = '11111111111111111111111111111111';

function wallet() {
  const owner = key();
  const mint = key();
  const lpMint = key();
  const accounts: Record<string, FakeAccount> = { [owner.toBase58()]: { owner: SYSTEM, data: new Uint8Array(0), lamports: 3_000_000_000 } };
  return { owner, mint, lpMint, accounts };
}

describe('readWalletFacts', () => {
  it('reads the wallet, its token, wrapped-SOL and pool-share accounts in one call, plus the two rents', async () => {
    const w = wallet();
    w.accounts[ata(w.mint, w.owner)] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(w.mint, w.owner, 1_234n) };
    w.accounts[ata(new PublicKey(WSOL_MINT), w.owner)] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(new PublicKey(WSOL_MINT), w.owner, 50n) };
    w.accounts[ata(w.lpMint, w.owner)] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(w.lpMint, w.owner, 0n) };
    const calls: [string, unknown[]][] = [];
    const f = await readWalletFacts(fakeRpc(w.accounts, { calls }), { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, lpMint: w.lpMint.toBase58() });
    expect(f).toEqual({
      kind: 'ok',
      lamports: 3_000_000_000n,
      token: { address: ata(w.mint, w.owner), amount: 1_234n },
      wsol: { exists: true, amount: 50n },
      coin: null,
      lpAccountExists: true,
      rents: expect.objectContaining({ tokenAccount165: rentFor(165) }),
    });
    expect(calls.filter(([m]) => m === 'getMultipleAccounts')).toHaveLength(1);
  });

  it('missing accounts are said as missing, and the token account is looked for under the pool’s token program', async () => {
    const w = wallet();
    // A classic account exists, but the pool's token is Token-2022: that is not its account.
    w.accounts[ata(w.mint, w.owner)] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(w.mint, w.owner, 9n) };
    const f = await readWalletFacts(fakeRpc(w.accounts), { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_2022_PROGRAM, lpMint: null });
    expect(f).toMatchObject({ kind: 'ok', token: null, wsol: { exists: false, amount: 0n }, lpAccountExists: false });
  });

  it('a failed read, or an account that is not a token account, is unread, never a 0', async () => {
    const w = wallet();
    const failed = await readWalletFacts(fakeRpc(w.accounts, { fail: new Set(['getMultipleAccounts']) }), { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, lpMint: null });
    expect(failed).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/502/) });
    w.accounts[ata(w.mint, w.owner)] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(key(), w.owner, 9n) };
    const wrong = await readWalletFacts(fakeRpc(w.accounts), { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, lpMint: null });
    expect(wrong).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/different token/) });
  });

  // Anyone can send SOL to an associated address before its account exists. That is no
  // account yet: it must not turn the whole read into "could not read" (no Max, no hints),
  // and the pool-share account still has to be paid for.
  it('an address that only holds SOL someone sent it is read as no account: the token, wrapped SOL and pool shares', async () => {
    const w = wallet();
    const bare: FakeAccount = { owner: SYSTEM, data: new Uint8Array(0), lamports: 890_880 };
    for (const k of [ata(w.mint, w.owner), ata(new PublicKey(WSOL_MINT), w.owner), ata(w.lpMint, w.owner)]) w.accounts[k] = bare;
    const f = await readWalletFacts(fakeRpc(w.accounts), { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, lpMint: w.lpMint.toBase58() });
    // The wallet itself is System-owned with no data too, and is still read.
    expect(f).toMatchObject({ kind: 'ok', lamports: 3_000_000_000n, token: null, wsol: { exists: false, amount: 0n }, lpAccountExists: false });
  });

  it('anything else at such an address is still unread: data under the System program, or no data under a token program', async () => {
    const odd: FakeAccount[] = [
      { owner: SYSTEM, data: new Uint8Array(80), lamports: 890_880 },
      { owner: TOKEN_PROGRAM, data: new Uint8Array(0), lamports: 890_880 },
    ];
    for (const account of odd) {
      const w = wallet();
      w.accounts[ata(new PublicKey(WSOL_MINT), w.owner)] = account;
      const f = await readWalletFacts(fakeRpc(w.accounts), { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, lpMint: null });
      expect(f).toMatchObject({ kind: 'unread', detail: expect.stringMatching(/wrapped-SOL account is not a token account/) });
    }
  });

  it('asks the rents once per session', async () => {
    const w = wallet();
    const calls: [string, unknown[]][] = [];
    const rpc = fakeRpc(w.accounts, { calls });
    const a = { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, lpMint: null };
    await readWalletFacts(rpc, a);
    await readWalletFacts(rpc, a);
    expect(calls.filter(([m]) => m === 'getMinimumBalanceForRentExemption').length).toBeLessThanOrEqual(2);
    expect(calls.filter(([m]) => m === 'getMultipleAccounts')).toHaveLength(2);
  });

  // SPEC_S2_CREATE 2.3 (K4): an opening also needs the deposits the new pool's own
  // accounts keep for good, from the same per-size rent reads.
  it('with `opening`, adds what the pool, its price record, share token and two vaults keep forever; without it, nothing changes', async () => {
    const w = wallet();
    const a = { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, lpMint: null };
    const opened = await readWalletFacts(fakeRpc(w.accounts), { ...a, opening: true });
    expect(opened.kind).toBe('ok');
    if (opened.kind !== 'ok') return;
    expect(opened.rents.neverRefunded).toBe(rentFor(637) + rentFor(4075) + rentFor(82) + rentFor(165) + rentFor(165));
    const plain = await readWalletFacts(fakeRpc(w.accounts), a);
    expect(plain.kind === 'ok' && Object.keys(plain.rents).sort()).toEqual(['tokenAccount165', 'walletFloor']);
  });
});

// ── a pool paired with USDC or BAYLA (quotes.ts) ────────────────────────────────

/** Mainnet's own bytes for the BAYLA mint: Token-2022, with a name and a picture and nothing else. */
const BAYLA_MINT_BYTES = (() => {
  const dump = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../scripts/solana-localnet/golden/bayla-mint.mainnet.json', import.meta.url)), 'utf8')) as {
    account: { data: [string, string] };
  };
  return new Uint8Array(Buffer.from(dump.account.data[0], 'base64'));
})();

/**
 * A Token-2022 account as the associated-token program opens it: the classic 165 bytes,
 * the account-type byte (2), then ImmutableOwner (type 7, no body). 170 bytes.
 */
function token2022AccountBytes(mint: PublicKey, owner: PublicKey, amount: bigint): Uint8Array {
  const d = new Uint8Array(170);
  d.set(tokenAccountBytes(mint, owner, amount), 0);
  d[165] = 2;
  new DataView(d.buffer).setUint16(166, 7, true);
  return d;
}

/** The size of the wallet's own account for each coin, on chain. */
const COIN_ACCOUNT_SIZE: Record<string, number> = { USDC: 165, BAYLA: 170 };
const COINS = [['USDC', USDC_QUOTE], ['BAYLA', BAYLA_QUOTE]] as const;

/** A wallet, and the coin's own mint as the chain holds it. `held`: what the wallet's account for the coin holds; null = no account. */
function coinWallet(quote: QuoteCoin, held: bigint | null) {
  const w = wallet();
  const coinMint = new PublicKey(quote.mint);
  w.accounts[quote.mint] = quote === BAYLA_QUOTE ? { owner: TOKEN_2022_PROGRAM, data: BAYLA_MINT_BYTES } : { owner: TOKEN_PROGRAM, data: mintBytes(key(), quote.decimals) };
  const coinAta = ata(coinMint, w.owner, quote.program);
  if (held !== null) {
    w.accounts[coinAta] =
      quote.program === TOKEN_2022_PROGRAM
        ? { owner: TOKEN_2022_PROGRAM, data: token2022AccountBytes(coinMint, w.owner, held) }
        : { owner: TOKEN_PROGRAM, data: tokenAccountBytes(coinMint, w.owner, held) };
  }
  const args = { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, lpMint: w.lpMint.toBase58(), quote };
  return { ...w, coinMint, coinAta, wsolAta: ata(new PublicKey(WSOL_MINT), w.owner), args };
}

const keysAsked = (calls: [string, unknown[]][]) => calls.filter(([m]) => m === 'getMultipleAccounts').map(([, p]) => (p as [string[]])[0]);

describe('readWalletFacts: a pool paired with USDC or BAYLA', () => {
  it.each(COINS)('%s: the coin is read from the wallet’s own account for it, under the coin’s own token program, and its deposit is the rent of that account’s real size', async (name, quote) => {
    const w = coinWallet(quote, 250_000_000n);
    w.accounts[ata(w.mint, w.owner)] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(w.mint, w.owner, 1_234n) };
    const calls: [string, unknown[]][] = [];
    const f = await readWalletFacts(fakeRpc(w.accounts, { calls }), w.args);
    expect(f).toEqual({
      kind: 'ok',
      lamports: 3_000_000_000n,
      token: { address: ata(w.mint, w.owner), amount: 1_234n },
      wsol: { exists: false, amount: 0n },
      coin: { address: w.coinAta, exists: true, amount: 250_000_000n },
      lpAccountExists: false,
      rents: { walletFloor: rentFor(0), tokenAccount165: rentFor(165), coinAccount: rentFor(COIN_ACCOUNT_SIZE[name]!) },
    });
    // The address is the one under the coin's own program, which for BAYLA is not the classic one.
    expect(w.coinAta).toBe(ata(w.coinMint, w.owner, quote.program));
    if (quote === BAYLA_QUOTE) expect(w.coinAta).not.toBe(ata(w.coinMint, w.owner, TOKEN_PROGRAM));
  });

  it.each(COINS)('%s: ONE account call, of the wallet, the token, the coin’s account, the pool shares and the coin’s own mint; no wrapped-SOL account is read', async (_n, quote) => {
    const w = coinWallet(quote, 7n);
    // The wallet happens to hold wrapped SOL: it is not this pool's coin, so it is not read or reported.
    w.accounts[w.wsolAta] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(new PublicKey(WSOL_MINT), w.owner, 50n) };
    const calls: [string, unknown[]][] = [];
    const f = await readWalletFacts(fakeRpc(w.accounts, { calls }), w.args);
    expect(keysAsked(calls)).toEqual([[w.owner.toBase58(), ata(w.mint, w.owner), w.coinAta, ata(w.lpMint, w.owner), quote.mint]]);
    expect(keysAsked(calls)[0]).not.toContain(w.wsolAta);
    expect(f).toMatchObject({ kind: 'ok', wsol: { exists: false, amount: 0n }, coin: { exists: true, amount: 7n } });
  });

  it('BAYLA: a classic account at the classic address is not the wallet’s BAYLA account', async () => {
    const w = coinWallet(BAYLA_QUOTE, null);
    w.accounts[ata(w.coinMint, w.owner, TOKEN_PROGRAM)] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(w.coinMint, w.owner, 99n) };
    const f = await readWalletFacts(fakeRpc(w.accounts), w.args);
    expect(f).toMatchObject({ kind: 'ok', coin: { address: w.coinAta, exists: false, amount: 0n } });
  });

  it.each(COINS)('%s: no account for the coin is a real answer (exists: false, 0), with the address it would be opened at and its deposit', async (name, quote) => {
    const w = coinWallet(quote, null);
    const f = await readWalletFacts(fakeRpc(w.accounts), w.args);
    expect(f).toMatchObject({
      kind: 'ok',
      coin: { address: w.coinAta, exists: false, amount: 0n },
      rents: { coinAccount: rentFor(COIN_ACCOUNT_SIZE[name]!) },
    });
  });

  it.each(COINS)('%s: a coin address that only holds SOL someone sent it is no account', async (_n, quote) => {
    const w = coinWallet(quote, null);
    w.accounts[w.coinAta] = { owner: SYSTEM, data: new Uint8Array(0), lamports: 890_880 };
    const f = await readWalletFacts(fakeRpc(w.accounts), w.args);
    expect(f).toMatchObject({ kind: 'ok', coin: { address: w.coinAta, exists: false, amount: 0n } });
  });

  it.each(COINS)('%s: an account at the coin address that is not the wallet’s account for that coin makes the whole answer unread, never an amount of 0', async (_n, quote) => {
    const stranger = key();
    const full = (mint: PublicKey, owner: PublicKey): Uint8Array =>
      quote.program === TOKEN_2022_PROGRAM ? token2022AccountBytes(mint, owner, 9n) : tokenAccountBytes(mint, owner, 9n);
    const cases: Array<[FakeAccount, RegExp]> = [
      // It holds another mint.
      [{ owner: quote.program, data: full(key(), key()) }, new RegExp(`your ${quote.symbol} account holds a different token`)],
      // The right mint, but the account now belongs to another wallet: nothing this wallet can spend.
      [{ owner: quote.program, data: full(new PublicKey(quote.mint), stranger) }, new RegExp(`your ${quote.symbol} account belongs to another wallet`)],
      // The right bytes under the OTHER token program.
      [{ owner: quote.program === TOKEN_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM, data: full(new PublicKey(quote.mint), key()) }, new RegExp(`your ${quote.symbol} account is not a token account`)],
      // Too short to be a token account.
      [{ owner: quote.program, data: new Uint8Array(80) }, new RegExp(`your ${quote.symbol} account is not a token account`)],
      // Data under the System program.
      [{ owner: SYSTEM, data: new Uint8Array(80), lamports: 890_880 }, new RegExp(`your ${quote.symbol} account is not a token account`)],
    ];
    for (const [account, why] of cases) {
      const w = coinWallet(quote, null);
      w.accounts[w.coinAta] = account;
      const f = await readWalletFacts(fakeRpc(w.accounts), w.args);
      expect(f, String(why)).toEqual({ kind: 'unread', detail: expect.stringMatching(why) });
    }
  });

  it.each(COINS)('%s: a failed read is unread', async (_n, quote) => {
    const w = coinWallet(quote, 5n);
    const f = await readWalletFacts(fakeRpc(w.accounts, { fail: new Set(['getMultipleAccounts']) }), w.args);
    expect(f).toEqual({ kind: 'unread', detail: expect.stringMatching(/502/) });
  });

  it.each(COINS)('%s: the coin’s own mint must be the one this site knows, or nothing is said about the wallet', async (_n, quote) => {
    const otherProgram = quote.program === TOKEN_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
    const wrongDecimals = (): FakeAccount => {
      const w = coinWallet(quote, 5n);
      const data = new Uint8Array(w.accounts[quote.mint]!.data);
      data[44] = 9;
      return { owner: quote.program, data };
    };
    const cases: Array<[FakeAccount | null, RegExp]> = [
      [null, new RegExp(`${quote.symbol}'s own token was not found`)],
      // An 82-byte mint decodes under either program, so only the owner differs here.
      [{ owner: otherProgram, data: mintBytes(key(), quote.decimals) }, new RegExp(`${quote.symbol}'s own token sits under another token program`)],
      [wrongDecimals(), new RegExp(`${quote.symbol}'s own token does not have ${quote.symbol}'s decimals`)],
      [{ owner: quote.program, data: new Uint8Array(40) }, new RegExp(`${quote.symbol}'s own token does not have ${quote.symbol}'s decimals`)],
    ];
    for (const [mint, why] of cases) {
      const w = coinWallet(quote, 5n);
      if (mint) w.accounts[quote.mint] = mint;
      else delete w.accounts[quote.mint];
      const f = await readWalletFacts(fakeRpc(w.accounts), w.args);
      expect(f, String(why)).toEqual({ kind: 'unread', detail: expect.stringMatching(why) });
    }
  });

  it('BAYLA: a mint this site cannot size an account for is unread', async () => {
    const w = coinWallet(BAYLA_QUOTE, 5n);
    // A Token-2022 mint whose bytes run past the base layout but carry no account-type byte.
    const data = new Uint8Array(120);
    data.set(mintBytes(key(), BAYLA_QUOTE.decimals), 0);
    w.accounts[BAYLA_QUOTE.mint] = { owner: TOKEN_2022_PROGRAM, data };
    const f = await readWalletFacts(fakeRpc(w.accounts), w.args);
    expect(f).toEqual({ kind: 'unread', detail: expect.stringMatching(/an account for BAYLA could not be sized/) });
  });

  it('BAYLA: when the deposit for its 170-byte account cannot be read, the answer is unread, not a deposit of 0', async () => {
    // A fresh copy of the module: rents are kept for the session, and another test may have read this one.
    vi.resetModules();
    const fresh = await import('./walletFacts');
    const w = coinWallet(BAYLA_QUOTE, 5n);
    const inner = fakeRpc(w.accounts);
    const rpc: SolanaRpc = async (method, params) => {
      if (method === 'getMinimumBalanceForRentExemption' && (params as [number])[0] === 170) throw new Error('getMinimumBalanceForRentExemption: HTTP 502');
      return inner(method, params);
    };
    expect(await fresh.readWalletFacts(rpc, w.args)).toEqual({ kind: 'unread', detail: expect.stringMatching(/502/) });
    // A failed rent read is not kept: the next read asks again and answers.
    expect(await fresh.readWalletFacts(inner, w.args)).toMatchObject({ kind: 'ok', rents: { coinAccount: rentFor(170) } });
  });

  it.each(COINS)('%s: opening a pool adds the same never-refunded deposits as a SOL pool, beside the coin’s account deposit', async (name, quote) => {
    const w = coinWallet(quote, 5n);
    const f = await readWalletFacts(fakeRpc(w.accounts), { ...w.args, lpMint: null, opening: true });
    expect(f.kind === 'ok' && f.rents).toEqual({
      walletFloor: rentFor(0),
      tokenAccount165: rentFor(165),
      neverRefunded: rentFor(637) + rentFor(4075) + rentFor(82) + rentFor(165) + rentFor(165),
      coinAccount: rentFor(COIN_ACCOUNT_SIZE[name]!),
    });
  });
});

describe('readWalletFacts: a SOL pool is read exactly as before', () => {
  it.each([['no coin named', undefined], ['SOL named', SOL_QUOTE]] as const)('%s: the same keys in the same order, no coin, no coin deposit', async (_n, quote) => {
    const w = wallet();
    const wsolAta = ata(new PublicKey(WSOL_MINT), w.owner);
    w.accounts[wsolAta] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(new PublicKey(WSOL_MINT), w.owner, 50n) };
    const base = { owner: w.owner.toBase58(), tokenMint: w.mint.toBase58(), tokenProgram: TOKEN_PROGRAM, ...(quote ? { quote } : {}) };
    const calls: [string, unknown[]][] = [];
    const withShares = await readWalletFacts(fakeRpc(w.accounts, { calls }), { ...base, lpMint: w.lpMint.toBase58() });
    const without = await readWalletFacts(fakeRpc(w.accounts, { calls }), { ...base, lpMint: null });
    expect(keysAsked(calls)).toEqual([
      [w.owner.toBase58(), ata(w.mint, w.owner), wsolAta, ata(w.lpMint, w.owner)],
      [w.owner.toBase58(), ata(w.mint, w.owner), wsolAta],
    ]);
    for (const f of [withShares, without]) {
      expect(f).toMatchObject({ kind: 'ok', wsol: { exists: true, amount: 50n }, coin: null });
      expect(f.kind === 'ok' && Object.keys(f.rents).sort()).toEqual(['tokenAccount165', 'walletFloor']);
    }
  });
});
