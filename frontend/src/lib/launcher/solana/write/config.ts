// Which programs the write path may talk to, and whether the chain agrees it can.
//
// TWO GATES, and the second one is the real one.
//
// 1. `curveWriteConfig` decides whether there is a configuration at all.
//    - In a production build the ids come ONLY from the committed constants
//      (`PROGRAM_ID` and both cp-swap ids), and only when they equal the registered
//      restart ids AND `CURVE_WRITES_ENABLED` is committed `true`. No env variable
//      can open it, so a hosting-dashboard setting cannot turn writes on ahead of
//      the owner's flip. From website release 2 both ids are the registered pair
//      and the flag is true, so production answers the mainnet config and gate 2
//      decides.
//    - A dev server, or the named local-validator build (`--mode solana-e2e`),
//      may take the ids from env. Any other build mode counts as production:
//      `MODE === 'production'` is not the test, because `--mode anything` would
//      slip past it.
//
// 2. `readWriteGate` then reads the chain before anything is offered: the genesis
//    hash is the cluster we think it is, both programs have bytecode (ProgramData
//    followed, so a closed program's executable-flagged stub cannot pass), `global`
//    decodes, it names OUR cp-swap program, and the AmmConfig it names is owned by
//    that program and decodes. Anything else is `blocked` with a reason.
//
// Adding and removing liquidity have their own pair, `lpWriteConfig` and
// `readLpGate`: LP's own switch (lpWriteFlag.ts), and a gate that reads only the
// cluster and the pool program, so the launch program can never close a pool's exit.
// Opening a pool reads two more facts BESIDE that gate (`readCreateFacts`): the public
// fee tier and the pool program's fee account. They can stop an opening, never a
// withdrawal.
//
// Nothing here signs or sends.

import { Connection, PublicKey } from '@solana/web3.js';
import { solanaRpcEndpoint } from '../../../solana';
import { browserCurveRpc, browserRpc, type SolanaRpc } from '../curve/rpc';
import {
  CP_SWAP_PROGRAM_ID,
  PLACEHOLDER_PROGRAM_ID,
  PROGRAM_ID,
  REGISTERED_CP_SWAP_PROGRAM_ID,
  REGISTERED_PROGRAM_ID,
  SPENT_PROGRAM_ID,
  cpPermissionPda,
  isAmmConfigured,
  migrationAuthorityPda,
} from '../curve/program';
import { clipDetail, readDeployment, readGlobal, type CurveRpc, type LaunchState } from '../curve/read';
import {
  LIVE_PROGRAM_ID as CPSWAP_LIVE_PROGRAM_ID,
  REGISTERED_PROGRAM_ID as CPSWAP_REGISTERED_PROGRAM_ID,
  SPENT_PROGRAM_ID as CPSWAP_SPENT_PROGRAM_ID,
  PUBLIC_TIER_INDEX,
  decodeAmmConfig,
  publicTierConfig,
} from '../../../solana/cpswap/program';
import { CURVE_WRITES_ENABLED, curveWriteEnvOverridesAllowed, isCurveWriteEnabled } from '../curveWriteFlag';
import { lpWriteMode, type LpWriteMode } from '../lpWriteFlag';
import type {
  ActionAvailability,
  CreateFacts,
  CurveWriteConfig,
  FeeAccountState,
  GraduationReadiness,
  LpGate,
  SolanaCluster,
  SwapGate,
  TierState,
  WriteGate,
} from './types';

/** The web3-free nav switch, re-exported so callers of the write layer find it here too. */
export { isCurveWriteEnabled as isCurveWriteConfigured };

// ── fixed addresses ──────────────────────────────────────────────────────────

/**
 * cp-swap's `create_pool_fee_reveiver::ID` in the NON-devnet build (cp-swap
 * lib.rs, `create_pool_fee_reveiver`). A WSOL TOKEN ACCOUNT, not a wallet. The
 * local validator runs the same mainnet binary, so it is the same address there.
 * A devnet-feature build uses a different one; against such a build graduation
 * fails in simulation and says so, before any wallet is asked.
 */
export const CP_CREATE_POOL_FEE_RECEIVER = new PublicKey('2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa');

export const GENESIS_HASH = {
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
} as const;

const LAUNCH_INDEX_SEED = new TextEncoder().encode('launch-index');

/**
 * `["launch-index"]` under the launch program. The program never creates or reads
 * it; it is only a well-known address this site's create transaction mentions as a
 * trailing read-only account, so `getSignaturesForAddress` can find launches.
 *
 * ANYONE can mention it too (it is a public address and the program ignores extra
 * accounts), so a list built from it is "launches that mention this address", not
 * "launches made on this site". See `discover/list.ts`.
 */
export function launchIndexAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([LAUNCH_INDEX_SEED], programId)[0];
}

// ── gate 1: configuration ────────────────────────────────────────────────────

type Env = Record<string, unknown>;

function viteEnv(): Env {
  return import.meta.env as unknown as Env;
}

/** The committed side of gate 1. A parameter so the flipped state can be tested without flipping it. */
export interface CommittedWriteIds {
  enabled: boolean;
  programId: PublicKey;
  cpSwapProgram: PublicKey;
  /** `cpswap/program.ts` LIVE_PROGRAM_ID: the pool client's own id, when one is set. */
  cpSwapLive: PublicKey | null;
}

export const COMMITTED_WRITE_IDS: CommittedWriteIds = {
  enabled: CURVE_WRITES_ENABLED,
  programId: PROGRAM_ID,
  cpSwapProgram: CP_SWAP_PROGRAM_ID,
  cpSwapLive: CPSWAP_LIVE_PROGRAM_ID,
};

const SPENT_OR_PLACEHOLDER = [
  PLACEHOLDER_PROGRAM_ID,
  // The 2026-08 pair, closed 2026-08-13 and spent forever.
  SPENT_PROGRAM_ID,
  CPSWAP_SPENT_PROGRAM_ID,
];

function isUnusableId(id: PublicKey): boolean {
  return SPENT_OR_PLACEHOLDER.some((s) => s.equals(id));
}

function parseKey(raw: unknown): PublicKey | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  try {
    return new PublicKey(t);
  } catch {
    return null;
  }
}

function parseCluster(raw: unknown): SolanaCluster | null {
  if (raw === undefined || raw === null || raw === '') return 'mainnet';
  return raw === 'mainnet' || raw === 'devnet' || raw === 'localnet' ? raw : null;
}

/**
 * The write configuration, or `null` for "writes are off". Reads env at CALL time.
 *
 * `null` is the answer for every doubt: a spent or placeholder id, an unparsable
 * id, an unknown cluster name, a mainnet pair that is not the registered pair.
 */
export function curveWriteConfig(
  env: Env = viteEnv(),
  committed: CommittedWriteIds = COMMITTED_WRITE_IDS,
): CurveWriteConfig | null {
  if (!curveWriteEnvOverridesAllowed(env)) {
    // PRODUCTION: the committed constants, nothing else.
    if (!committed.enabled) return null;
    if (!committed.programId.equals(REGISTERED_PROGRAM_ID)) return null;
    if (!committed.cpSwapProgram.equals(REGISTERED_CP_SWAP_PROGRAM_ID)) return null;
    if (!REGISTERED_CP_SWAP_PROGRAM_ID.equals(CPSWAP_REGISTERED_PROGRAM_ID)) return null;
    if (committed.cpSwapLive && !committed.cpSwapLive.equals(REGISTERED_CP_SWAP_PROGRAM_ID)) return null;
    return { programId: committed.programId, cpSwapProgram: committed.cpSwapProgram, cluster: 'mainnet' };
  }

  // DEV SERVER / the named e2e build.
  const flagOn = committed.enabled || env.VITE_SOLANA_CURVE_WRITES === '1';
  if (!flagOn) return null;
  const cluster = parseCluster(env.VITE_SOLANA_CLUSTER);
  if (!cluster) return null;
  const rawProgram = env.VITE_SOLANA_CURVE_PROGRAM;
  const rawCpSwap = env.VITE_SOLANA_CPSWAP_PROGRAM;
  const programId = rawProgram === undefined || rawProgram === '' ? committed.programId : parseKey(rawProgram);
  const cpSwapProgram = rawCpSwap === undefined || rawCpSwap === '' ? committed.cpSwapProgram : parseKey(rawCpSwap);
  if (!programId || !cpSwapProgram) return null;
  if (isUnusableId(programId) || isUnusableId(cpSwapProgram)) return null;
  if (programId.equals(cpSwapProgram)) return null;
  if (
    cluster === 'mainnet' &&
    !(programId.equals(REGISTERED_PROGRAM_ID) && cpSwapProgram.equals(REGISTERED_CP_SWAP_PROGRAM_ID))
  ) {
    return null;
  }
  return { programId, cpSwapProgram, cluster };
}

// ── gate 2: the chain ────────────────────────────────────────────────────────

/** `CurveRpc` plus the one call that says which cluster we are on. A `Connection` satisfies it. */
export interface GateRpc extends CurveRpc {
  getGenesisHash(): Promise<string>;
}

/**
 * The one connection the write path uses in a browser: our own `/api/solrpc` proxy,
 * never a Solana host and never the wallet's RPC. It satisfies `GateRpc` and
 * `WriteRpc` both. Confirmation is polled (see `submit.ts`), so no websocket opens.
 */
export function browserWriteConnection(): Connection {
  return new Connection(solanaRpcEndpoint(), { commitment: 'confirmed' });
}

/** A `GateRpc` over the JSON-RPC function the read path already uses. */
export function browserGateRpc(rpc: SolanaRpc = browserRpc()): GateRpc {
  const base = browserCurveRpc(rpc);
  return {
    getAccountInfo: base.getAccountInfo,
    getMinimumBalanceForRentExemption: base.getMinimumBalanceForRentExemption,
    async getGenesisHash() {
      const v = await rpc('getGenesisHash', []);
      if (typeof v !== 'string' || !v) throw new Error('getGenesisHash: expected a string');
      return v;
    },
  };
}

const PUBLIC_GENESIS = new Set<string>(Object.values(GENESIS_HASH));

async function checkCluster(rpc: GateRpc, cluster: SolanaCluster): Promise<Extract<WriteGate, { kind: 'blocked' }> | null> {
  let genesis: string;
  try {
    genesis = await rpc.getGenesisHash();
  } catch (e) {
    return { kind: 'blocked', reason: 'unreadable', detail: `Could not read which network this is: ${clipDetail(e)}` };
  }
  if (typeof genesis !== 'string' || !genesis) {
    return { kind: 'blocked', reason: 'unreadable', detail: 'The network did not say which network it is.' };
  }
  const ok =
    cluster === 'mainnet'
      ? genesis === GENESIS_HASH.mainnet
      : cluster === 'devnet'
        ? genesis === GENESIS_HASH.devnet
        : !PUBLIC_GENESIS.has(genesis);
  if (ok) return null;
  return {
    kind: 'blocked',
    reason: 'wrong-cluster',
    detail: `This page is set up for ${cluster}, but the network it is connected to is a different one.`,
  };
}

async function exists(rpc: CurveRpc, address: PublicKey, owner: PublicKey): Promise<boolean | null> {
  try {
    const a = await rpc.getAccountInfo(address);
    if (!a) return false;
    return a.owner.equals(owner);
  } catch {
    return null;
  }
}

/**
 * Read the chain and decide whether ANY write may be offered.
 *
 * Order matters: cluster, then both programs, then `global`, then the venue. The
 * first thing that is not right stops the read and names itself; nothing after it
 * is inferred from an absence.
 */
export async function readWriteGate(rpc: GateRpc, cfg: CurveWriteConfig | null): Promise<WriteGate> {
  if (!cfg) return { kind: 'off' };

  const wrongCluster = await checkCluster(rpc, cfg.cluster);
  if (wrongCluster) return wrongCluster;

  const [launch, cpswap] = await Promise.all([
    readDeployment(rpc, cfg.programId),
    readDeployment(rpc, cfg.cpSwapProgram),
  ]);
  if (launch.kind === 'unreadable') {
    return { kind: 'blocked', reason: 'unreadable', detail: `Could not read the launch program: ${launch.detail}` };
  }
  if (launch.kind !== 'deployed') {
    return {
      kind: 'blocked',
      reason: 'launch-program-missing',
      detail: `There is no working launch program at ${cfg.programId.toBase58()} on this network (${launch.kind}).`,
    };
  }
  if (cpswap.kind === 'unreadable') {
    return { kind: 'blocked', reason: 'unreadable', detail: `Could not read the pool program: ${cpswap.detail}` };
  }
  if (cpswap.kind !== 'deployed') {
    return {
      kind: 'blocked',
      reason: 'cpswap-program-missing',
      detail: `There is no working pool program at ${cfg.cpSwapProgram.toBase58()} on this network (${cpswap.kind}).`,
    };
  }

  const g = await readGlobal(rpc, cfg.programId);
  if (g.kind === 'unreadable') {
    return { kind: 'blocked', reason: 'unreadable', detail: `Could not read the launch settings: ${g.detail}` };
  }
  if (g.kind === 'absent') {
    return {
      kind: 'blocked',
      reason: 'protocol-not-initialized',
      detail: 'The launch program is there, but its settings have not been set up yet.',
    };
  }
  if (g.kind === 'undecodable') {
    return {
      kind: 'blocked',
      reason: 'unreadable',
      detail: `The launch settings account exists but could not be read (${g.reason}).`,
    };
  }
  const global = g.value;

  if (!isAmmConfigured(global)) {
    return {
      kind: 'blocked',
      reason: 'venue-not-configured',
      detail: 'The launch program has no pool program set for graduation yet.',
    };
  }
  if (!global.cpSwapProgram.equals(cfg.cpSwapProgram)) {
    return {
      kind: 'blocked',
      reason: 'venue-mismatch',
      detail: `The launch program graduates into ${global.cpSwapProgram.toBase58()}, not the pool program this page uses.`,
    };
  }

  let ammRaw;
  try {
    ammRaw = await rpc.getAccountInfo(global.ammConfig);
  } catch (e) {
    return { kind: 'blocked', reason: 'unreadable', detail: `Could not read the pool fee settings: ${clipDetail(e)}` };
  }
  if (!ammRaw) {
    return {
      kind: 'blocked',
      reason: 'venue-not-configured',
      detail: `The pool fee settings account ${global.ammConfig.toBase58()} does not exist.`,
    };
  }
  if (!ammRaw.owner.equals(cfg.cpSwapProgram)) {
    return {
      kind: 'blocked',
      reason: 'venue-mismatch',
      detail: `The pool fee settings account is not owned by the pool program.`,
    };
  }
  const ammConfig = decodeAmmConfig(global.ammConfig.toBase58(), ammRaw.data);
  if (!ammConfig) {
    return {
      kind: 'blocked',
      reason: 'unreadable',
      detail: 'The pool fee settings account exists but could not be read.',
    };
  }

  const [permission, createPoolFeeReceiver] = await Promise.all([
    exists(rpc, cpPermissionPda(migrationAuthorityPda(cfg.programId), cfg.cpSwapProgram), cfg.cpSwapProgram),
    exists(rpc, CP_CREATE_POOL_FEE_RECEIVER, new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')),
  ]);
  const graduation: GraduationReadiness = { permission, createPoolFeeReceiver };

  return {
    kind: 'open',
    cfg,
    global,
    ammConfig,
    ammConfigAddress: global.ammConfig,
    paused: global.paused,
    graduation,
  };
}

// ── liquidity: its own switch and its own, smaller gate ──────────────────────

/**
 * The write configuration for adding and removing liquidity, or `null` when LP's own
 * switch is 'off'. Otherwise exactly `curveWriteConfig` with the curve's flag forced
 * on, so every production id check still applies (the committed ids must be the
 * registered pair, and the pool client's own id must equal the registered cp-swap id).
 */
export function lpWriteConfig(
  env: Env = viteEnv(),
  committed: CommittedWriteIds = COMMITTED_WRITE_IDS,
  mode: LpWriteMode = lpWriteMode(env),
): CurveWriteConfig | null {
  if (mode === 'off') return null;
  return curveWriteConfig(env, { ...committed, enabled: true });
}

/**
 * Read the chain and decide whether liquidity may be offered. Two reads only: the
 * cluster (genesis hash) and that the pool program is deployed (ProgramData followed).
 *
 * It NEVER reads the launch program, `global` or a fee tier: a launch-program problem
 * (missing, paused, a `global` that will not decode or names another pool program)
 * must not close the way out of a pool. `readWriteGate` above would.
 */
export async function readLpGate(rpc: GateRpc, cfg: CurveWriteConfig | null, mode: LpWriteMode = lpWriteMode()): Promise<LpGate> {
  if (!cfg || mode === 'off') return { kind: 'off' };

  const wrongCluster = await checkCluster(rpc, cfg.cluster);
  if (wrongCluster) return wrongCluster;

  const cpswap = await readDeployment(rpc, cfg.cpSwapProgram);
  if (cpswap.kind === 'unreadable') {
    return { kind: 'blocked', reason: 'unreadable', detail: `Could not read the pool program: ${cpswap.detail}` };
  }
  if (cpswap.kind !== 'deployed') {
    return {
      kind: 'blocked',
      reason: 'cpswap-program-missing',
      detail: `There is no working pool program at ${cfg.cpSwapProgram.toBase58()} on this network (${cpswap.kind}).`,
    };
  }
  return { kind: 'open', cfg, mode };
}

// ── the swap page's own-pool route: LP's gate, without LP's switch ───────────

/**
 * The write configuration for a swap in one of our pools from the swap page: exactly
 * `curveWriteConfig` with the curve's flag forced on, as for liquidity, so every
 * production id check applies. No switch of LP's or the launch page's closes it.
 */
export function swapWriteConfig(env: Env = viteEnv(), committed: CommittedWriteIds = COMMITTED_WRITE_IDS): CurveWriteConfig | null {
  return curveWriteConfig(env, { ...committed, enabled: true });
}

/** The same two reads as `readLpGate`: the cluster, and that the pool program is deployed. */
export async function readSwapGate(rpc: GateRpc, cfg: CurveWriteConfig | null): Promise<SwapGate> {
  const g = await readLpGate(rpc, cfg, 'on');
  return g.kind === 'open' ? { kind: 'open', cfg: g.cfg } : g;
}

// ── opening a pool: the public fee tier and the fee account ──────────────────
//
// Read beside `readLpGate`, never inside it (spec N3): the gate's two reads decide
// whether liquidity can be added or removed at all, and a slow or failing tier read
// must never hold back a withdrawal. Prepare runs the same two pure functions on its
// own fresh read.

/** Above this fee to open a pool, this site opens none (a guard against a mistyped tier fee). */
export const MAX_CREATE_FEE_LAMPORTS = 1_000_000_000n;

const TOKEN_PROGRAM_KEY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WSOL_MINT_BYTES = new PublicKey('So11111111111111111111111111111111111111112').toBytes();
/** An SPL token account: mint 0..32, state at 108, `is_native` COption tag at 109. */
const TOKEN_ACCOUNT_LEN = 165;
const TOKEN_ACCOUNT_STATE = 108;
const TOKEN_ACCOUNT_IS_NATIVE = 109;

/**
 * What the account at the public tier's address says. `null` = no account there: the
 * tier has not been created. Owned by anything but the pool program, not an AmmConfig,
 * or an AmmConfig of another index: not a tier this site can use.
 */
export function tierStateOf(address: PublicKey, acc: { owner: string; data: Uint8Array } | null, cpSwapProgram: PublicKey): TierState {
  if (!acc) return { kind: 'not-open', address };
  if (acc.owner !== cpSwapProgram.toBase58()) return { kind: 'not-a-tier', address, detail: 'the account is not owned by the pool program' };
  const config = decodeAmmConfig(address.toBase58(), acc.data);
  if (!config) return { kind: 'not-a-tier', address, detail: 'the account is not a fee tier' };
  if (config.index !== PUBLIC_TIER_INDEX) return { kind: 'not-a-tier', address, detail: `it is fee tier ${config.index}, not ${PUBLIC_TIER_INDEX}` };
  if (config.disableCreatePool) return { kind: 'switched-off', address, config };
  if (config.createPoolFee > MAX_CREATE_FEE_LAMPORTS) return { kind: 'fee-too-high', address, config, limit: MAX_CREATE_FEE_LAMPORTS };
  return { kind: 'ready', address, config };
}

/**
 * Whether the pool program's fee account can take an opening's fee. `initialize`
 * deserializes it as a token account and syncs it as native wrapped SOL even when the
 * fee is 0, so it must be exactly that: owned by the token program, 165 bytes, holding
 * wrapped SOL, set up, and native. Anything else fails every opening.
 */
export function feeAccountStateOf(acc: { owner: string; data: Uint8Array } | null): FeeAccountState {
  if (!acc) return { kind: 'missing' };
  if (acc.owner !== TOKEN_PROGRAM_KEY) return { kind: 'not-wsol', detail: `it is owned by ${acc.owner}, not the token program` };
  const d = acc.data;
  if (d.length !== TOKEN_ACCOUNT_LEN) return { kind: 'not-wsol', detail: `it is ${d.length} bytes, not a ${TOKEN_ACCOUNT_LEN}-byte token account` };
  for (let i = 0; i < 32; i++) {
    if (d[i] !== WSOL_MINT_BYTES[i]) return { kind: 'not-wsol', detail: 'it holds another token, not wrapped SOL' };
  }
  const state = d[TOKEN_ACCOUNT_STATE];
  if (state !== 1) return { kind: 'not-wsol', detail: state === 2 ? 'it is frozen' : 'it is not set up' };
  const native = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(TOKEN_ACCOUNT_IS_NATIVE, true);
  if (native !== 1) return { kind: 'not-wsol', detail: 'it is not a native wrapped-SOL account' };
  return { kind: 'ready' };
}

/**
 * The two facts opening a pool needs that the LP gate does not read: the public tier
 * and the fee account, read together. A failed read is `unread` for that fact alone.
 * Never throws.
 */
export async function readCreateFacts(rpc: GateRpc, cfg: CurveWriteConfig): Promise<CreateFacts> {
  const address = publicTierConfig(cfg.cpSwapProgram);
  // Through a resolved promise, so even a call that throws before returning one is caught.
  const read = (key: PublicKey) =>
    Promise.resolve()
      .then(() => rpc.getAccountInfo(key))
      .then(
      (a) => ({ ok: true as const, acc: a ? { owner: a.owner.toBase58(), data: a.data } : null }),
      (e: unknown) => ({ ok: false as const, detail: clipDetail(e) }),
    );
  const [tier, fee] = await Promise.all([read(address), read(CP_CREATE_POOL_FEE_RECEIVER)]);
  return {
    tier: tier.ok ? tierStateOf(address, tier.acc, cfg.cpSwapProgram) : { kind: 'unread', address, detail: tier.detail },
    feeAccount: fee.ok ? feeAccountStateOf(fee.acc) : { kind: 'unread', detail: fee.detail },
  };
}

// ── what may be offered ──────────────────────────────────────────────────────

const NONE: ActionAvailability = {
  create: false,
  buy: false,
  sell: false,
  migrate: false,
  poolSwap: false,
};

/**
 * Which buttons may be live. A `false` is "do not offer", never a claim about the
 * launch; the page says WHY from the gate, the phase and the pause.
 *
 * A pause stops create, buy and graduation. It never stops a sell or a pool
 * swap: the program leaves sells ungated so a pause can never trap holders, and
 * the pool is not ours to pause.
 *
 * `launch` must have been read with the SAME program id as `gate.cfg.programId`.
 */
export function writeActions(
  gate: WriteGate,
  launch: LaunchState | null,
  opts: { migrationEligible?: boolean } = {},
): ActionAvailability {
  if (gate.kind !== 'open') return NONE;
  const paused = gate.paused;
  const base: ActionAvailability = { ...NONE, create: !paused };
  if (!launch) return base;

  const phase = launch.phase.kind;
  const trading = phase === 'trading' || phase === 'at-target';

  return {
    create: !paused,
    buy: trading && !paused,
    sell: trading || phase === 'awaiting-migration',
    migrate:
      phase === 'awaiting-migration' &&
      !paused &&
      opts.migrationEligible === true &&
      gate.graduation.permission === true &&
      gate.graduation.createPoolFeeReceiver === true,
    poolSwap: phase === 'graduated',
  };
}

// ── explorer links ───────────────────────────────────────────────────────────

const LOCAL_RPC = 'http://127.0.0.1:8899';

/** A Solscan link for a transaction, or the Solana Explorer for a local validator. */
export function explorerTxUrl(signature: string, cluster: SolanaCluster): string {
  const sig = encodeURIComponent(signature);
  if (cluster === 'localnet') {
    return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(LOCAL_RPC)}`;
  }
  return cluster === 'devnet' ? `https://solscan.io/tx/${sig}?cluster=devnet` : `https://solscan.io/tx/${sig}`;
}

/** Same, for an account. */
export function explorerAddressUrl(address: PublicKey | string, cluster: SolanaCluster): string {
  const a = encodeURIComponent(typeof address === 'string' ? address : address.toBase58());
  if (cluster === 'localnet') {
    return `https://explorer.solana.com/address/${a}?cluster=custom&customUrl=${encodeURIComponent(LOCAL_RPC)}`;
  }
  return cluster === 'devnet' ? `https://solscan.io/account/${a}?cluster=devnet` : `https://solscan.io/account/${a}`;
}
