import { PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { clipDetail } from '../../launcher/solana/curve/read';
import { decodeTokenMetadata } from '../../launcher/solana/discover/metadata';
import { METAPLEX_TOKEN_METADATA_ID, metadataPda } from '../../launcher/solana/write/metaplex';
import { foldForCompare, foldedForms, impersonatesAll } from '../../launchMetadata/validate';
import { getMultipleAccounts, type RawAccount } from './accounts';

/**
 * May this token go in a pool here, and what must its holder be told first? Read from the
 * mint itself, never from a name.
 *
 * THE RULE (owner ruling 2026-10-04). Any token may have a pool. What could go wrong is
 * said as a WARNING, on the token, in the form and again on the review, and the visitor
 * may go on. Only three kinds of token are BLOCKED:
 *
 *   - what is not a token a pool can hold: an address that is not a mint, a mint that was
 *     never set up, and wrapped SOL itself (it is the other side of a pool);
 *   - what the POOL PROGRAM rejects. cp-swap (utils/token.rs `is_supported_mint`) takes
 *     every classic SPL token, and a Token-2022 token only when each of its extensions is
 *     a transfer fee, a metadata pointer, token metadata, interest-bearing amounts or
 *     scaled amounts. Any other (a transfer hook, a default frozen state, a permanent
 *     delegate, a close authority, a pause switch, one nobody has listed yet) makes the
 *     opening fail on chain, so nothing is built for it;
 *   - what this site cannot let back OUT. The pool program also takes a transfer fee, and
 *     four stablecoins by name that carry a permanent delegate. This site cannot build an
 *     exact deposit or withdrawal for those, and nobody is let in who cannot be let out
 *     (the leave rule), so it opens and adds to no pool for them. That is this site's
 *     limit, not a judgement of the token, and the block says so.
 *
 * WARNED, and allowed:
 *
 *   - a live FREEZE authority can freeze any account that holds the token, a pool's own
 *     vault and the holder's own account included, and while a pool's vault is frozen
 *     nobody can take liquidity out of that pool (USDC and USDT keep one by design, which
 *     is said in its own words);
 *   - INTEREST-BEARING and SCALED amounts: the amount a wallet displays changes over
 *     time, while this site shows and moves raw token units;
 *   - a live MINT authority can mint without limit and drain the other side of a pool;
 *   - metadata that can still change means the name and picture can change;
 *   - a name copied from a well-known token, or written in look-alike letters.
 *
 * An unread mint is `unread`: never a verdict, and never a warning. A name or symbol is
 * shown as the token's own claim and nothing more; the mint address is the only identity.
 */

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/** BAYLA, the token of this site's Solana side (the same mint as bungalows.ts BAYLA_MINT, pinned by a test). */
export const BAYLA_MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';

/**
 * Names that belong to ONE token. A token calling itself one of these from any other
 * mint is a copy, however clean its mint looks. `mint: null` = there is no real one on
 * Solana (TOWELI lives on Ethereum only), so every claim is a copy.
 *
 * The island's tokens that have ONE real Solana mint in the island canon (bungalows.ts)
 * are listed, so "open the first BOBO pool here" with a look-alike BOBO is warned about
 * by name: Jupiter would price the copy, so the price check alone cannot catch it. Each
 * mint is pinned by a test to its bungalows.ts entry.
 *
 * Launch tickers are still not listed: anyone can launch the same ticker on our
 * launcher, so there is no single "real" one to compare against. The mint address stays
 * the only identity, and the card says so on every token.
 */
export const WELL_KNOWN_NAMES: readonly { label: string; mint: string | null; names: readonly string[] }[] = [
  { label: 'SOL', mint: WSOL_MINT, names: ['SOL', 'WSOL', 'Wrapped SOL', 'Solana', 'Wrapped Solana'] },
  { label: 'USDC', mint: USDC_MINT, names: ['USDC', 'USD Coin', 'USDCoin'] },
  { label: 'USDT', mint: USDT_MINT, names: ['USDT', 'Tether', 'Tether USD', 'USDTether'] },
  { label: 'BAYLA', mint: BAYLA_MINT, names: ['BAYLA'] },
  { label: 'TOWELI', mint: null, names: ['TOWELI'] },
  { label: 'BOBO', mint: '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump', names: ['BOBO'] },
  { label: 'SOY', mint: '8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump', names: ['SOY'] },
  { label: 'BRAINLET', mint: '4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump', names: ['BRAINLET'] },
  { label: 'RIZZ', mint: '5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k', names: ['RIZZ'] },
];

// Names are compared with the launcher's own rules (launchMetadata/validate.js), never
// a second copy of them: its skeleton reads "S0L", "SoIana" and "TOWELl" as SOL, Solana
// and TOWELI, and its brand rule finds BAYLA inside "BAYLA Token" and "BAYLA2". The
// LIST is this page's own (WELL_KNOWN_NAMES): a word the launcher refuses but that has
// no entry here (ETH, BONK, TEGRIDY) is not called a copy on this page.
const WELL_KNOWN_FOLDED = WELL_KNOWN_NAMES.flatMap((k) => k.names.map((n) => ({ folded: foldForCompare(n), known: k })));

/**
 * The well-known token any of `claims` (every name and symbol read for the mint) says
 * it is, when `mint` is not that token; else null.
 */
export function copiedWellKnownName(mint: string, claims: readonly string[]): (typeof WELL_KNOWN_NAMES)[number] | null {
  for (const claim of claims) {
    // The claim itself, and EVERY word the launcher's lists say it would be mistaken
    // for: its first answer for "BAYLA by Tegridy" is TEGRIDY, which is not on this list.
    const said = [...foldedForms(claim), ...impersonatesAll(claim).map(foldForCompare)];
    const hit = WELL_KNOWN_FOLDED.find((k) => said.includes(k.folded));
    if (hit && hit.known.mint !== mint) return hit.known;
  }
  return null;
}

/**
 * A letter or digit that is not plain A-Z or 0-9 once accents are taken off: Cyrillic,
 * Greek, small capitals, Cherokee and many more have letters shaped like Latin ones, and
 * no table lists them all. A warning, never a block: most such names copy nothing.
 */
const hasLookalikeLetters = (s: string) => /(?!\p{ASCII})[\p{L}\p{N}]/u.test(s.normalize('NFKD'));

/** USDC and USDT keep a freeze authority by design; the site accepts that and says so. */
export const FREEZE_AUTHORITY_ACCEPTED = new Set([USDC_MINT, USDT_MINT]);

/**
 * cp-swap's `MINT_WHITELIST` (utils/token.rs:18-23): Token-2022 mints the program accepts
 * whatever their extensions. All four carry a permanent delegate (USDP, GYEN, ZUSD, PYUSD).
 */
export const RAYDIUM_WHITELISTED_MINTS = new Set([
  'HVbpJAQGNpkgBaYBZQBR1t7yFdvaYVp2vCQQfKKEN4tM',
  'Crn4x1Y2HUKko7ox2EZMT6N2t2ZyH7eKtwkBGVnhEq1g',
  'FrBfWJ4qE5sCzKm3k3JaAtqZcXUh4LvJygDeketsrsH4',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
]);

/** spl-token-2022 `ExtensionType`, numbered as the program numbers them. */
export const EXTENSION = {
  TransferFeeConfig: 1,
  MintCloseAuthority: 3,
  ConfidentialTransferMint: 4,
  DefaultAccountState: 6,
  NonTransferable: 9,
  InterestBearingConfig: 10,
  PermanentDelegate: 12,
  TransferHook: 14,
  ConfidentialTransferFeeConfig: 16,
  MetadataPointer: 18,
  TokenMetadata: 19,
  GroupPointer: 20,
  TokenGroup: 21,
  GroupMemberPointer: 22,
  TokenGroupMember: 23,
  ConfidentialMintBurn: 24,
  ScaledUiAmountConfig: 25,
  PausableConfig: 26,
} as const;

const EXTENSION_PLAIN: Record<number, string> = {
  1: 'a transfer fee, which its owner can raise as high as 100%',
  3: 'a close authority, which can delete the token entirely',
  4: 'confidential transfers, which hide balances',
  6: 'a default account state, which can make new accounts start frozen',
  9: 'non-transferable, so it cannot move in or out of a pool',
  10: 'interest-bearing amounts, so the amount a wallet displays for it grows over time',
  12: 'a permanent delegate, which can take tokens out of any account, the pool’s included',
  14: 'a transfer hook, a program that runs on every transfer and can refuse or redirect it',
  16: 'confidential transfer fees',
  20: 'a group pointer',
  21: 'a token group',
  22: 'a group member pointer',
  23: 'group membership',
  24: 'confidential minting and burning',
  25: 'scaled amounts, so the amount a wallet displays for it changes when its issuer changes the scale',
  26: 'a pause switch, which can stop every transfer',
};

/**
 * The Token-2022 extensions this site builds for: the two that carry the token's name, and
 * the two whose raw amounts stay exact (interest-bearing and scaled amounts only change
 * what a wallet DISPLAYS). ONE set on purpose. The verdict below, the size of a pool's
 * vault, and all three builders (open a pool, add, remove) read this same set, so the
 * site lets in exactly what it can let out. Every one is on the pool program's own list;
 * a transfer fee is on that list too, and is left out here because this site cannot
 * build an exact withdrawal for it.
 */
export const BUILDABLE_EXTENSIONS: ReadonlySet<number> = new Set([
  EXTENSION.MetadataPointer,
  EXTENSION.TokenMetadata,
  EXTENSION.InterestBearingConfig,
  EXTENSION.ScaledUiAmountConfig,
]);

export function extensionPlain(type: number): string {
  return EXTENSION_PLAIN[type] ?? `an extension this site does not know (type ${type})`;
}

/* ─────────────────────────────── decoding ──────────────────────────────── */

export interface Token2022Metadata {
  updateAuthority: string | null;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
}

export interface MintFacts {
  program: 'spl-token' | 'token-2022';
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  /** Token-2022 extension types, in the order they sit in the account. Empty for classic SPL. */
  extensions: number[];
  metadataPointer: { authority: string | null; metadataAddress: string | null } | null;
  tokenMetadata: Token2022Metadata | null;
}

export type MintDecode = { ok: true; value: MintFacts } | { ok: false; reason: string };

const BASE_MINT_LEN = 82;
/** Token-2022: the base Mint, zero padding up to the Account length, then one AccountType byte. */
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;
const TLV_START = 166;

const b58 = (bytes: Uint8Array) => new PublicKey(bytes).toBase58();
const isZero = (bytes: Uint8Array) => bytes.every((b) => b === 0);
/** `OptionalNonZeroPubkey`: all zeroes means "none". */
const optionalNonZero = (bytes: Uint8Array) => (isZero(bytes) ? null : b58(bytes));

function decodeTlvString(d: Uint8Array, o: number, end: number): { value: string; next: number } | null {
  if (o + 4 > end) return null;
  const len = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
  if (o + 4 + len > end) return null;
  return { value: new TextDecoder('utf-8', { fatal: false }).decode(d.subarray(o + 4, o + 4 + len)), next: o + 4 + len };
}

/**
 * Decode a mint account by its owner and bytes. By offset, like every decoder in this
 * repo, and pinned in the tests against @solana/spl-token's own unpacking.
 */
export function decodeMintAccount(owner: string, data: Uint8Array): MintDecode {
  const program = owner === TOKEN_PROGRAM ? 'spl-token' : owner === TOKEN_2022_PROGRAM ? 'token-2022' : null;
  if (!program) return { ok: false, reason: 'the account is not owned by a token program' };
  if (data.length < BASE_MINT_LEN) return { ok: false, reason: 'the account is too short to be a token mint' };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const opt = (tag: number) => {
    const t = view.getUint32(tag, true);
    if (t === 0) return { ok: true as const, value: null };
    if (t === 1) return { ok: true as const, value: b58(data.subarray(tag + 4, tag + 36)) };
    return { ok: false as const };
  };
  const mintAuthority = opt(0);
  const freezeAuthority = opt(46);
  if (!mintAuthority.ok || !freezeAuthority.ok) return { ok: false, reason: 'the mint’s authority fields are malformed' };
  const facts: MintFacts = {
    program,
    mintAuthority: mintAuthority.value,
    freezeAuthority: freezeAuthority.value,
    supply: view.getBigUint64(36, true),
    decimals: data[44]!,
    isInitialized: data[45] === 1,
    extensions: [],
    metadataPointer: null,
    tokenMetadata: null,
  };

  if (program === 'spl-token') {
    if (data.length !== BASE_MINT_LEN) return { ok: false, reason: 'a classic token mint must be exactly 82 bytes' };
    return { ok: true, value: facts };
  }

  if (data.length === BASE_MINT_LEN) return { ok: true, value: facts };
  if (data.length <= ACCOUNT_TYPE_OFFSET) return { ok: false, reason: 'the Token-2022 mint has a malformed length' };
  if (!isZero(data.subarray(BASE_MINT_LEN, ACCOUNT_TYPE_OFFSET))) {
    return { ok: false, reason: 'the Token-2022 mint carries data where padding should be' };
  }
  if (data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) return { ok: false, reason: 'the Token-2022 account is not a mint' };

  let o = TLV_START;
  while (o + 4 <= data.length) {
    const type = view.getUint16(o, true);
    const len = view.getUint16(o + 2, true);
    // spl-token-2022 stops at the first Uninitialized entry: the rest is unused space.
    if (type === 0) break;
    const start = o + 4;
    const end = start + len;
    if (end > data.length) return { ok: false, reason: 'a Token-2022 extension runs past the end of the account' };
    facts.extensions.push(type);
    if (type === EXTENSION.MetadataPointer) {
      if (len !== 64) return { ok: false, reason: 'the metadata pointer extension is malformed' };
      facts.metadataPointer = {
        authority: optionalNonZero(data.subarray(start, start + 32)),
        metadataAddress: optionalNonZero(data.subarray(start + 32, start + 64)),
      };
    } else if (type === EXTENSION.TokenMetadata) {
      if (len < 64 + 12) return { ok: false, reason: 'the token metadata extension is malformed' };
      const updateAuthority = optionalNonZero(data.subarray(start, start + 32));
      const mint = b58(data.subarray(start + 32, start + 64));
      const name = decodeTlvString(data, start + 64, end);
      const symbol = name && decodeTlvString(data, name.next, end);
      const uri = symbol && decodeTlvString(data, symbol.next, end);
      if (!name || !symbol || !uri) return { ok: false, reason: 'the token metadata extension is malformed' };
      facts.tokenMetadata = { updateAuthority, mint, name: name.value, symbol: symbol.value, uri: uri.value };
    }
    o = end;
  }
  return { ok: true, value: facts };
}

/* ───────────────────────────── the verdict ─────────────────────────────── */

export interface SafetyReason {
  code:
    | 'is-sol'
    | 'not-a-mint'
    | 'not-initialized'
    | 'freeze-authority'
    | 'freeze-authority-accepted'
    | 'permanent-delegate-whitelist'
    | 'transfer-fee'
    | 'extension'
    | 'interest-bearing'
    | 'scaled-amount'
    | 'mint-authority'
    | 'metadata-mutable'
    | 'no-metadata'
    | 'metadata-elsewhere'
    | 'metadata-unreadable'
    | 'copies-known-name'
    | 'lookalike-letters';
  text: string;
}

export type SafetyVerdict = 'blocked' | 'warn' | 'ok';

export type TokenSafety =
  /** We could not read the mint. Not a verdict about the token. */
  | { kind: 'unread'; mint: string; detail: string }
  /** The chain says there is no account at this address. */
  | { kind: 'absent'; mint: string }
  | {
      kind: 'read';
      mint: string;
      verdict: SafetyVerdict;
      blocks: SafetyReason[];
      warnings: SafetyReason[];
      facts: MintFacts | null;
      /** The token's OWN claims. Untrusted: render only through displaySafe, next to the mint. */
      name: string | null;
      symbol: string | null;
      metadataSource: 'token-2022' | 'metaplex' | 'none';
    };

/**
 * The verdict for one mint from its account and its Metaplex metadata account (either
 * may be null = absent). Pure.
 */
export function classifyToken(mint: string, mintAccount: RawAccount | null, metaplexAccount: RawAccount | null): TokenSafety {
  if (!mintAccount) return { kind: 'absent', mint };
  const blocks: SafetyReason[] = [];
  const warnings: SafetyReason[] = [];
  const done = (facts: MintFacts | null, name: string | null, symbol: string | null, metadataSource: 'token-2022' | 'metaplex' | 'none'): TokenSafety => ({
    kind: 'read',
    mint,
    verdict: blocks.length ? 'blocked' : warnings.length ? 'warn' : 'ok',
    blocks,
    warnings,
    facts,
    name,
    symbol,
    metadataSource,
  });

  if (mint === WSOL_MINT) {
    blocks.push({ code: 'is-sol', text: 'This is wrapped SOL. Pools here pair a token WITH SOL: look up the other token.' });
    return done(null, null, null, 'none');
  }
  const decoded = decodeMintAccount(mintAccount.owner, mintAccount.data);
  if (!decoded.ok) {
    blocks.push({ code: 'not-a-mint', text: `This address is not a token this site can use: ${decoded.reason}.` });
    return done(null, null, null, 'none');
  }
  const f = decoded.value;
  if (!f.isInitialized) blocks.push({ code: 'not-initialized', text: 'This token mint was never set up.' });

  if (f.freezeAuthority) {
    if (FREEZE_AUTHORITY_ACCEPTED.has(mint)) {
      warnings.push({
        code: 'freeze-authority-accepted',
        text: `Its issuer can freeze accounts (${f.freezeAuthority}). That is normal for ${mint === USDC_MINT ? 'USDC' : 'USDT'} and accepted here.`,
      });
    } else {
      warnings.push({
        code: 'freeze-authority',
        text: `Its creator can freeze any account that holds it (freeze authority ${f.freezeAuthority}), a pool’s own vault and your own account included. While a pool’s vault is frozen, nobody can take liquidity out of that pool.`,
      });
    }
  }

  // The four stablecoins the pool program takes by name, whatever their extensions.
  const takenByName = RAYDIUM_WHITELISTED_MINTS.has(mint);
  if (takenByName) {
    blocks.push({
      code: 'permanent-delegate-whitelist',
      text: 'This stablecoin has a permanent delegate, which can move tokens out of any account, a pool’s included. The pool program accepts it by name, but this site cannot build exact deposits and withdrawals for it, so it does not open or add to pools for it.',
    });
  }

  for (const e of f.extensions) {
    // The one set decides what may go in. Inside it, only the two that change what a
    // wallet displays need saying; a name and a picture need nothing.
    if (BUILDABLE_EXTENSIONS.has(e)) {
      if (e === EXTENSION.InterestBearingConfig || e === EXTENSION.ScaledUiAmountConfig) {
        warnings.push({
          code: e === EXTENSION.InterestBearingConfig ? 'interest-bearing' : 'scaled-amount',
          text: `It uses ${extensionPlain(e)}. This site shows and moves raw token units, so an amount here can differ from the one your wallet shows.`,
        });
      }
    } else if (e === EXTENSION.TransferFeeConfig) {
      // The pool program takes a transfer fee. The limit is this site's, and the words say so.
      blocks.push({
        code: 'transfer-fee',
        text: `It uses ${extensionPlain(e)}. This site cannot build exact deposits and withdrawals for a token that charges a transfer fee, so it does not open or add to pools for it.`,
      });
    } else if (!takenByName) {
      // Never said of the four stablecoins: the pool program takes those by name.
      blocks.push({ code: 'extension', text: `It uses ${extensionPlain(e)}. The pool program does not accept tokens with it.` });
    }
  }

  if (f.mintAuthority) {
    warnings.push({
      code: 'mint-authority',
      text: `Its creator can still mint more of it (mint authority ${f.mintAuthority}). New tokens sold into a pool take SOL out of it.`,
    });
  }

  // The name: Token-2022's own metadata when the mint carries it, else Metaplex. A mint
  // can carry both, and a wallet may show either, so `claims` keeps every one read.
  let name: string | null = null;
  let symbol: string | null = null;
  let source: 'token-2022' | 'metaplex' | 'none' = 'none';
  let anyMutable = false;
  const claims: string[] = [];
  let recordRead: string | null = null;
  const t22 = f.tokenMetadata && f.tokenMetadata.mint === mint ? f.tokenMetadata : null;
  if (t22) {
    name = t22.name;
    symbol = t22.symbol;
    source = 'token-2022';
    claims.push(t22.name, t22.symbol);
    if (t22.updateAuthority) anyMutable = true;
  }
  // Whoever controls the pointer can point the token at a different name record.
  if (f.metadataPointer?.authority) anyMutable = true;
  if (metaplexAccount) {
    if (metaplexAccount.owner !== METAPLEX_TOKEN_METADATA_ID.toBase58()) {
      warnings.push({ code: 'metadata-unreadable', text: 'Something sits at its name record address that is not a name record.' });
    } else {
      const d = decodeTokenMetadata(metaplexAccount.data, new PublicKey(mint));
      if (!d.ok) {
        warnings.push({ code: 'metadata-unreadable', text: 'Its name record could not be decoded.' });
      } else {
        if (!t22) {
          name = d.value.name;
          symbol = d.value.symbol;
          source = 'metaplex';
        }
        claims.push(d.value.name, d.value.symbol);
        recordRead = metaplexAccount.address;
        if (d.value.isMutable) anyMutable = true;
      }
    }
  }
  // A pointer to a name record this page did not read is said whether or not another
  // name was read. (The pointer may name the Metaplex record itself, which was read.)
  const pointsTo = f.metadataPointer?.metadataAddress ?? null;
  const elsewhere = pointsTo !== mint && pointsTo !== recordRead ? pointsTo : null;
  if (elsewhere) {
    warnings.push({
      code: 'metadata-elsewhere',
      text:
        source === 'none'
          ? `Its name is kept at another account (${elsewhere}) that this page does not read. Go by the mint address.`
          : `It also points to a name record at another account (${elsewhere}) that this page does not read, so a wallet may show a different name. Go by the mint address.`,
    });
  } else if (source === 'none') {
    warnings.push({ code: 'no-metadata', text: 'It has no name on chain. Only its mint address identifies it.' });
  }
  if (anyMutable) {
    warnings.push({ code: 'metadata-mutable', text: 'Its name, symbol and picture can still be changed by whoever controls them.' });
  }
  const copied = copiedWellKnownName(mint, claims);
  if (copied) {
    warnings.push({
      code: 'copies-known-name',
      text: copied.mint
        ? `It calls itself ${copied.label}, but it is NOT the real ${copied.label} (whose mint is ${copied.mint}). It is a different token that copied the name.`
        : `It calls itself ${copied.label}, but there is no real ${copied.label} on Solana. It is a different token that copied the name.`,
    });
  } else if (claims.some(hasLookalikeLetters)) {
    warnings.push({
      code: 'lookalike-letters',
      text: 'Its name or symbol uses letters or digits that are not plain A to Z or 0 to 9. Some of those look the same as plain ones, so it may be copying another token’s name. Go by the mint address.',
    });
  }
  return done(f, name, symbol, source);
}

/**
 * Read and classify several mints in ONE call (each mint plus its Metaplex record). A
 * failed call makes every one of them `unread`, never a verdict.
 */
export async function readTokenSafety(rpc: SolanaRpc, mints: string[]): Promise<Map<string, TokenSafety>> {
  const unique = [...new Set(mints)];
  const out = new Map<string, TokenSafety>();
  const valid: string[] = [];
  for (const m of unique) {
    try {
      new PublicKey(m);
      valid.push(m);
    } catch {
      out.set(m, { kind: 'unread', mint: m, detail: 'that is not a Solana address' });
    }
  }
  if (!valid.length) return out;
  const addresses = [...valid, ...valid.map((m) => metadataPda(new PublicKey(m)).toBase58())];
  let accounts: (RawAccount | null)[];
  try {
    accounts = await getMultipleAccounts(rpc, addresses);
  } catch (e) {
    const detail = clipDetail(e);
    for (const m of valid) out.set(m, { kind: 'unread', mint: m, detail });
    return out;
  }
  valid.forEach((m, i) => out.set(m, classifyToken(m, accounts[i] ?? null, accounts[valid.length + i] ?? null)));
  return out;
}
