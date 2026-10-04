// The e2e test wallet's own check, run in NODE before it signs anything.
//
// This is a stand-in for the careful wallet a real user deserves, and a second,
// independent opinion on what set T builds. It reads every instruction of the exact
// bytes it was handed and refuses anything that could move the signer's money somewhere
// the screen did not say: an unknown program, a System or Token transfer / approve /
// set-authority (Token-2022 only as the exact $BAYLA plant of a launch), a token account
// that is not the signer's own, a zero slippage floor,
// a creator or fee recipient that is not the one the chain records (including where
// create_launch pays the platform reserve), a swap whose output
// goes to someone else (cp-swap does not check that owner itself: swap_base_input.rs
// has output_token_account as a bare #[account(mut)]).
//
// Liquidity (stage 2): a deposit or withdrawal is checked against the pool AS THE CHAIN
// RECORDS IT, read here in Node; a token account is accepted under Token-2022 only when
// the mint itself is owned by Token-2022 on chain; a WSOL account that already held
// wrapped SOL before the transaction is never closed (that would unwrap the person's own
// money); and no Token-2022 instruction is ever sent at the top level, except a launch's
// exact $BAYLA plant (refused outright in a liquidity transaction, which launches nothing).
// Opening a pool (create): only on fee tier 1 (tier 0 refused by name), at the standard
// address or a co-signing fresh key, open at once, every account derived here, and the
// only account the transaction may open itself is the wallet's wrapped-SOL account.
//
// Pairing coins (owner ruling 2026-10-03): a pool pairs a token with SOL, USDC or BAYLA
// (coins.ts, written out by hand). Only SOL is ever wrapped. So a transaction that opens,
// adds to or takes from a pool paired with USDC or BAYLA may not wrap SOL, sync or close a
// wrapped-SOL account, or open one. An opening paired with one of them therefore opens no
// account at all: the coin is spent from the wallet's own account for it.
//
// Account POSITIONS come from the release IDLs (pinned by sha256 in genesis-accounts.mjs),
// never from the frontend's ix.ts, so a builder bug cannot pass its own check here.
import { PublicKey, VersionedTransaction, type MessageCompiledInstruction } from '@solana/web3.js';
// @ts-expect-error -- a plain .mjs module shared with the validator scripts; it has no types
import { loadVerifiedIdls } from '../../scripts/solana-localnet/genesis-accounts.mjs';
import { chain, LAUNCH_PROGRAM, CP_SWAP_PROGRAM, METAPLEX, WSOL, ata, curve, globalConfig, tokenAmount } from './chain';
import { poolStatePda, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID } from '../../src/lib/launcher/solana/curve/program';
import { BAYLA_DECIMALS, BAYLA_MINT, PLANT_HALF, TOKEN_2022, WORKSHOP_BAYLA_ACCOUNT, baylaAccount } from './bayla';
import { coinOfPool } from './coins';

export const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');
/** Critic A6: our own transactions pay at most 0.001 SOL of priority fee. */
export const MAX_PRIORITY_LAMPORTS = 1_000_000n;
export const LAUNCH_INDEX = PublicKey.findProgramAddressSync([Buffer.from('launch-index')], LAUNCH_PROGRAM)[0];
const U64_MAX = (1n << 64n) - 1n;
/** cp-swap's one authority over every vault and pool-share mint (seed from the program source). */
const CP_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('vault_and_lp_mint_auth_seed')], CP_SWAP_PROGRAM)[0];

interface IdlAccountMeta { name: string; address?: string }
interface IdlIx { name: string; discriminator: number[]; accounts: IdlAccountMeta[] }
interface IdlField { name: string; type: unknown }
interface CpIdl {
  instructions: IdlIx[];
  accounts: { name: string; discriminator: number[] }[];
  types: { name: string; type: { fields?: IdlField[] } }[];
}
interface Idls { launchIdl: { instructions: IdlIx[] }; cpIdl: CpIdl }
let idls: Idls | null = null;
function loadIdls(): Idls {
  idls ??= loadVerifiedIdls() as Idls | null;
  if (!idls) throw new Error('the e2e wallet cannot check transactions: no pinned IDL found (solana/tegridy-amm/idl or TEGRIDY_RELEASE_ARTIFACTS)');
  return idls;
}

export class GuardRefusal extends Error {}
const refuse = (why: string): never => { throw new GuardRefusal(why); };

/** One decoded instruction, kept on the wallet's record so a spec can assert on what was SIGNED. */
export interface SignedIx {
  program: 'compute-budget' | 'system' | 'token' | 'token-2022' | 'ata' | 'metaplex' | 'launch' | 'cp-swap';
  name: string;
  args: Record<string, string>;
  accounts: Record<string, string>;
}

function matchIdl(list: IdlIx[], data: Uint8Array): IdlIx | null {
  return list.find((ix) => ix.discriminator.every((b, i) => data[i] === b)) ?? null;
}
const u64 = (d: Uint8Array, o: number) => Buffer.from(d).readBigUInt64LE(o);
const u32 = (d: Uint8Array, o: number) => Buffer.from(d).readUInt32LE(o);

// ── a pool, read from the chain in Node with the PINNED IDL's own layout ──────
// Never the frontend's decodePoolState: a layout bug there must not agree with itself here.

const SCALAR_SIZE: Record<string, number> = { pubkey: 32, u8: 1, bool: 1, u16: 2, u32: 4, u64: 8, u128: 16 };
function fieldSize(t: unknown): number {
  if (typeof t === 'string' && SCALAR_SIZE[t]) return SCALAR_SIZE[t];
  const arr = (t as { array?: [unknown, number] } | null)?.array;
  if (arr) return fieldSize(arr[0]) * arr[1];
  throw new Error(`the guard cannot size IDL type ${JSON.stringify(t)}`);
}

/** The pubkeys of a cp-swap PoolState that the guard pins against. */
export interface GuardPool {
  address: PublicKey;
  ammConfig: PublicKey; poolCreator: PublicKey;
  token0Vault: PublicKey; token1Vault: PublicKey; lpMint: PublicKey;
  token0Mint: PublicKey; token1Mint: PublicKey; token0Program: PublicKey; token1Program: PublicKey;
  observationKey: PublicKey;
}
let poolOffsets: Map<string, number> | null = null;
function poolLayout(cpIdl: CpIdl): Map<string, number> {
  if (poolOffsets) return poolOffsets;
  const t = cpIdl.types.find((x) => x.name === 'PoolState')?.type.fields ?? refuse('the pinned IDL has no PoolState');
  const m = new Map<string, number>();
  let o = 8;
  for (const f of t) { m.set(f.name, o); o += fieldSize(f.type); }
  poolOffsets = m;
  return m;
}
async function readPool(address: PublicKey, cpIdl: CpIdl): Promise<GuardPool> {
  const a = await chain().getAccountInfo(address, 'confirmed');
  if (!a) refuse(`the pool ${address.toBase58()} does not exist on chain`);
  if (!a!.owner.equals(CP_SWAP_PROGRAM)) refuse(`${address.toBase58()} is not a pool of the pool program (owner ${a!.owner.toBase58()})`);
  const disc = cpIdl.accounts.find((x) => x.name === 'PoolState')?.discriminator ?? refuse('the pinned IDL has no PoolState discriminator');
  const d = a!.data;
  if (!disc.every((b, i) => d[i] === b)) refuse(`${address.toBase58()} is not a PoolState`);
  const L = poolLayout(cpIdl);
  const pk = (name: string) => {
    const o = L.get(name) ?? refuse(`the pinned PoolState has no ${name}`);
    if (d.length < o + 32) refuse(`${address.toBase58()} is too short for a PoolState`);
    return new PublicKey(d.subarray(o, o + 32));
  };
  return {
    address,
    ammConfig: pk('amm_config'), poolCreator: pk('pool_creator'),
    token0Vault: pk('token_0_vault'), token1Vault: pk('token_1_vault'), lpMint: pk('lp_mint'),
    token0Mint: pk('token_0_mint'), token1Mint: pk('token_1_mint'),
    token0Program: pk('token_0_program'), token1Program: pk('token_1_program'),
    observationKey: pk('observation_key'),
  };
}

/** A classic token account read from the chain: its mint and owner fields, or null when absent. */
async function readClassicTokenAccount(address: PublicKey): Promise<{ mint: PublicKey; owner: PublicKey; amount: bigint } | null> {
  const a = await chain().getAccountInfo(address, 'confirmed');
  if (!a) return null;
  if (!a.owner.equals(TOKEN_PROGRAM_ID) || a.data.length !== 165) refuse(`${address.toBase58()} is not a classic token account`);
  return { mint: new PublicKey(a.data.subarray(0, 32)), owner: new PublicKey(a.data.subarray(32, 64)), amount: a.data.readBigUInt64LE(64) };
}

/**
 * Check a serialized transaction the page asked the wallet to sign. Returns what it
 * decoded; throws GuardRefusal on anything outside the allowed shapes.
 */
export async function checkTransaction(bytes: Uint8Array, wallet: PublicKey): Promise<SignedIx[]> {
  const { launchIdl, cpIdl } = loadIdls();
  const vt = VersionedTransaction.deserialize(bytes);
  const msg = vt.message;
  if (msg.addressTableLookups.length > 0) refuse('address lookup tables are not used by this site');
  const keys = msg.staticAccountKeys;
  const nSigners = msg.header.numRequiredSignatures;
  if (!keys[0]?.equals(wallet)) refuse(`fee payer is ${keys[0]?.toBase58()}, not this wallet`);
  const signers = keys.slice(0, nSigners);
  const otherSigners = signers.filter((k) => !k.equals(wallet));
  const walletWsol = ata(WSOL, wallet);

  const initializeIx = cpIdl.instructions.find((x) => x.name === 'initialize') ?? refuse('the pinned IDL has no initialize');
  /** This transaction opens a pool (a cp-swap initialize anywhere in it). */
  const opening = (msg.compiledInstructions as MessageCompiledInstruction[]).some(
    (ci) => keys[ci.programIdIndex].equals(CP_SWAP_PROGRAM) && initializeIx.discriminator.every((b, i) => ci.data[i] === b),
  );
  const out: SignedIx[] = [];
  let cuLimit: bigint | null = null;
  let cuPrice = 0n;
  const createdMints: PublicKey[] = [];
  const launchedMints: PublicKey[] = [];
  const plant = { burns: 0, gives: 0 };
  let g: Awaited<ReturnType<typeof globalConfig>> | null = null;
  const getGlobal = async () => (g ??= await globalConfig());
  /** The program that owns a mint, read from the chain once per check (null: no such account). */
  const mintOwners = new Map<string, PublicKey | null>();
  const mintOwner = async (mint: PublicKey) => {
    const k = mint.toBase58();
    if (!mintOwners.has(k)) mintOwners.set(k, (await chain().getAccountInfo(mint, 'confirmed'))?.owner ?? null);
    return mintOwners.get(k) ?? null;
  };
  /** What the wallet's own WSOL account held BEFORE this transaction (read from the chain; null = absent). */
  let wsolBefore: bigint | null | undefined;
  const wsolHeldBefore = async () => (wsolBefore === undefined ? (wsolBefore = await tokenAmount(walletWsol)) : wsolBefore);

  for (const ci of msg.compiledInstructions as MessageCompiledInstruction[]) {
    const program = keys[ci.programIdIndex];
    const acc = ci.accountKeyIndexes.map((i) => keys[i]);
    const d = ci.data;
    const named = (ix: IdlIx) => {
      const m: Record<string, PublicKey> = {};
      ix.accounts.forEach((a, i) => { if (acc[i]) m[a.name] = acc[i]; });
      return m;
    };
    const show = (m: Record<string, PublicKey>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toBase58()]));

    if (program.equals(COMPUTE_BUDGET)) {
      if (d[0] === 2) { cuLimit = BigInt(u32(d, 1)); out.push({ program: 'compute-budget', name: 'set-compute-unit-limit', args: { units: String(cuLimit) }, accounts: {} }); continue; }
      if (d[0] === 3) { cuPrice = u64(d, 1); out.push({ program: 'compute-budget', name: 'set-compute-unit-price', args: { microLamports: String(cuPrice) }, accounts: {} }); continue; }
      refuse(`compute-budget instruction ${d[0]} is not one this site sends`);
    }

    if (program.equals(SYSTEM_PROGRAM_ID)) {
      const tag = u32(d, 0);
      if (tag === 0) { // CreateAccount {lamports, space, owner}
        const space = u64(d, 12);
        const owner = new PublicKey(d.slice(20, 52));
        if (!acc[0].equals(wallet)) refuse('createAccount is paid by someone else');
        if (!otherSigners.some((s) => s.equals(acc[1]))) refuse('createAccount of an account that is not a fresh co-signer');
        if (space !== 82n || !owner.equals(TOKEN_PROGRAM_ID)) refuse(`createAccount of ${space} bytes owned by ${owner.toBase58()} is not a new mint`);
        createdMints.push(acc[1]);
        out.push({ program: 'system', name: 'create-mint-account', args: { lamports: String(u64(d, 4)), space: String(space) }, accounts: { mint: acc[1].toBase58() } });
        continue;
      }
      if (tag === 2) { // Transfer {lamports}
        if (!acc[0].equals(wallet) || !acc[1].equals(walletWsol)) refuse(`a SOL transfer to ${acc[1]?.toBase58()}, which is not this wallet's own WSOL account`);
        out.push({ program: 'system', name: 'wrap-sol', args: { lamports: String(u64(d, 4)) }, accounts: { to: acc[1].toBase58() } });
        continue;
      }
      refuse(`system instruction ${tag} is not one this site sends`);
    }

    if (program.equals(TOKEN_PROGRAM_ID)) {
      const tag = d[0];
      if (tag === 20) { // InitializeMint2 {decimals, mint_authority, freeze COption}
        if (!createdMints.some((m) => m.equals(acc[0]))) refuse('initializeMint2 on a mint this transaction did not create');
        const auth = new PublicKey(d.slice(2, 34));
        if (d[1] !== 6 || !auth.equals(wallet) || d[34] !== 0) refuse('the new mint is not 6 decimals / authority = you / no freeze authority');
        out.push({ program: 'token', name: 'initialize-mint', args: { decimals: String(d[1]) }, accounts: { mint: acc[0].toBase58() } });
        continue;
      }
      if (tag === 17) { // SyncNative
        if (!acc[0].equals(walletWsol)) refuse('syncNative on an account that is not your WSOL account');
        out.push({ program: 'token', name: 'sync-native', args: {}, accounts: { account: acc[0].toBase58() } });
        continue;
      }
      if (tag === 9) { // CloseAccount [account, destination, owner]
        if (!acc[0].equals(walletWsol) || !acc[1].equals(wallet) || !acc[2].equals(wallet)) refuse('closeAccount that does not return your own WSOL to you');
        // Closing a WSOL account unwraps EVERYTHING in it. One that already held wrapped SOL
        // before this transaction is the person's own money: the site keeps it, never unwraps it.
        const held = await wsolHeldBefore();
        if (held !== null && held > 0n) refuse(`closeAccount of your WSOL account, which already held ${held} wrapped lamports before this transaction: it would unwrap SOL this transaction did not put there`);
        out.push({ program: 'token', name: 'close-wsol', args: {}, accounts: { account: acc[0].toBase58() } });
        continue;
      }
      refuse(`token instruction ${tag} (transfer / approve / set-authority / …) is never sent by this site`);
    }

    // Token-2022 is the $BAYLA plant and nothing else: burnChecked 50,000 from your own
    // $BAYLA account, and transferChecked 50,000 from it to the Workshop's $BAYLA account.
    // Exact size, accounts, amount and decimals; at most one of each; a launch only.
    // Any other top-level Token-2022 instruction is refused: Token-2022 accounts are only
    // ever opened through the associated-token program, and moved by the pool program
    // inside its own instruction.
    if (program.equals(TOKEN_2022)) {
      const tag = d[0];
      if (tag !== 15 && tag !== 12) refuse(`top-level Token-2022 instruction ${tag} is not the plant's burn or transfer, and this site sends no other`);
      const burn = tag === 15;
      if (d.length !== 10) refuse(`a Token-2022 instruction of ${d.length} bytes is not the plant`);
      if (acc.length !== (burn ? 3 : 4)) refuse(`the plant's ${burn ? 'burn' : 'transfer'} names ${acc.length} accounts`);
      const from = baylaAccount(wallet);
      if (!acc[0].equals(from)) refuse('the plant spends from an account that is not your own $BAYLA account');
      if (!acc[1].equals(BAYLA_MINT)) refuse('the plant moves a token other than $BAYLA');
      if (!burn && !acc[2].equals(WORKSHOP_BAYLA_ACCOUNT)) refuse("the plant sends $BAYLA somewhere other than the island's Workshop account");
      if (!acc[burn ? 2 : 3].equals(wallet)) refuse('the plant is authorised by someone other than you');
      const amount = u64(d, 1);
      if (amount !== PLANT_HALF) refuse(`the plant ${burn ? 'burns' : 'sends'} ${amount} base units, not 50,000 $BAYLA`);
      if (d[9] !== BAYLA_DECIMALS) refuse(`the plant names ${d[9]} decimals for $BAYLA`);
      if (burn ? plant.burns++ : plant.gives++) refuse('the transaction plants more than once');
      out.push({
        program: 'token-2022',
        name: burn ? 'plant-burn' : 'plant-transfer',
        args: { amount: String(amount), decimals: String(d[9]) },
        accounts: burn ? { from: from.toBase58(), mint: acc[1].toBase58() } : { from: from.toBase58(), mint: acc[1].toBase58(), to: acc[2].toBase58() },
      });
      continue;
    }

    if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (!(d.length === 0 || (d.length === 1 && (d[0] === 0 || d[0] === 1)))) refuse('unknown associated-token instruction');
      const [payer, account, owner, mint, , tokenProgram] = acc;
      if (!payer.equals(wallet) || !owner.equals(wallet)) refuse('a token account that is not your own');
      // An opening makes ONLY the wrapped-SOL account here: the pool program opens the
      // pool-share account itself (one made first would make it fail), and the token
      // account must already hold the tokens going in.
      if (opening && !mint.equals(WSOL)) refuse(`an opening creates only your wrapped-SOL account, not one for ${mint.toBase58()} (the pool program opens your pool-share account itself)`);
      // The token program is the MINT's owner, read from the chain (a mint this transaction
      // creates is classic). A classic-seeded account for a Token-2022 mint, or the other way
      // round, is someone else's address, or no account at all.
      const mintProgram = createdMints.some((m) => m.equals(mint)) ? TOKEN_PROGRAM_ID : await mintOwner(mint);
      if (!mintProgram) refuse(`a token account for ${mint.toBase58()}, which is not a mint on chain`);
      if (!mintProgram!.equals(TOKEN_PROGRAM_ID) && !mintProgram!.equals(TOKEN_2022_PROGRAM_ID)) refuse(`a token account for ${mint.toBase58()}, owned by ${mintProgram!.toBase58()}, which is not a token program`);
      if (!tokenProgram?.equals(mintProgram!)) refuse(`a token account under ${tokenProgram?.toBase58()} for a mint owned by ${mintProgram!.toBase58()}`);
      if (!account.equals(ata(mint, wallet, mintProgram!))) refuse('a token account that is not your own (not the address your wallet has under the mint\'s own token program)');
      out.push({ program: 'ata', name: d[0] === 1 ? 'create-idempotent' : 'create', args: { tokenProgram: mintProgram!.toBase58() }, accounts: { account: account.toBase58(), mint: mint.toBase58() } });
      continue;
    }

    if (program.equals(METAPLEX)) {
      if (d[0] !== 33) refuse(`Token Metadata instruction ${d[0]} is not CreateMetadataAccountV3`);
      let o = 1;
      const str = () => { const n = u32(d, o); o += 4; const s = Buffer.from(d.slice(o, o + n)).toString('utf8'); o += n; return s; };
      const name = str(); const symbol = str(); const uri = str();
      o += 2; // seller fee bps
      if (d[o] !== 0 || d[o + 1] !== 0 || d[o + 2] !== 0) refuse('metadata with creators / collection / uses');
      o += 3;
      if (d[o] !== 0) refuse('metadata left MUTABLE: the name, symbol and picture could be changed after people buy');
      const [metadata, mint, mintAuthority, payer, updateAuthority] = acc;
      const expected = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX)[0];
      if (!metadata.equals(expected) || !mintAuthority.equals(wallet) || !payer.equals(wallet) || !updateAuthority.equals(wallet)) refuse('metadata accounts are not (PDA, your mint, you, you, you)');
      if (!createdMints.some((m) => m.equals(mint))) refuse('metadata for a mint this transaction did not create');
      out.push({ program: 'metaplex', name: 'create-metadata-v3', args: { name, symbol, uri, isMutable: 'false' }, accounts: { metadata: metadata.toBase58(), mint: mint.toBase58() } });
      continue;
    }

    if (program.equals(LAUNCH_PROGRAM)) {
      const ix = matchIdl(launchIdl.instructions, d) ?? refuse('unknown tegridy-launch instruction');
      const m = named(ix);
      const extra = acc.slice(ix.accounts.length);
      if (ix.name !== 'create_launch' && extra.length) refuse(`${ix.name} carries ${extra.length} extra account(s)`);
      switch (ix.name) {
        case 'create_launch': {
          if (!m.creator.equals(wallet)) refuse('create_launch names another creator');
          if (!createdMints.some((k) => k.equals(m.mint))) refuse('create_launch for a mint this transaction did not create');
          // The reserve-at-create program: the platform reserve is paid, inside this
          // instruction, to ATA(mint, global.fee_recipient) AS THE CHAIN RECORDS IT.
          if (ix.accounts.length !== 11) refuse(`create_launch has ${ix.accounts.length} IDL accounts; the pinned program has 11`);
          const glc = await getGlobal();
          if (!m.fee_recipient?.equals(glc.feeRecipient)) refuse('create_launch: the platform reserve goes to someone other than global.fee_recipient');
          if (!m.treasury_token?.equals(ata(m.mint, glc.feeRecipient))) refuse('create_launch: the reserve token account is not the treasury token account for this mint');
          if (!m.associated_token_program?.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) refuse('create_launch: not the Associated Token program');
          const trailing = ci.accountKeyIndexes.slice(ix.accounts.length);
          if (trailing.length > 1) refuse('create_launch carries more than one trailing account');
          for (const i of trailing) {
            if (i < nSigners || msg.isAccountWritable(i) || !keys[i].equals(LAUNCH_INDEX)) refuse(`create_launch trailing account ${keys[i].toBase58()} is not the read-only launch index`);
          }
          launchedMints.push(m.mint);
          out.push({ program: 'launch', name: ix.name, args: { trailing: trailing.map((i) => keys[i].toBase58()).join(',') }, accounts: show(m) });
          break;
        }
        case 'buy':
        case 'sell': {
          const amount = u64(d, 8); const floor = u64(d, 16);
          if (!m.trader.equals(wallet)) refuse(`${ix.name}: the trader is not you`);
          if (floor === 0n) refuse(`${ix.name}: the slippage floor is 0, which accepts any price`);
          if (!m.trader_token_account.equals(ata(m.mint, wallet))) refuse(`${ix.name}: the token account is not your own`);
          const gl = await getGlobal();
          if (!m.fee_recipient.equals(gl.feeRecipient)) refuse(`${ix.name}: fee recipient ${m.fee_recipient.toBase58()} is not global.fee_recipient`);
          const c = await curve(m.mint);
          const expectedCreator = c ? c.curve.creator : launchedMints.some((k) => k.equals(m.mint)) ? wallet : null;
          if (!expectedCreator || !m.creator.equals(expectedCreator)) refuse(`${ix.name}: creator ${m.creator.toBase58()} is not the curve's recorded creator`);
          out.push({ program: 'launch', name: ix.name, args: ix.name === 'buy' ? { maxLamportsIn: String(amount), minTokensOut: String(floor) } : { tokensIn: String(amount), minLamportsOut: String(floor) }, accounts: show(m) });
          break;
        }
        case 'migrate_to_amm': {
          const gl = await getGlobal();
          const c = await curve(m.launch_mint) ?? refuse('migrate_to_amm for a mint with no curve');
          if (!m.payer.equals(wallet)) refuse('migrate_to_amm: payer is not you');
          if (!m.fee_recipient.equals(gl.feeRecipient) || !m.creator.equals(c.curve.creator) || !m.amm_config.equals(gl.ammConfig) || !m.cp_swap_program.equals(CP_SWAP_PROGRAM)) {
            refuse('migrate_to_amm: fee recipient / creator / amm config / cp-swap is not what the chain records');
          }
          out.push({ program: 'launch', name: ix.name, args: {}, accounts: show(m) });
          break;
        }
        default:
          refuse(`${ix.name} is an operator instruction, never sent from the site`);
      }
      continue;
    }

    if (program.equals(CP_SWAP_PROGRAM)) {
      const ix = matchIdl(cpIdl.instructions, d) ?? refuse('unknown cp-swap instruction');
      if (ix.name === 'deposit' || ix.name === 'withdraw') {
        out.push(await checkLiquidity(ix, acc, d, wallet, cpIdl));
        continue;
      }
      if (ix.name === 'initialize') {
        out.push(await checkInitialize(ix, acc, d, wallet, otherSigners, mintOwner));
        continue;
      }
      if (ix.name !== 'swap_base_input') refuse(`cp-swap ${ix.name} is never sent from the site`);
      const m = named(ix);
      const amountIn = u64(d, 8); const minOut = u64(d, 16);
      if (!m.payer.equals(wallet)) refuse('swap: the payer is not you');
      if (minOut === 0n) refuse('swap: minimum_amount_out is 0, which accepts any price');
      if (!m.input_token_account.equals(ata(m.input_token_mint, wallet))) refuse('swap: the input account is not your own');
      if (!m.output_token_account.equals(ata(m.output_token_mint, wallet))) refuse('swap: the OUTPUT account is not your own (cp-swap does not check its owner)');
      const mint = m.input_token_mint.equals(WSOL) ? m.output_token_mint : m.input_token_mint;
      if (!m.pool_state.equals(poolStatePda(mint, LAUNCH_PROGRAM))) refuse('swap: not the pool the launch recorded');
      out.push({ program: 'cp-swap', name: ix.name, args: { amountIn: String(amountIn), minimumAmountOut: String(minOut) }, accounts: show(m) });
      continue;
    }

    refuse(`program ${program.toBase58()} is not one this site calls`);
  }

  // Only SOL is wrapped. A pool paired with USDC or BAYLA takes its coin from, and pays it
  // into, the wallet's own account for that coin, so nothing in its transaction may touch
  // wrapped SOL. (An opening may open no other account either: the rule above, in the
  // associated-token branch, already refuses any account but the wrapped-SOL one.)
  const notSol = out.find((i) => i.program === 'cp-swap' && i.args.pairedWith !== undefined && i.args.pairedWith !== 'SOL');
  if (notSol) {
    const touches = out.find((i) => i.name === 'wrap-sol' || i.name === 'sync-native' || i.name === 'close-wsol' || (i.program === 'ata' && i.accounts.mint === WSOL.toBase58()));
    if (touches) refuse(`${notSol.name}: the pool is paired with ${notSol.args.pairedWith}, not SOL, and the transaction still carries ${touches.name} on wrapped SOL`);
  }

  // The plant rides only in a launch, and whole: its burn and its transfer together.
  if (plant.burns + plant.gives > 0) {
    if (!launchedMints.length) refuse('a $BAYLA plant in a transaction that launches nothing');
    if (plant.burns !== 1 || plant.gives !== 1) refuse('half a plant: the burn and the transfer go together');
  }

  if (cuPrice > 0n) {
    if (cuLimit === null) refuse('a priority price without a compute limit (the default limit makes the fee unbounded)');
    const lamports = (cuPrice * (cuLimit as bigint) + 999_999n) / 1_000_000n;
    if (lamports > MAX_PRIORITY_LAMPORTS) refuse(`priority fee up to ${lamports} lamports is above the ${MAX_PRIORITY_LAMPORTS} cap`);
  }
  return out;
}

/**
 * cp-swap `deposit` / `withdraw`. The pool is read from the chain HERE, and every account
 * the instruction names must be the pool's own, or the wallet's own:
 *  - owner = the wallet; authority = the program's one PDA;
 *  - the vaults, vault mints and pool-share mint = the pool's OWN recorded fields;
 *  - token_0/1_account = the wallet's ATA for each mint under the program the POOL records
 *    for that side (so a Token-2022 side pays to the Token-2022-seeded address);
 *  - owner_lp_token: on a deposit, the wallet's classic ATA of the pool-share mint (the
 *    site creates it); on a withdrawal, any classic account of that mint whose owner field
 *    on chain is the wallet (the shares may sit in a non-ATA account);
 *  - the fixed program accounts the IDL names by address;
 *  - a deposit carries a real maximum on both sides (above 0, never u64::MAX), a
 *    withdrawal a real minimum (above 0), and the share amount is above 0.
 * cp-swap itself checks only the authority of owner_lp_token on a withdrawal, and pays a
 * withdrawal into whatever token_0/1_account it is handed.
 */
async function checkLiquidity(ix: IdlIx, acc: PublicKey[], d: Uint8Array, wallet: PublicKey, cpIdl: CpIdl): Promise<SignedIx> {
  const what = ix.name;
  if (acc.length !== ix.accounts.length) refuse(`${what}: ${acc.length} accounts, the pinned IDL has ${ix.accounts.length}`);
  if (d.length !== 32) refuse(`${what}: ${d.length} bytes of data, expected 32`);
  const m: Record<string, PublicKey> = {};
  ix.accounts.forEach((a, i) => { m[a.name] = acc[i]; });
  for (const a of ix.accounts) {
    if (a.address && !m[a.name].equals(new PublicKey(a.address))) refuse(`${what}: ${a.name} is ${m[a.name].toBase58()}, not ${a.address}`);
  }
  if (!m.owner.equals(wallet)) refuse(`${what}: the owner is not you`);
  if (!m.authority.equals(CP_AUTHORITY)) refuse(`${what}: the authority is not the pool program's own`);
  const pool = await readPool(m.pool_state, cpIdl);
  const own: [string, PublicKey][] = [
    ['token_0_vault', pool.token0Vault], ['token_1_vault', pool.token1Vault],
    ['vault_0_mint', pool.token0Mint], ['vault_1_mint', pool.token1Mint], ['lp_mint', pool.lpMint],
  ];
  for (const [name, want] of own) if (!m[name].equals(want)) refuse(`${what}: ${name} is not the pool's own (${want.toBase58()})`);
  if (!m.token_0_account.equals(ata(pool.token0Mint, wallet, pool.token0Program))) refuse(`${what}: token_0_account is not your own account for that token`);
  if (!m.token_1_account.equals(ata(pool.token1Mint, wallet, pool.token1Program))) refuse(`${what}: token_1_account is not your own account for that token`);
  if (what === 'deposit') {
    if (!m.owner_lp_token.equals(ata(pool.lpMint, wallet))) refuse('deposit: the pool shares go to an account that is not your own');
  } else {
    const lpAcc = await readClassicTokenAccount(m.owner_lp_token);
    if (!lpAcc) refuse('withdraw: the pool-share account does not exist');
    if (!lpAcc!.mint.equals(pool.lpMint)) refuse('withdraw: the pool-share account holds a different token');
    if (!lpAcc!.owner.equals(wallet)) refuse('withdraw: the pool-share account is not your own');
  }
  const lp = u64(d, 8); const a0 = u64(d, 16); const a1 = u64(d, 24);
  if (lp === 0n) refuse(`${what}: lp_token_amount is 0`);
  if (what === 'deposit') {
    for (const [side, v] of [['0', a0], ['1', a1]] as const) {
      if (v === 0n) refuse(`deposit: maximum_token_${side}_amount is 0`);
      if (v === U64_MAX) refuse(`deposit: maximum_token_${side}_amount is u64::MAX, which bounds nothing`);
    }
  } else {
    for (const [side, v] of [['0', a0], ['1', a1]] as const) if (v === 0n) refuse(`withdraw: minimum_token_${side}_amount is 0, which accepts any payout`);
  }
  // The pool's coin, from the pool as the chain records it: 'other' when neither side is
  // SOL, USDC or BAYLA (the site builds nothing for such a pool; the rules above still hold).
  const pairedWith = coinOfPool(pool.token0Mint.toBase58(), pool.token1Mint.toBase58())?.coin.symbol ?? 'other';
  const args: Record<string, string> = what === 'deposit'
    ? { lpTokenAmount: String(lp), maximumToken0Amount: String(a0), maximumToken1Amount: String(a1), pairedWith }
    : { lpTokenAmount: String(lp), minimumToken0Amount: String(a0), minimumToken1Amount: String(a1), pairedWith };
  return { program: 'cp-swap', name: what, args, accounts: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toBase58()])) };
}

/** cp-swap PDAs, from the program's own seed strings (never the frontend's derive helpers). */
const cpPda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, CP_SWAP_PROGRAM)[0];
/** Fee tier `index`: the u16 is BIG-endian in the seed. */
const tierConfig = (index: number) => cpPda(Buffer.from('amm_config'), Buffer.from([(index >> 8) & 0xff, index & 0xff]));

/**
 * cp-swap `initialize`, as this site opens a pool (SPEC_S2_CREATE 3.2), with the pinned
 * IDL's account names:
 *  - exactly 20 accounts (a 21st would be read as a support-mint record) and 32 bytes;
 *  - creator = the wallet; the authority and every PDA by the program's own seeds;
 *  - amm_config = fee tier 1 by derivation; tier 0 (the launch tier) is refused by name;
 *  - the two mints byte-sorted, one of them a pairing coin (SOL, USDC or BAYLA: coins.ts);
 *  - pool_state = the standard address for tier 1 and the pair, or a CO-SIGNER of this
 *    message (the fresh key the page signs with after the wallet);
 *  - create_pool_fee = the program's fixed fee account (the IDL's address, 2sa31zce…);
 *  - creator_token_0/1 = the wallet's ATAs under each mint's owner program, read from the
 *    chain, and token_0/1_program = that owner; creator_lp_token = the wallet's classic
 *    ATA of the new pool-share mint;
 *  - open_time = 0 (trading opens at once) and both amounts above 0.
 */
async function checkInitialize(
  ix: IdlIx,
  acc: PublicKey[],
  d: Uint8Array,
  wallet: PublicKey,
  coSigners: PublicKey[],
  mintOwner: (m: PublicKey) => Promise<PublicKey | null>,
): Promise<SignedIx> {
  if (acc.length !== ix.accounts.length) refuse(`initialize: ${acc.length} accounts, the pinned IDL has ${ix.accounts.length} (an extra one would be read as a support-mint record)`);
  if (d.length !== 32) refuse(`initialize: ${d.length} bytes of data, expected 32`);
  const m: Record<string, PublicKey> = {};
  ix.accounts.forEach((a, i) => { m[a.name] = acc[i]; });
  for (const a of ix.accounts) {
    if (a.address && !m[a.name].equals(new PublicKey(a.address))) refuse(`initialize: ${a.name} is ${m[a.name].toBase58()}, not ${a.address}`);
  }
  if (!m.creator.equals(wallet)) refuse('initialize: the pool is opened and paid for by someone else');
  if (m.amm_config.equals(tierConfig(0))) refuse('initialize: the pool would open on the launch tier (fee tier 0), which this site never does');
  if (!m.amm_config.equals(tierConfig(1))) refuse('initialize: the pool would open on a fee tier this site does not use');
  if (!m.authority.equals(CP_AUTHORITY)) refuse('initialize: the authority is not the pool program\'s own');
  const t0 = m.token_0_mint;
  const t1 = m.token_1_mint;
  if (Buffer.compare(t0.toBuffer(), t1.toBuffer()) >= 0) refuse('initialize: the two mints are not in the program\'s order');
  const pair = coinOfPool(t0.toBase58(), t1.toBase58()) ?? refuse('initialize: the pool does not pair a token with SOL, USDC or BAYLA');
  const standard = cpPda(Buffer.from('pool'), m.amm_config.toBuffer(), t0.toBuffer(), t1.toBuffer());
  const pool = m.pool_state;
  if (!pool.equals(standard) && !coSigners.some((k) => k.equals(pool))) refuse('initialize: the pool is neither the standard address nor a fresh key that signs this transaction');
  const derived: [string, PublicKey][] = [
    ['lp_mint', cpPda(Buffer.from('pool_lp_mint'), pool.toBuffer())],
    ['token_0_vault', cpPda(Buffer.from('pool_vault'), pool.toBuffer(), t0.toBuffer())],
    ['token_1_vault', cpPda(Buffer.from('pool_vault'), pool.toBuffer(), t1.toBuffer())],
    ['observation_state', cpPda(Buffer.from('observation'), pool.toBuffer())],
  ];
  for (const [name, want] of derived) if (!m[name].equals(want)) refuse(`initialize: ${name} is not the one the pool's address gives`);
  for (const [side, mint] of [['0', t0], ['1', t1]] as const) {
    const owner = mint.equals(WSOL) ? TOKEN_PROGRAM_ID : await mintOwner(mint);
    if (!owner || !(owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID))) refuse(`initialize: token_${side}_mint is not a mint of either token program`);
    if (!m[`token_${side}_program`].equals(owner!)) refuse(`initialize: token_${side}_program is not the program that owns that mint`);
    if (!m[`creator_token_${side}`].equals(ata(mint, wallet, owner!))) refuse(`initialize: creator_token_${side} is not your own account for that token`);
  }
  if (!m.creator_lp_token.equals(ata(m.lp_mint, wallet))) refuse('initialize: the pool shares go to an account that is not your own');
  const a0 = u64(d, 8);
  const a1 = u64(d, 16);
  const openTime = u64(d, 24);
  if (a0 === 0n || a1 === 0n) refuse('initialize: the pool would open with an empty side');
  if (openTime !== 0n) refuse(`initialize: open_time is ${openTime}, so the pool would open for trading later, not now`);
  return {
    program: 'cp-swap',
    name: 'initialize',
    args: { initAmount0: String(a0), initAmount1: String(a1), openTime: String(openTime), origin: pool.equals(standard) ? 'standard' : 'co-signer', pairedWith: pair.coin.symbol },
    accounts: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toBase58()])),
  };
}

/** Base58, for signatures (bs58 is only a transitive dependency here). */
export function base58(bytes: Uint8Array): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}

export { chain };
