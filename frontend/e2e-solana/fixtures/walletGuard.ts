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
// Account POSITIONS come from the release IDLs (pinned by sha256 in genesis-accounts.mjs),
// never from the frontend's ix.ts, so a builder bug cannot pass its own check here.
import { PublicKey, VersionedTransaction, type MessageCompiledInstruction } from '@solana/web3.js';
// @ts-expect-error -- a plain .mjs module shared with the validator scripts; it has no types
import { loadVerifiedIdls } from '../../scripts/solana-localnet/genesis-accounts.mjs';
import { chain, LAUNCH_PROGRAM, CP_SWAP_PROGRAM, METAPLEX, WSOL, ata, curve, globalConfig } from './chain';
import { poolStatePda, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID } from '../../src/lib/launcher/solana/curve/program';
import { BAYLA_DECIMALS, BAYLA_MINT, PLANT_HALF, TOKEN_2022, WORKSHOP_BAYLA_ACCOUNT, baylaAccount } from './bayla';

export const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');
/** Critic A6: our own transactions pay at most 0.001 SOL of priority fee. */
export const MAX_PRIORITY_LAMPORTS = 1_000_000n;
export const LAUNCH_INDEX = PublicKey.findProgramAddressSync([Buffer.from('launch-index')], LAUNCH_PROGRAM)[0];

interface IdlIx { name: string; discriminator: number[]; accounts: { name: string }[] }
interface Idls { launchIdl: { instructions: IdlIx[] }; cpIdl: { instructions: IdlIx[] } }
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

  const out: SignedIx[] = [];
  let cuLimit: bigint | null = null;
  let cuPrice = 0n;
  const createdMints: PublicKey[] = [];
  const launchedMints: PublicKey[] = [];
  const plant = { burns: 0, gives: 0 };
  let g: Awaited<ReturnType<typeof globalConfig>> | null = null;
  const getGlobal = async () => (g ??= await globalConfig());

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
        out.push({ program: 'token', name: 'close-wsol', args: {}, accounts: { account: acc[0].toBase58() } });
        continue;
      }
      refuse(`token instruction ${tag} (transfer / approve / set-authority / …) is never sent by this site`);
    }

    // Token-2022 is the $BAYLA plant and nothing else: burnChecked 50,000 from your own
    // $BAYLA account, and transferChecked 50,000 from it to the Workshop's $BAYLA account.
    // Exact size, accounts, amount and decimals; at most one of each; a launch only.
    if (program.equals(TOKEN_2022)) {
      const tag = d[0];
      if (tag !== 15 && tag !== 12) refuse(`Token-2022 instruction ${tag} is not the plant's burn or transfer`);
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
      const [payer, account, owner, mint] = acc;
      if (!payer.equals(wallet) || !owner.equals(wallet) || !account.equals(ata(mint, wallet))) refuse('a token account that is not your own');
      out.push({ program: 'ata', name: d[0] === 1 ? 'create-idempotent' : 'create', args: {}, accounts: { account: account.toBase58(), mint: mint.toBase58() } });
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
