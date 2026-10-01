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

  it('blocks a live freeze authority', () => {
    const s = classifyToken(mint.toBase58(), acct(mint, TOKEN_PROGRAM, classicMint({ freezeAuthority: key() })), immutableName());
    expect(reasons(s)).toMatchObject({ blocks: ['freeze-authority'], verdict: 'blocked' });
  });

  it('accepts USDC’s freeze authority, and says so', () => {
    const usdc = new PublicKey(USDC_MINT);
    const s = classifyToken(USDC_MINT, acct(usdc, TOKEN_PROGRAM, classicMint({ freezeAuthority: key() })), immutableName(usdc));
    expect(reasons(s)).toEqual({ blocks: [], warnings: ['freeze-authority-accepted'], verdict: 'warn' });
  });

  it('blocks the four stablecoins the pool program lets in by name', () => {
    for (const m of RAYDIUM_WHITELISTED_MINTS) {
      const pk = new PublicKey(m);
      const s = classifyToken(m, acct(pk, TOKEN_2022_PROGRAM, t22Mint(classicMint(), [tlv(ExtensionType.PermanentDelegate, key().toBytes())])), immutableName(pk));
      expect(s.kind === 'read' && s.blocks.map((b) => b.code)).toEqual(['permanent-delegate-whitelist', 'extension']);
    }
  });

  it('blocks every Token-2022 extension beyond the name, including ones the pool program allows', () => {
    const cases: [number, RegExp][] = [
      [ExtensionType.TransferHook, /transfer hook/],
      [ExtensionType.PermanentDelegate, /permanent delegate/],
      [ExtensionType.TransferFeeConfig, /transfer fee/],
      [ExtensionType.InterestBearingConfig, /interest/],
      [ExtensionType.DefaultAccountState, /frozen/],
      [99, /does not know \(type 99\)/],
    ];
    for (const [type, text] of cases) {
      const data = t22Mint(classicMint(), [pointer(null, mint), tlv(type, new Uint8Array(8)), metadataExt(mint, null)]);
      const s = classifyToken(mint.toBase58(), acct(mint, TOKEN_2022_PROGRAM, data), null);
      expect(s.kind === 'read' && s.verdict).toBe('blocked');
      expect(s.kind === 'read' && s.blocks[0]!.text).toMatch(text);
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
    const s2 = classifyToken(mint.toBase58(), acct(mint, TOKEN_PROGRAM, classicMint()), acct(metadataPda(mint), METAPLEX_TOKEN_METADATA_ID.toBase58(), metaplexRecord(mint, true)));
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
