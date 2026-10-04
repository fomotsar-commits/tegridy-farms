// @vitest-environment node
//
// The token safety checker. Mint bytes are built with @solana/spl-token's OWN layouts
// and read back with its OWN unpacker, so the hand decoder is checked against the
// library the token programs' clients use, not against itself.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  MintLayout,
  unpackMint,
  getExtensionTypes,
  getMetadataPointerState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID as SPL_T22,
} from '@solana/spl-token';
import { pack as packTokenMetadata } from '@solana/spl-token-metadata';
import {
  BUILDABLE_EXTENSIONS,
  EXTENSION,
  classifyToken,
  decodeMintAccount,
  readTokenSafety,
  RAYDIUM_WHITELISTED_MINTS,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
  BAYLA_MINT,
  WELL_KNOWN_NAMES,
  type TokenSafety,
} from './tokenSafety';
import { tokenReasons } from './poolHealth';
import { BAYLA_MINT as SITE_BAYLA_MINT, BUNGALOWS } from '../../bungalows';
import type { RawAccount } from './accounts';
import { METAPLEX_TOKEN_METADATA_ID, metadataPda } from '../../launcher/solana/write/metaplex';

const key = () => Keypair.generate().publicKey;

function classicMint(o: { mintAuthority?: PublicKey | null; freezeAuthority?: PublicKey | null; decimals?: number; supply?: bigint } = {}): Uint8Array {
  const b = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: o.mintAuthority ? 1 : 0,
    mintAuthority: o.mintAuthority ?? PublicKey.default,
    supply: o.supply ?? 1_000_000n,
    decimals: o.decimals ?? 6,
    isInitialized: true,
    freezeAuthorityOption: o.freezeAuthority ? 1 : 0,
    freezeAuthority: o.freezeAuthority ?? PublicKey.default,
  }, b);
  return new Uint8Array(b);
}

function tlv(type: number, value: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + value.length);
  const v = new DataView(out.buffer);
  v.setUint16(0, type, true);
  v.setUint16(2, value.length, true);
  out.set(value, 4);
  return out;
}

function t22Mint(base: Uint8Array, entries: Uint8Array[]): Uint8Array {
  const body = entries.reduce((n, e) => n + e.length, 0);
  const out = new Uint8Array(166 + body);
  out.set(base, 0);
  out[165] = 1; // AccountType::Mint
  let o = 166;
  for (const e of entries) { out.set(e, o); o += e.length; }
  return out;
}

const pointer = (authority: PublicKey | null, metadata: PublicKey) =>
  tlv(ExtensionType.MetadataPointer, Uint8Array.from([...(authority ?? PublicKey.default).toBytes(), ...metadata.toBytes()]));
const metadataExt = (mint: PublicKey, updateAuthority: PublicKey | null, name = 'Corn', symbol = 'CORN') =>
  tlv(ExtensionType.TokenMetadata, Uint8Array.from(packTokenMetadata({ updateAuthority: updateAuthority ?? undefined, mint, name, symbol, uri: 'https://example.com/c.json', additionalMetadata: [] })));

function str(s: string): number[] {
  const b = Buffer.from(s, 'utf8');
  return [b.length & 255, (b.length >> 8) & 255, 0, 0, ...b];
}
function metaplexRecord(mint: PublicKey, isMutable: boolean, name = 'Corn', symbol = 'CORN'): Uint8Array {
  return Uint8Array.from([4, ...key().toBytes(), ...mint.toBytes(), ...str(name), ...str(symbol), ...str('https://x.test/a.json'), 0, 0, 0, 0, isMutable ? 1 : 0]);
}

const acct = (address: PublicKey | string, owner: string, data: Uint8Array): RawAccount => ({ address: String(address), owner, data, lamports: 1 });
const reasons = (s: TokenSafety) => (s.kind === 'read' ? { blocks: s.blocks.map((r) => r.code), warnings: s.warnings.map((r) => r.code), verdict: s.verdict } : s.kind);

describe('decodeMintAccount agrees with @solana/spl-token', () => {
  it('a classic mint', () => {
    const ma = key();
    const fa = key();
    const data = classicMint({ mintAuthority: ma, freezeAuthority: fa, decimals: 9, supply: 123n });
    const d = decodeMintAccount(TOKEN_PROGRAM, data);
    const lib = unpackMint(key(), { data: Buffer.from(data), owner: new PublicKey(TOKEN_PROGRAM), lamports: 1, executable: false });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value.mintAuthority).toBe(lib.mintAuthority!.toBase58());
    expect(d.value.freezeAuthority).toBe(lib.freezeAuthority!.toBase58());
    expect(d.value.decimals).toBe(lib.decimals);
    expect(d.value.supply).toBe(lib.supply);
    expect(d.value.extensions).toEqual([]);
  });

  it('a Token-2022 mint with a metadata pointer, metadata and a transfer hook', () => {
    const mint = key();
    const upd = key();
    const hook = tlv(ExtensionType.TransferHook, Uint8Array.from([...key().toBytes(), ...key().toBytes()]));
    const data = t22Mint(classicMint(), [pointer(upd, mint), hook, metadataExt(mint, upd, 'Hooked', 'HOOK')]);
    const d = decodeMintAccount(TOKEN_2022_PROGRAM, data);
    const lib = unpackMint(mint, { data: Buffer.from(data), owner: SPL_T22, lamports: 1, executable: false }, SPL_T22);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value.extensions).toEqual(getExtensionTypes(lib.tlvData));
    const mp = getMetadataPointerState(lib)!;
    expect(d.value.metadataPointer).toEqual({ authority: mp.authority!.toBase58(), metadataAddress: mp.metadataAddress!.toBase58() });
    expect(d.value.tokenMetadata).toMatchObject({ updateAuthority: upd.toBase58(), mint: mint.toBase58(), name: 'Hooked', symbol: 'HOOK' });
  });

  it('refuses bytes that are not a mint, and an extension that runs off the end', () => {
    expect(decodeMintAccount('11111111111111111111111111111111', classicMint()).ok).toBe(false);
    expect(decodeMintAccount(TOKEN_PROGRAM, classicMint().subarray(0, 50)).ok).toBe(false);
    const bad = t22Mint(classicMint(), [tlv(ExtensionType.MetadataPointer, new Uint8Array(64))]);
    new DataView(bad.buffer).setUint16(166 + 2, 400, true); // length far past the end
    expect(decodeMintAccount(TOKEN_2022_PROGRAM, bad).ok).toBe(false);
  });
});

describe('classifyToken', () => {
  const mint = key();
  const immutableName = (m = mint) => acct(metadataPda(m), METAPLEX_TOKEN_METADATA_ID.toBase58(), metaplexRecord(m, false));

  it('a classic token with no authorities and a fixed name is ok', () => {
    const s = classifyToken(mint.toBase58(), acct(mint, TOKEN_PROGRAM, classicMint()), immutableName());
    expect(reasons(s)).toEqual({ blocks: [], warnings: [], verdict: 'ok' });
    expect(s.kind === 'read' && s.name).toBe('Corn');
  });

  // Owner ruling 2026-10-04: a token whose creator can freeze accounts may have a pool.
  // It is a warning, and the warning says what a freeze means for a pool and for the holder.
  it('warns on a live freeze authority, never blocks it, and says what it means for a pool and for the holder', () => {
    const authority = key();
    const s = classifyToken(mint.toBase58(), acct(mint, TOKEN_PROGRAM, classicMint({ freezeAuthority: authority })), immutableName());
    expect(reasons(s)).toEqual({ blocks: [], warnings: ['freeze-authority'], verdict: 'warn' });
    const text = s.kind === 'read' ? s.warnings[0]!.text : '';
    expect(text).toContain(authority.toBase58());
    expect(text).toMatch(/a pool’s own vault and your own account included/);
    expect(text).toMatch(/While a pool’s vault is frozen, nobody can take liquidity out of that pool\./);
  });

  it('accepts USDC’s freeze authority, and says so', () => {
    const usdc = new PublicKey(USDC_MINT);
    const s = classifyToken(USDC_MINT, acct(usdc, TOKEN_PROGRAM, classicMint({ freezeAuthority: key() })), immutableName(usdc));
    expect(reasons(s)).toEqual({ blocks: [], warnings: ['freeze-authority-accepted'], verdict: 'warn' });
    // Accepted is not harmless: the words say what a freeze does to a pool, as they do for any other freezable token.
    const text = s.kind === 'read' ? s.warnings[0]!.text : '';
    expect(text).toContain('a pool’s own vault and your own account included. While a pool’s vault is frozen, nobody can take liquidity out of that pool.');
    expect(text).toContain('That is how USDC is built.');
  });

  // The leave rule: the pool program takes these four by name, but this site cannot build
  // an exact withdrawal for them, so it lets nobody in. The words say it is this site's limit.
  it('blocks the four stablecoins the pool program lets in by name, as this site’s own limit', () => {
    for (const m of RAYDIUM_WHITELISTED_MINTS) {
      const pk = new PublicKey(m);
      const s = classifyToken(m, acct(pk, TOKEN_2022_PROGRAM, t22Mint(classicMint(), [tlv(ExtensionType.PermanentDelegate, key().toBytes())])), immutableName(pk));
      expect(reasons(s)).toMatchObject({ blocks: ['permanent-delegate-whitelist'], verdict: 'blocked' });
      const text = s.kind === 'read' ? s.blocks.map((b) => b.text).join(' ') : '';
      expect(text).toMatch(/The pool program accepts it by name, but this site cannot build exact deposits and withdrawals for it, so it does not open or add to pools for it\./);
      // The pool program DOES take these, so no sentence may say it does not.
      expect(text).not.toMatch(/does not accept/);
    }
  });

  const withExtension = (type: number) => {
    const data = t22Mint(classicMint(), [pointer(null, mint), tlv(type, new Uint8Array(8)), metadataExt(mint, null)]);
    return classifyToken(mint.toBase58(), acct(mint, TOKEN_2022_PROGRAM, data), null);
  };

  // A real mint carries several extensions. The verdict looks at every one: a hook is
  // blocked whether it comes before the name, between its two parts, or after them.
  it('a rejected extension is blocked wherever it sits among the others: first, between, or last', () => {
    const hook = tlv(ExtensionType.TransferHook, new Uint8Array(8));
    const name = [pointer(null, mint), metadataExt(mint, null)] as const;
    for (const exts of [[hook, name[0], name[1]], [name[0], hook, name[1]], [name[0], name[1], hook]]) {
      const s = classifyToken(mint.toBase58(), acct(mint, TOKEN_2022_PROGRAM, t22Mint(classicMint(), exts)), null);
      expect(reasons(s)).toMatchObject({ blocks: ['extension'], verdict: 'blocked' });
    }
  });

  it('blocks every Token-2022 extension the pool program rejects, and says the pool program does not accept it', () => {
    const cases: [number, RegExp][] = [
      [ExtensionType.TransferHook, /transfer hook/],
      [ExtensionType.PermanentDelegate, /permanent delegate/],
      [ExtensionType.DefaultAccountState, /frozen/],
      [ExtensionType.NonTransferable, /non-transferable/],
      [ExtensionType.ConfidentialTransferMint, /confidential transfers/],
      [ExtensionType.MintCloseAuthority, /close authority/],
      [EXTENSION.PausableConfig, /pause switch/],
      [ExtensionType.GroupPointer, /group pointer/],
      [99, /does not know \(type 99\)/],
    ];
    for (const [type, text] of cases) {
      const s = withExtension(type);
      expect(reasons(s), String(type)).toEqual({ blocks: ['extension'], warnings: [], verdict: 'blocked' });
      expect(s.kind === 'read' && s.blocks[0]!.text, String(type)).toMatch(text);
      expect(s.kind === 'read' && s.blocks[0]!.text, String(type)).toMatch(/The pool program does not accept tokens with it\.$/);
    }
  });

  // The pool program takes a transfer fee. This site cannot build an exact withdrawal for
  // one, so nobody is let in (the leave rule), and the block says whose limit it is.
  it('blocks a transfer fee under its own code, in words that say it is this site’s limit', () => {
    const s = withExtension(ExtensionType.TransferFeeConfig);
    expect(reasons(s)).toEqual({ blocks: ['transfer-fee'], warnings: [], verdict: 'blocked' });
    const text = s.kind === 'read' ? s.blocks[0]!.text : '';
    // Nothing is said about the fee itself: neither its size nor who can change it was read.
    expect(text).toMatch(/^It uses a transfer-fee setting, which lets the token take a fee out of every transfer\./);
    expect(text).not.toMatch(/100%|its owner/);
    expect(text).toContain('This site cannot build exact deposits and withdrawals for a token with one, so it does not open or add to pools for it.');
    expect(text).not.toMatch(/pool program does not accept/);
  });

  it('warns on interest-bearing and scaled amounts, never blocks them, and says this site moves raw units', () => {
    const cases: [number, string, RegExp][] = [
      [ExtensionType.InterestBearingConfig, 'interest-bearing', /interest-bearing amounts/],
      [EXTENSION.ScaledUiAmountConfig, 'scaled-amount', /scaled amounts/],
    ];
    for (const [type, code, text] of cases) {
      const s = withExtension(type);
      expect(reasons(s), code).toEqual({ blocks: [], warnings: [code], verdict: 'warn' });
      expect(s.kind === 'read' && s.warnings[0]!.text, code).toMatch(text);
      expect(s.kind === 'read' && s.warnings[0]!.text, code).toMatch(/This site shows and moves raw token units, so an amount here can differ from the one your wallet shows\.$/);
    }
  });

  // The leave rule as code, on the verdict's side: the one set this site builds for is
  // exactly these four, and every one is on cp-swap's own list (utils/token.rs
  // `is_supported_mint`), written out here from the program's source.
  it('the one set of buildable extensions is the four whose raw amounts are exact, all of them accepted by the pool program', () => {
    const CP_SWAP_ACCEPTED = [
      EXTENSION.TransferFeeConfig,
      EXTENSION.MetadataPointer,
      EXTENSION.TokenMetadata,
      EXTENSION.InterestBearingConfig,
      EXTENSION.ScaledUiAmountConfig,
    ];
    expect([...BUILDABLE_EXTENSIONS].sort((a, b) => a - b)).toEqual([18, 19, 10, 25].sort((a, b) => a - b));
    for (const e of BUILDABLE_EXTENSIONS) expect(CP_SWAP_ACCEPTED, String(e)).toContain(e);
    // A transfer fee is on the pool program's list and NOT in the set: no exact withdrawal.
    expect(BUILDABLE_EXTENSIONS.has(EXTENSION.TransferFeeConfig)).toBe(false);
    // The numbers are the token program's own.
    expect([EXTENSION.InterestBearingConfig, EXTENSION.ScaledUiAmountConfig, EXTENSION.TransferFeeConfig]).toEqual([
      ExtensionType.InterestBearingConfig,
      ExtensionType.ScaledUiAmountConfig,
      ExtensionType.TransferFeeConfig,
    ]);
    // Every extension outside the set is blocked by the verdict; every one inside is not.
    for (const type of [...Object.values(EXTENSION), 99]) {
      if (type === EXTENSION.MetadataPointer || type === EXTENSION.TokenMetadata) continue; // carried by every case above
      const s = withExtension(type);
      expect(s.kind === 'read' && s.verdict !== 'blocked', String(type)).toBe(BUILDABLE_EXTENSIONS.has(type));
    }
  });

  it('accepts a Token-2022 token whose only extensions carry a fixed name', () => {
    const data = t22Mint(classicMint(), [pointer(null, mint), metadataExt(mint, null, 'Harvest', 'HRVST')]);
    const s = classifyToken(mint.toBase58(), acct(mint, TOKEN_2022_PROGRAM, data), null);
    expect(reasons(s)).toEqual({ blocks: [], warnings: [], verdict: 'ok' });
    expect(s.kind === 'read' && [s.name, s.symbol, s.metadataSource]).toEqual(['Harvest', 'HRVST', 'token-2022']);
  });

  it('warns on a live mint authority and on a name that can change (either kind of record)', () => {
    const s1 = classifyToken(mint.toBase58(), acct(mint, TOKEN_PROGRAM, classicMint({ mintAuthority: key() })), immutableName());
    expect(reasons(s1)).toEqual({ blocks: [], warnings: ['mint-authority'], verdict: 'warn' });
    // A pool is paired with SOL, USDC or BAYLA, and this sentence is printed on the review
    // of all three: it must not tell the holder of a USDC pool that SOL is what is at risk.
    const said = s1.kind === 'read' ? s1.warnings[0]!.text : '';
    expect(said).toContain('New tokens sold into a pool take out what it is paired with (SOL, USDC or BAYLA).');
    expect(said).not.toMatch(/take SOL out/);
    const s2 =classifyToken(mint.toBase58(), acct(mint, TOKEN_PROGRAM, classicMint()), acct(metadataPda(mint), METAPLEX_TOKEN_METADATA_ID.toBase58(), metaplexRecord(mint, true)));
    expect(reasons(s2)).toEqual({ blocks: [], warnings: ['metadata-mutable'], verdict: 'warn' });
    const s3 = classifyToken(mint.toBase58(), acct(mint, TOKEN_2022_PROGRAM, t22Mint(classicMint(), [pointer(null, mint), metadataExt(mint, key())])), null);
    expect(reasons(s3)).toEqual({ blocks: [], warnings: ['metadata-mutable'], verdict: 'warn' });
    const s4 = classifyToken(mint.toBase58(), acct(mint, TOKEN_2022_PROGRAM, t22Mint(classicMint(), [pointer(key(), mint), metadataExt(mint, null)])), null);
    expect(reasons(s4)).toEqual({ blocks: [], warnings: ['metadata-mutable'], verdict: 'warn' });
  });

  it('warns when there is no name on chain at all', () => {
    const s = classifyToken(mint.toBase58(), acct(mint, TOKEN_PROGRAM, classicMint()), null);
    expect(reasons(s)).toEqual({ blocks: [], warnings: ['no-metadata'], verdict: 'warn' });
  });

  it('a name record for ANOTHER mint is not this token’s name', () => {
    const s = classifyToken(mint.toBase58(), acct(mint, TOKEN_PROGRAM, classicMint()), acct(metadataPda(mint), METAPLEX_TOKEN_METADATA_ID.toBase58(), metaplexRecord(key(), false, 'USD Coin', 'USDC')));
    expect(s.kind === 'read' && s.name).toBeNull();
    expect(reasons(s)).toMatchObject({ warnings: ['metadata-unreadable', 'no-metadata'] });
  });

  // F6: a clean mint that copies a well-known name is never "No problems found".
  it('a clean copy of USDC, SOL, BAYLA or TOWELI is warned about, lookalike letters and all', () => {
    const cases: [string, string, string][] = [
      ['USD Coin', 'USDC', 'NOT the real USDC'],
      ['Wrapped SOL', 'SOL', 'NOT the real SOL'],
      ['Bayla', 'BAYLA', 'NOT the real BAYLA'],
      ['Towelie', '$TOWELI', 'no real TOWELI'],
      ['Totally real', 'USD\u0421', 'NOT the real USDC'], // a Cyrillic capital Es
      ['\uff35\uff53\uff44\uff54', 'X', 'NOT the real USDT'], // full-width "Usdt"
    ];
    for (const [name, symbol, says] of cases) {
      const m = key();
      const s = classifyToken(m.toBase58(), acct(m, TOKEN_PROGRAM, classicMint()), acct(metadataPda(m), METAPLEX_TOKEN_METADATA_ID.toBase58(), metaplexRecord(m, false, name, symbol)));
      expect(reasons(s), name + ' / ' + symbol).toEqual({ blocks: [], warnings: ['copies-known-name'], verdict: 'warn' });
      expect(s.kind === 'read' && s.warnings[0]!.text).toContain(says);
    }
  });

  it('the real USDC is not a copy of itself, and a name that merely contains a known one is not flagged', () => {
    const usdc = new PublicKey(USDC_MINT);
    const s = classifyToken(USDC_MINT, acct(usdc, TOKEN_PROGRAM, classicMint({ freezeAuthority: key() })), acct(metadataPda(usdc), METAPLEX_TOKEN_METADATA_ID.toBase58(), metaplexRecord(usdc, false, 'USD Coin', 'USDC')));
    expect(reasons(s)).toMatchObject({ warnings: ['freeze-authority-accepted'] });
    const m = key();
    const t = classifyToken(m.toBase58(), acct(m, TOKEN_PROGRAM, classicMint()), acct(metadataPda(m), METAPLEX_TOKEN_METADATA_ID.toBase58(), metaplexRecord(m, false, 'Solana Doge', 'SDOGE')));
    expect(reasons(t)).toEqual({ blocks: [], warnings: [], verdict: 'ok' });
  });

  // ATK-5 (audit 2026-10-03): the copy check is the launcher's own comparison
  // (launchMetadata/validate.js). A spelling the launcher would refuse is never
  // "No problems found" here.
  const named = (name: string, symbol: string) => {
    const m = key();
    return classifyToken(m.toBase58(), acct(m, TOKEN_PROGRAM, classicMint()), acct(metadataPda(m), METAPLEX_TOKEN_METADATA_ID.toBase58(), metaplexRecord(m, false, name, symbol)));
  };

  it('a look-alike spelling, a ticker written with its $, or a brand word inside a longer name is a copy', () => {
    const cases: [string, string, string][] = [
      ['SoIana', 'X', 'NOT the real SOL'], // a capital i for the l
      ['Totally real', 'S0L', 'NOT the real SOL'], // a zero for the O
      ['TOWELl', 'X', 'no real TOWELI'], // a lower-case L for the I
      ['BAYLA Token', 'X', 'NOT the real BAYLA'],
      ['Totally real', 'BAYLA2', 'NOT the real BAYLA'],
      ['Official $BAYLA', 'X', 'NOT the real BAYLA'],
      ['Totally real', '$USDC', 'NOT the real USDC'],
      ['$BOBO', 'X', 'NOT the real BOBO'],
      ['Sölana', 'X', 'NOT the real SOL'], // an accent on the o
      ['υsdc', 'X', 'NOT the real USDC'], // a Greek lower-case upsilon for the u
    ];
    for (const [name, symbol, says] of cases) {
      const s = named(name, symbol);
      expect(reasons(s), name + ' / ' + symbol).toEqual({ blocks: [], warnings: ['copies-known-name'], verdict: 'warn' });
      expect(s.kind === 'read' && s.warnings[0]!.text).toContain(says);
      // The copied name is said again before an opening, and refuses nothing.
      expect(tokenReasons(s, 'pools').warned, name + ' / ' + symbol).toHaveLength(1);
      expect(tokenReasons(s, 'pools').refused, name + ' / ' + symbol).toEqual([]);
    }
  });

  it('a copied name is caught behind another reserved word, and through characters that are not shown', () => {
    const cases: [string, string, string][] = [
      // The launcher's first answer for these two is TEGRIDY, which is not on this page's list.
      ['BAYLA by Tegridy', 'X', 'NOT the real BAYLA'],
      ['Tegridy Toweli', 'X', 'no real TOWELI'],
      // Shown as "Bayla Token", "BAYLA Token" and "BAYLA2": the character inside is not drawn.
      ['Bay\u200Bla Token', 'X', 'NOT the real BAYLA'], // zero-width space
      ['BAY\u00ADLA Token', 'X', 'NOT the real BAYLA'], // soft hyphen
      ['Totally real', 'BAY\u2060LA2', 'NOT the real BAYLA'], // word joiner
      ['BA\uE000YLA Token', 'X', 'NOT the real BAYLA'], // private use
      ['BA\u034FYLA Token', 'X', 'NOT the real BAYLA'], // combining grapheme joiner
      ['BAY\u2800LA Token', 'X', 'NOT the real BAYLA'], // braille blank
    ];
    for (const [name, symbol, says] of cases) {
      const s = named(name, symbol);
      const label = JSON.stringify(name + ' / ' + symbol);
      expect(reasons(s), label).toEqual({ blocks: [], warnings: ['copies-known-name'], verdict: 'warn' });
      expect(s.kind === 'read' && s.warnings[0]!.text, label).toContain(says);
      for (const action of ['pools', 'deposits'] as const) {
        expect(tokenReasons(s, action).warned, label).toHaveLength(1);
        expect(tokenReasons(s, action).refused, label).toEqual([]);
      }
    }
    // A reserved word this page has no real mint for is not a copy here (the launcher refuses it).
    expect(reasons(named('Tegridy Farms', 'X'))).toEqual({ blocks: [], warnings: [], verdict: 'ok' });
  });

  it('every name on the list is still a copy under each swap the launcher folds', () => {
    // 0 for O, 1 or l for I, I or 1 for L, 5 or $ for S, 8 for B, 3 for E.
    const swaps: [RegExp, string][] = [[/O/g, '0'], [/I/g, '1'], [/I/g, 'l'], [/L/g, 'I'], [/L/g, '1'], [/S/g, '5'], [/S/g, '$'], [/B/g, '8'], [/E/g, '3']];
    let tried = 0;
    for (const known of WELL_KNOWN_NAMES) {
      for (const n of known.names) {
        for (const [from, to] of swaps) {
          const spelled = n.toUpperCase().replace(from, to);
          if (spelled === n.toUpperCase()) continue;
          tried++;
          const s = named(spelled, 'X');
          expect(s.kind === 'read' && s.warnings.map((w) => w.code), `${n} spelled ${spelled}`).toEqual(['copies-known-name']);
        }
      }
    }
    expect(tried).toBeGreaterThan(WELL_KNOWN_NAMES.length);
  });

  it('letters outside plain A to Z are a warning: never "No problems found", and never a block', () => {
    const lookalikes = [
      'ʙᴀʏʟᴀ', // "BAYLA" in small capitals
      'ᏴᎪᎽᏞᎪ', // Cherokee letters shaped like B, A, y, L, A
      'Сorn', // a Cyrillic capital Es for the C, in a name that is on no list
      '玉米', // not a look-alike of anything: still not plain A to Z
    ];
    for (const text of lookalikes) {
      for (const s of [named(text, 'X'), named('Totally real', text)]) {
        expect(reasons(s), text).toEqual({ blocks: [], warnings: ['lookalike-letters'], verdict: 'warn' });
        // Said on the token only: it does not change what a deposit or an opening risks.
        expect(tokenReasons(s, 'pools'), text).toEqual({ refused: [], unchecked: [], warned: [] });
        expect(tokenReasons(s, 'deposits'), text).toEqual({ refused: [], unchecked: [], warned: [] });
      }
    }
    // An accent or an emoji is not a look-alike letter.
    for (const name of ['Café Crème', 'Corn \u{1f33d}']) expect(reasons(named(name, 'CORN')), name).toEqual({ blocks: [], warnings: [], verdict: 'ok' });
  });

  it('a copied name in EITHER name record is caught, not only the one shown', () => {
    const data = t22Mint(classicMint(), [pointer(null, mint), metadataExt(mint, null, 'Corn', 'CORN')]);
    const metaplex = acct(metadataPda(mint), METAPLEX_TOKEN_METADATA_ID.toBase58(), metaplexRecord(mint, false, 'USD Coin', 'USDC'));
    const s = classifyToken(mint.toBase58(), acct(mint, TOKEN_2022_PROGRAM, data), metaplex);
    expect(reasons(s)).toEqual({ blocks: [], warnings: ['copies-known-name'], verdict: 'warn' });
    expect(s.kind === 'read' && [s.name, s.symbol, s.metadataSource]).toEqual(['Corn', 'CORN', 'token-2022']);
  });

  it('a name kept at another account is said even when another name record was read', () => {
    const elsewhere = key();
    const data = t22Mint(classicMint(), [pointer(null, elsewhere)]);
    const s = classifyToken(mint.toBase58(), acct(mint, TOKEN_2022_PROGRAM, data), immutableName());
    expect(reasons(s)).toEqual({ blocks: [], warnings: ['metadata-elsewhere'], verdict: 'warn' });
    expect(s.kind === 'read' && s.warnings[0]!.text).toContain(elsewhere.toBase58());
    expect(s.kind === 'read' && s.name).toBe('Corn');
    // A pointer at the name record that WAS read is not "another account".
    const atRecord = t22Mint(classicMint(), [pointer(null, metadataPda(mint))]);
    expect(reasons(classifyToken(mint.toBase58(), acct(mint, TOKEN_2022_PROGRAM, atRecord), immutableName()))).toEqual({ blocks: [], warnings: [], verdict: 'ok' });
  });

  it('BAYLA here is the same mint the rest of the site calls BAYLA', () => {
    expect(BAYLA_MINT).toBe(SITE_BAYLA_MINT);
  });

  it('the island tokens here are the same mints the island lists (bungalows.ts)', () => {
    for (const label of ['BOBO', 'SOY', 'BRAINLET', 'RIZZ']) {
      const listed = WELL_KNOWN_NAMES.find((k) => k.label === label);
      const island = BUNGALOWS.find((b) => b.chain === 'solana' && b.symbol === label);
      expect(listed, label).toBeDefined();
      expect(island, label).toBeDefined();
      expect(listed!.mint, label).toBe(island!.address);
      expect(listed!.names, label).toEqual([label]);
    }
  });

  it('a copied island name (BOBO, SOY, BRAINLET, RIZZ) from another mint is warned about; the real mint is not', () => {
    const cases: [string, string, string][] = [
      ['Bobo the Bear', 'BOBO', 'NOT the real BOBO'],
      ['B.O.B.O', 'X', 'NOT the real BOBO'],
      ['BОBО', 'X', 'NOT the real BOBO'], // Cyrillic capital O, twice
      ['Soy', 'SOY', 'NOT the real SOY'],
      ['Brainlet', 'BRAINLET', 'NOT the real BRAINLET'],
      ['Rizz', 'RIZZ', 'NOT the real RIZZ'],
    ];
    for (const [name, symbol, says] of cases) {
      const m = key();
      const s = classifyToken(m.toBase58(), acct(m, TOKEN_PROGRAM, classicMint()), acct(metadataPda(m), METAPLEX_TOKEN_METADATA_ID.toBase58(), metaplexRecord(m, false, name, symbol)));
      expect(reasons(s), name + ' / ' + symbol).toEqual({ blocks: [], warnings: ['copies-known-name'], verdict: 'warn' });
      expect(s.kind === 'read' && s.warnings[0]!.text).toContain(says);
    }
    for (const label of ['BOBO', 'SOY', 'BRAINLET', 'RIZZ']) {
      const real = new PublicKey(WELL_KNOWN_NAMES.find((k) => k.label === label)!.mint!);
      const s = classifyToken(real.toBase58(), acct(real, TOKEN_PROGRAM, classicMint()), acct(metadataPda(real), METAPLEX_TOKEN_METADATA_ID.toBase58(), metaplexRecord(real, false, label, label)));
      expect(reasons(s), label).toEqual({ blocks: [], warnings: [], verdict: 'ok' });
    }
  });

  it('SOL itself, a non-mint and an empty address are never a clean verdict', () => {
    expect(reasons(classifyToken(WSOL_MINT, acct(WSOL_MINT, TOKEN_PROGRAM, classicMint()), null))).toMatchObject({ verdict: 'blocked', blocks: ['is-sol'] });
    expect(reasons(classifyToken(mint.toBase58(), acct(mint, '11111111111111111111111111111111', new Uint8Array(0)), null))).toMatchObject({ verdict: 'blocked', blocks: ['not-a-mint'] });
    expect(classifyToken(mint.toBase58(), null, null).kind).toBe('absent');
  });
});

describe('readTokenSafety', () => {
  it('reads each mint and its name record in ONE call', async () => {
    const a = key();
    const calls: unknown[][] = [];
    const rpc = async (method: string, params: unknown[]) => {
      calls.push([method, params]);
      const [addrs] = params as [string[]];
      return {
        value: addrs.map((x) => (x === a.toBase58() ? { data: [Buffer.from(classicMint()).toString('base64'), 'base64'], owner: TOKEN_PROGRAM, lamports: 1 } : null)),
      };
    };
    const out = await readTokenSafety(rpc, [a.toBase58(), a.toBase58()]);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('getMultipleAccounts');
    expect((calls[0]![1] as [string[]])[0]).toEqual([a.toBase58(), metadataPda(a).toBase58()]);
    expect(reasons(out.get(a.toBase58())!)).toEqual({ blocks: [], warnings: ['no-metadata'], verdict: 'warn' });
  });

  it('a failed or malformed read is unread for every mint, never a verdict', async () => {
    const a = key().toBase58();
    const b = key().toBase58();
    for (const rpc of [
      async () => { throw new Error('HTTP 502'); },
      async () => ({}),
      async () => ({ value: [null] }), // wrong length
      async () => ({ value: [{ owner: TOKEN_PROGRAM, lamports: 1 }, null, null, null] }), // no data
    ]) {
      const out = await readTokenSafety(rpc, [a, b]);
      expect(out.get(a)!.kind).toBe('unread');
      expect(out.get(b)!.kind).toBe('unread');
    }
  });
});
