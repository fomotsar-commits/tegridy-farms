/**
 * held-through.json: every contract of this venue that holds user positions, per chain,
 * with the exact read that returns one wallet's position. scripts/held-through.mjs writes
 * it at build from the registry (bungalows.ts, constants.ts). No balances, no chain reads.
 * readByIsland is poolReadByIsland's answer. heldThrough.test.ts pins every read to
 * state.rs, the Streamflow SDK, the Solidity and a recorded mainnet fixture.
 */
import { PublicKey } from '@solana/web3.js';
import { toFunctionSelector } from 'viem';
import { BUNGALOWS, RETIRED_STAKE_POOLS, poolReadByIsland, type Bungalow } from './bungalows';
import {
  SITE_URL,
  GITHUB_REPO_URL,
  TOWELI_ADDRESS,
  TOWELI_DECIMALS,
  WETH_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  LEGACY_STAKING_ADDRESSES,
  TEGRIDY_LP_ADDRESS,
  LP_FARMING_ADDRESS,
} from './constants';
import {
  LADDER_PROGRAM_ID,
  ACCOUNT_DISCRIMINATOR,
  POOL_SIZE,
  POSITION_SIZE,
  USER_STATS_SIZE,
  stakeVaultPda,
} from './ladder/program';

export const HELD_THROUGH_SCHEMA = 'memetics.finance/held-through/1';

type Chain = 'solana' | 'ethereum' | 'base';
export type Offered = 'open' | 'deposits-closed' | 'withdraw-only' | 'retired';
export type HeldKind =
  | 'bayla-ladder'
  | 'streamflow-stake-pool'
  | 'lighthouse-ladder'
  | 'lighthouse-staking'
  | 'tegridy-staking'
  | 'tegridy-staking-legacy'
  | 'tegridy-pair'
  | 'tegridy-lp-farming';

export interface LayoutField {
  name: string;
  offset: number;
  type: string;
}
export interface HeldToken {
  address: string;
  symbol: string;
  decimals: number;
  role?: 'token0' | 'token1';
}
export type AccountFilter = { dataSize: number } | { memcmp: { offset: number; bytes: string } };

export interface LadderRead {
  source: string;
  userStats: { seeds: string[]; size: number; discriminator: number[]; layout: LayoutField[] };
  position: {
    seeds: string[];
    nonces: string;
    size: number;
    discriminator: number[];
    layout: LayoutField[];
    filters: AccountFilter[];
  };
  pool: { size: number; discriminator: number[]; layout: LayoutField[] };
  wallet: string;
  reconcile: string;
  notPrincipal: string;
}
export interface StreamflowRead {
  source: string;
  idlVersion: string;
  stakeEntry: {
    seeds: string[];
    nonces: string;
    accountSize: number;
    discriminator: number[];
    layout: LayoutField[];
    filters: AccountFilter[];
  };
  stakePool: { discriminator: number[]; layout: LayoutField[] };
  wallet: string;
  reconcile: string;
  notPrincipal: string;
}
export interface EvmCall {
  signature: string;
  selector: string;
  /** The returned words in order, named. */
  returns: string;
}
export interface EvmRead {
  source: string;
  calls: EvmCall[];
  wallet: string;
  enumerate?: string;
  reconcile: string;
  notPrincipal?: string;
  lp?: { address: string; decimals: number };
  redeemsThrough?: string;
}
export interface HeldContract {
  id: string;
  bungalow: string;
  label: string;
  kind: HeldKind;
  address: string;
  program?: string;
  vault?: string;
  offered: Offered;
  readByIsland: boolean;
  tokens: HeldToken[];
  read: LadderRead | StreamflowRead | EvmRead;
}
export interface HeldThroughBody {
  schema: string;
  site: string;
  repository: string;
  note: string;
  conventions: {
    seeds: string;
    offsets: string;
    tokenAccount: string;
    tokenAccountAmountOffset: number;
    evm: string;
    units: string;
  };
  chains: Record<Chain, HeldContract[]>;
}

/* ----- account layouts ----- */

const SIZE: Record<string, number> = { u8: 1, bool: 1, u32: 4, u64: 8, i64: 8, u128: 16, pubkey: 32 };
function sizeOf(type: string): number {
  const bytes = /^u8\[(\d+)\]$/.exec(type);
  const n = bytes ? Number(bytes[1]) : SIZE[type];
  if (!n) throw new Error(`held-through: no size for type ${type}`);
  return n;
}

/** Borsh has no padding: each field starts where the last ended, after the 8-byte discriminator. */
function layout(fields: readonly (readonly [string, string])[], size?: number): LayoutField[] {
  let offset = 8;
  const out = fields.map(([name, type]) => {
    const field = { name, offset, type };
    offset += sizeOf(type);
    return field;
  });
  if (size !== undefined && offset !== size) throw new Error(`held-through: layout ends at ${offset}, account is ${size}`);
  return out;
}
const at = (l: readonly LayoutField[], name: string): number => {
  const f = l.find((x) => x.name === name);
  if (!f) throw new Error(`held-through: no field ${name}`);
  return f.offset;
};

// bayla-ladder, field for field as state.rs declares them.
const POSITION = layout([
  ['bump', 'u8'], ['pool', 'pubkey'], ['owner', 'pubkey'], ['nonce', 'u32'], ['amount', 'u64'],
  ['weight', 'u128'], ['lock_end', 'i64'], ['reward_per_weight_paid', 'u128'], ['rewards_owed', 'u128'],
  ['_reserved', 'u8[64]'],
], POSITION_SIZE);
const USER_STATS = layout([
  ['bump', 'u8'], ['pool', 'pubkey'], ['owner', 'pubkey'], ['next_nonce', 'u32'], ['open_positions', 'u8'],
  ['rewards_carried', 'u128'], ['principal', 'u64'], ['_reserved', 'u8[24]'],
], USER_STATS_SIZE);
const POOL = layout([
  ['bump', 'u8'], ['nonce', 'u8'], ['mint', 'pubkey'], ['token_program', 'pubkey'], ['decimals', 'u8'],
  ['authority', 'pubkey'], ['pending_authority', 'pubkey'], ['stake_vault', 'pubkey'], ['reward_vault', 'pubkey'],
  ['min_stake', 'u64'], ['deposit_cap', 'u64'], ['pending_cap', 'u64'], ['pending_cap_ts', 'i64'],
  ['max_wallet_principal', 'u64'], ['total_principal', 'u64'], ['total_weighted', 'u128'], ['reward_rate', 'u128'],
  ['period_finish', 'i64'], ['last_update_time', 'i64'], ['reward_per_weight_stored', 'u128'],
  ['rewards_emitted', 'u128'], ['rewards_paid', 'u128'], ['reward_funded_cumulative', 'u128'],
  ['penalty_collected_cumulative', 'u128'], ['orphaned_penalty', 'u64'], ['degraded', 'bool'],
  ['rpw_residue', 'u128'], ['emitted_residue', 'u128'], ['_reserved', 'u8[88]'],
], POOL_SIZE);

// Streamflow stake_pool, field for field as its IDL declares them (pinned by the test).
export const STREAMFLOW_STAKE_POOL_PROGRAM = 'STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH';
const STREAMFLOW_IDL_VERSION = '2.7.0';
const STAKE_ENTRY_DISCRIMINATOR = [187, 127, 9, 35, 155, 68, 86, 40];
const STAKE_POOL_DISCRIMINATOR = [121, 34, 206, 21, 79, 127, 255, 28];
/** Live stake entries are 224 bytes; the IDL's fields end at 220, and dataSize 220 matches none. */
const STAKE_ENTRY_ACCOUNT_SIZE = 224;
const STAKE_ENTRY = layout([
  ['nonce', 'u32'], ['stake_pool', 'pubkey'], ['payer', 'pubkey'], ['authority', 'pubkey'], ['amount', 'u64'],
  ['duration', 'u64'], ['effective_amount', 'u128'], ['created_ts', 'u64'], ['closed_ts', 'u64'],
  ['prior_total_effective_stake', 'u128'], ['unstake_ts', 'u64'], ['is_sponsored', 'bool'], ['auto_unstake', 'bool'],
  ['_buffer', 'u8[38]'],
]);
const STAKE_POOL = layout([
  ['bump', 'u8'], ['nonce', 'u8'], ['mint', 'pubkey'], ['creator', 'pubkey'], ['authority', 'pubkey'],
  ['min_weight', 'u64'], ['max_weight', 'u64'], ['min_duration', 'u64'], ['max_duration', 'u64'],
  ['permissionless', 'bool'], ['vault', 'pubkey'], ['stake_mint', 'pubkey'], ['total_stake', 'u64'],
  ['total_effective_stake', 'u128'], ['freeze_stake_mint', 'bool'], ['unstake_period', 'u64'],
  ['is_total_stake_capped', 'bool'], ['remaining_total_stake', 'u64'], ['expiry_ts', 'u64'], ['auto_unstake', 'bool'],
  ['_buffer', 'u8[37]'],
]);

const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const WETH_DECIMALS = 18;
/** TegridyPair is an OpenZeppelin ERC20, so its LP token has 18 decimals. */
const LP_DECIMALS = 18;

const disc = (d: Uint8Array): number[] => Array.from(d);

function ladderRead(): LadderRead {
  return {
    source: 'solana/tegridy-amm/programs/bayla-ladder/src/state.rs and lib.rs',
    userStats: {
      seeds: ['utf8:user', 'pool', 'owner'],
      size: USER_STATS_SIZE,
      discriminator: disc(ACCOUNT_DISCRIMINATOR.UserStats),
      layout: USER_STATS,
    },
    position: {
      seeds: ['utf8:position', 'pool', 'owner', 'u32le:nonce'],
      nonces: 'every n from 0 to userStats.next_nonce - 1; an absent account is a closed position',
      size: POSITION_SIZE,
      discriminator: disc(ACCOUNT_DISCRIMINATOR.Position),
      layout: POSITION,
      filters: [
        { dataSize: POSITION_SIZE },
        { memcmp: { offset: at(POSITION, 'pool'), bytes: 'pool' } },
        { memcmp: { offset: at(POSITION, 'owner'), bytes: 'owner' } },
      ],
    },
    pool: { size: POOL_SIZE, discriminator: disc(ACCOUNT_DISCRIMINATOR.Pool), layout: POOL },
    wallet:
      `The wallet's staked principal is userStats.principal (u64 at ${at(USER_STATS, 'principal')}). ` +
      `It equals the sum of position.amount (u64 at ${at(POSITION, 'amount')}) over the wallet's open positions.`,
    reconcile:
      `sum(position.amount) over every open position == pool.total_principal (u64 at ${at(POOL, 'total_principal')}); ` +
      `stake vault balance >= pool.total_principal + pool.orphaned_penalty (u64 at ${at(POOL, 'orphaned_penalty')}).`,
    notPrincipal: 'position.weight, position.rewards_owed and userStats.rewards_carried are not principal.',
  };
}

function streamflowRead(): StreamflowRead {
  return {
    source: 'the Streamflow stake_pool program; layout from its IDL in @streamflow/staking',
    idlVersion: STREAMFLOW_IDL_VERSION,
    stakeEntry: {
      seeds: ['utf8:stake-entry', 'stakePool', 'authority', 'u32le:nonce'],
      nonces: 'any u32; the filters find every entry whatever its nonce',
      accountSize: STAKE_ENTRY_ACCOUNT_SIZE,
      discriminator: STAKE_ENTRY_DISCRIMINATOR,
      layout: STAKE_ENTRY,
      filters: [
        { dataSize: STAKE_ENTRY_ACCOUNT_SIZE },
        { memcmp: { offset: at(STAKE_ENTRY, 'stake_pool'), bytes: 'stakePool' } },
        { memcmp: { offset: at(STAKE_ENTRY, 'authority'), bytes: 'authority' } },
      ],
    },
    stakePool: { discriminator: STAKE_POOL_DISCRIMINATOR, layout: STAKE_POOL },
    wallet:
      `The sum of stakeEntry.amount (u64 at ${at(STAKE_ENTRY, 'amount')}) over the entries the filters return ` +
      `where closed_ts (u64 at ${at(STAKE_ENTRY, 'closed_ts')}) == 0. Match authority (at ${at(STAKE_ENTRY, 'authority')}), ` +
      `not payer (at ${at(STAKE_ENTRY, 'payer')}).`,
    reconcile:
      `sum(amount) over every open entry == stakePool.total_stake (u64 at ${at(STAKE_POOL, 'total_stake')}); ` +
      'vault balance >= total_stake.',
    notPrincipal:
      `Stake-mint receipt tokens (stakePool.stake_mint, at ${at(STAKE_POOL, 'stake_mint')}) are not principal and never ` +
      'count as the staked token. effective_amount is weight, not principal.',
  };
}

const call = (signature: string, returns: string): EvmCall => ({
  signature,
  selector: toFunctionSelector(signature),
  returns,
});

function evmLadderRead(): EvmRead {
  return {
    source: 'contracts/src/LighthouseLadder.sol',
    calls: [
      call('balanceOf(address)', '(uint256 principal)'),
      call('positionsOf(address)', '(uint256[] ids)'),
      call('positions(uint256)', '(address owner, uint64 lockEnd, uint256 amount, uint256 boosted)'),
      call('nextPositionId()', '(uint256 nextId)'),
      call('totalSupply()', '(uint256 totalPrincipal)'),
      call('stakingToken()', '(address token)'),
    ],
    wallet: 'balanceOf(wallet) is the principal. It equals the sum of positions(id).amount over positionsOf(wallet).',
    enumerate: 'Position ids run from 1 to nextPositionId() - 1; a closed id reads owner 0x0 and amount 0.',
    reconcile: 'sum(positions(id).amount) over open ids == totalSupply(); stakingToken().balanceOf(contract) >= totalSupply().',
    notPrincipal: 'boosted is weight, not principal.',
  };
}

function evmPlainRead(): EvmRead {
  return {
    source: 'contracts/src/vendor/synthetix-staking-rewards/StakingRewards.sol',
    calls: [
      call('balanceOf(address)', '(uint256 principal)'),
      call('totalSupply()', '(uint256 totalPrincipal)'),
      call('stakingToken()', '(address token)'),
    ],
    wallet: 'balanceOf(wallet) is the principal.',
    reconcile: 'sum(balanceOf) over stakers == totalSupply(); stakingToken().balanceOf(contract) >= totalSupply().',
  };
}

const STAKING_POSITION =
  '(uint256 amount, uint256 boostedAmount, int256 rewardDebt, uint64 lockEnd, uint16 boostBps, uint32 lockDuration, ' +
  'bool autoMaxLock, bool hasJbacBoost, uint64 stakeTimestamp, uint256 jbacTokenId, bool jbacDeposited)';

function stakingRead(legacy: boolean): EvmRead {
  return {
    source: legacy
      ? 'an earlier build of contracts/src/TegridyStaking.sol; amount is the first word'
      : 'contracts/src/TegridyStaking.sol; Position in contracts/src/lib/StakingViewLib.sol',
    calls: [
      call('positions(uint256)', legacy ? '(uint256 amount, ...)' : STAKING_POSITION),
      call('ownerOf(uint256)', '(address owner)'),
      call('balanceOf(address)', '(uint256 positionCount)'),
      call('totalStaked()', '(uint256 totalStaked)'),
    ],
    wallet:
      'The sum of positions(id).amount over every id with ownerOf(id) == wallet. balanceOf(wallet) counts those ids.',
    enumerate:
      'Ids are minted upward from 1; a withdrawn id is burned and its ownerOf reverts. ERC-721 Transfer logs name ' +
      'every id a wallet has held. userTokenId(address) is one pointer, not a list.',
    reconcile: 'sum(positions(id).amount) over live ids == totalStaked().',
    notPrincipal: 'boostedAmount is weight, not principal.',
  };
}

/** A pair's two tokens in its own order: token0 is the lower address. */
function pairTokens(): HeldToken[] {
  const pair: HeldToken[] = [
    { address: TOWELI_ADDRESS, symbol: 'TOWELI', decimals: TOWELI_DECIMALS },
    { address: WETH_ADDRESS, symbol: 'WETH', decimals: WETH_DECIMALS },
  ].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  return pair.map((t, i) => ({ ...t, role: i === 0 ? 'token0' : 'token1' }));
}

function pairRead(): EvmRead {
  return {
    source: 'contracts/src/TegridyPair.sol',
    calls: [
      call('balanceOf(address)', '(uint256 lp)'),
      call('totalSupply()', '(uint256 lpSupply)'),
      call('getReserves()', '(uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'),
      call('token0()', '(address token0)'),
      call('token1()', '(address token1)'),
    ],
    wallet:
      'lp = balanceOf(wallet). It redeems to lp * reserve0 / totalSupply() of token0 and lp * reserve1 / ' +
      'totalSupply() of token1, integer division, every value read at one block.',
    reconcile: 'token0.balanceOf(pair) >= reserve0 and token1.balanceOf(pair) >= reserve1.',
    lp: { address: TEGRIDY_LP_ADDRESS, decimals: LP_DECIMALS },
  };
}

function farmRead(pairId: string): EvmRead {
  return {
    source: 'contracts/src/TegridyLPFarming.sol',
    calls: [
      call('rawBalanceOf(address)', '(uint256 lp)'),
      call('totalRawSupply()', '(uint256 lpStaked)'),
      call('stakingToken()', '(address lpToken)'),
    ],
    wallet: `lp = rawBalanceOf(wallet): LP tokens of ${pairId} staked here. They redeem through the pair by its rule.`,
    reconcile: 'sum(rawBalanceOf) over stakers == totalRawSupply(); pair.balanceOf(farm) >= totalRawSupply().',
    notPrincipal: 'effectiveBalanceOf is boosted weight, not principal.',
    lp: { address: TEGRIDY_LP_ADDRESS, decimals: LP_DECIMALS },
    redeemsThrough: pairId,
  };
}

/* ----- collect ----- */

function tokenOf(b: Bungalow): HeldToken {
  if (!b.address) throw new Error(`held-through: ${b.id} stakes a token with no address in the registry`);
  if (!Number.isInteger(b.decimals)) {
    throw new Error(`held-through: ${b.id} stakes ${b.symbol} but the registry gives no decimals`);
  }
  return { address: b.address, symbol: b.symbol, decimals: b.decimals as number };
}

function streamflowVault(pool: string): string {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('stake-vault'), new PublicKey(pool).toBytes()],
    new PublicKey(STREAMFLOW_STAKE_POOL_PROGRAM),
  )[0].toBase58();
}

function streamflowPool(b: Bungalow, pool: string, id: string, label: string, offered: Offered): HeldContract {
  return {
    id,
    bungalow: b.id,
    label,
    kind: 'streamflow-stake-pool',
    address: pool,
    program: STREAMFLOW_STAKE_POOL_PROGRAM,
    vault: streamflowVault(pool),
    offered,
    readByIsland: poolReadByIsland('solana', pool),
    tokens: [tokenOf(b)],
    read: streamflowRead(),
  };
}

export interface CollectOptions {
  bungalows?: readonly Bungalow[];
  /** The bayla-ladder program; the build's VITE_BAYLA_LADDER_PROGRAM unless given. */
  ladderProgram?: string;
  retired?: typeof RETIRED_STAKE_POOLS;
}

export function collectHeldThrough(opts: CollectOptions = {}): HeldThroughBody {
  const bungalows = opts.bungalows ?? BUNGALOWS;
  const program = (opts.ladderProgram ?? LADDER_PROGRAM_ID).trim();
  const chains: Record<Chain, HeldContract[]> = { solana: [], ethereum: [], base: [] };

  for (const b of bungalows) {
    if (b.chain === 'tbd') continue;
    if (b.chain === 'solana') {
      // Listed only when the build offers it: pool AND program, the card's own gate.
      if (b.ladderPool && program) {
        chains.solana.push({
          id: `${b.id}-ladder-pool`,
          bungalow: b.id,
          label: `${b.symbol} lock ladder`,
          kind: 'bayla-ladder',
          address: b.ladderPool,
          program,
          vault: stakeVaultPda(new PublicKey(program), new PublicKey(b.ladderPool)).toBase58(),
          offered: 'open',
          readByIsland: poolReadByIsland('solana', b.ladderPool),
          tokens: [tokenOf(b)],
          read: ladderRead(),
        });
      }
      if (b.stakePool) {
        const offered = b.depositsClosed ? 'deposits-closed' : 'open';
        chains.solana.push(streamflowPool(b, b.stakePool, `lighthouse-${b.id}`, `${b.symbol} lighthouse pool`, offered));
      }
      continue;
    }
    if (!b.stakePool) continue;
    const ladder = b.poolKind === 'ladder';
    chains[b.chain].push({
      id: `${ladder ? 'ladder' : 'lighthouse'}-${b.id}`,
      bungalow: b.id,
      label: `${b.symbol} ${ladder ? 'ladder' : 'lighthouse pool'}`,
      kind: ladder ? 'lighthouse-ladder' : 'lighthouse-staking',
      address: b.stakePool,
      offered: 'open',
      readByIsland: poolReadByIsland(b.chain, b.stakePool),
      tokens: [tokenOf(b)],
      read: ladder ? evmLadderRead() : evmPlainRead(),
    });
  }

  for (const r of opts.retired ?? RETIRED_STAKE_POOLS) {
    const b = bungalows.find((x) => x.id === r.bungalow);
    if (!b) throw new Error(`held-through: retired pool ${r.pool} names no bungalow ${r.bungalow}`);
    chains[r.chain].push(
      streamflowPool(b, r.pool, `lighthouse-${b.id}-retired`, `${b.symbol} lighthouse pool, retired`, 'retired'),
    );
  }

  const toweli: HeldToken = { address: TOWELI_ADDRESS, symbol: 'TOWELI', decimals: TOWELI_DECIMALS };
  const evm = (
    id: string, label: string, kind: HeldKind, address: string, offered: Offered, tokens: HeldToken[], read: EvmRead,
  ): HeldContract => ({
    id, bungalow: 'toweli', label, kind, address, offered,
    readByIsland: poolReadByIsland('ethereum', address), tokens, read,
  });
  chains.ethereum.push(
    evm('tegridy-staking', 'TOWELI staking (TegridyStaking)', 'tegridy-staking', TEGRIDY_STAKING_ADDRESS, 'open',
      [toweli], stakingRead(false)),
    ...LEGACY_STAKING_ADDRESSES.map((a, i) =>
      evm(`legacy-staking-v${i + 1}`, `TOWELI staking, earlier build v${i + 1}`, 'tegridy-staking-legacy', a,
        'withdraw-only', [toweli], stakingRead(true))),
    evm('tegridy-lp-native', 'TegridyLP TOWELI/WETH pair', 'tegridy-pair', TEGRIDY_LP_ADDRESS, 'open',
      pairTokens(), pairRead()),
    evm('lp-farming', 'TegridyLP farm', 'tegridy-lp-farming', LP_FARMING_ADDRESS, 'open',
      pairTokens(), farmRead('tegridy-lp-native')),
  );

  return {
    schema: HELD_THROUGH_SCHEMA,
    site: SITE_URL,
    repository: GITHUB_REPO_URL,
    note:
      "Every contract of this venue that holds user positions, and the exact read that returns one wallet's " +
      "position in it. No balances: read them from the chain. readByIsland is the venue's copy of the island's " +
      "read list; the island's published list rules.",
    conventions: {
      seeds:
        'A PDA is findProgramAddress(seeds, program). utf8:<text> is those bytes; pool and stakePool are the ' +
        'contract address; owner and authority are the wallet; u32le:nonce is the nonce as 4 bytes, little-endian.',
      offsets:
        'Byte offsets into account data, counting the 8-byte discriminator. Integers are little-endian; ' +
        'a pubkey is 32 bytes; u8[n] is n bytes.',
      tokenAccount:
        `A vault balance is its token account's amount: u64 at byte ${TOKEN_ACCOUNT_AMOUNT_OFFSET}, ` +
        'the same in SPL Token and Token-2022.',
      tokenAccountAmountOffset: TOKEN_ACCOUNT_AMOUNT_OFFSET,
      evm:
        'A selector is the first 4 bytes of keccak256(signature). Arguments and returned values are 32-byte ' +
        'words; returns names the words in order.',
      units: 'Every amount is raw. Divide by 10^decimals of its token.',
    },
    chains,
  };
}

/** A production build must not drop the ladder the ledger says is live. */
export function ladderMissingInProduction(
  body: HeldThroughBody,
  ledger: unknown,
  vercelEnv: string | undefined,
): string | null {
  if (vercelEnv !== 'production') return null;
  const entries = (ledger as { solana?: unknown } | null)?.solana;
  const live =
    Array.isArray(entries) &&
    entries.some(
      (e: { id?: unknown; status?: unknown }) =>
        e?.id === 'bayla-ladder-pool' && typeof e.status === 'string' && /^live\b/i.test(e.status),
    );
  if (!live || body.chains.solana.some((c) => c.kind === 'bayla-ladder')) return null;
  return (
    'the ledger has a live bayla-ladder-pool but this production build lists no ladder. ' +
    'Set VITE_BAYLA_LADDER_POOL and VITE_BAYLA_LADDER_PROGRAM for the build.'
  );
}

/** JSON, indented, with any value that fits kept on one line. */
function pretty(v: unknown, pad = ''): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const items: [string | null, unknown][] = Array.isArray(v)
    ? v.map((x): [null, unknown] => [null, x])
    : Object.entries(v).filter(([, x]) => x !== undefined);
  const [open, close] = Array.isArray(v) ? ['[', ']'] : ['{', '}'];
  const key = (k: string | null) => (k === null ? '' : `${JSON.stringify(k)}: `);
  const line = `${open}${items.map(([k, x]) => `${key(k)}${pretty(x)}`).join(', ')}${close}`;
  if (pad.length + line.length <= 120) return line;
  const inner = `${pad}  `;
  return `${open}\n${items.map(([k, x]) => `${inner}${key(k)}${pretty(x, inner)}`).join(',\n')}\n${pad}${close}`;
}

export function renderHeldThrough(body: HeldThroughBody, meta: { date: string; commit?: string | null }): string {
  const { schema, site, repository, note, conventions, chains } = body;
  const doc = { schema, site, generated: meta.date, commit: meta.commit ?? null, repository, note, conventions, chains };
  return `${pretty(doc)}\n`;
}
