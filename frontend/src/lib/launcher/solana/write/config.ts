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
  decodeAmmConfig,
} from '../../../solana/cpswap/program';
import { CURVE_WRITES_ENABLED, curveWriteEnvOverridesAllowed, isCurveWriteEnabled } from '../curveWriteFlag';
import type {
  ActionAvailability,
  CurveWriteConfig,
  GraduationReadiness,
  SolanaCluster,
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

async function checkCluster(rpc: GateRpc, cluster: SolanaCluster): Promise<WriteGate | null> {
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
