// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../solanaPolyfill';
import { Connection, PublicKey } from '@solana/web3.js';
// The pool reads the dashboard's board (readSolanaWallet.ts) and Harvest (harvest/solana.ts) both
// make, each once per load and shared by the two (heldReads.ts). Each is the pool card's own reader.
import { readEntries, readPool } from '../bungalowStaking';
import { readLadderPool, readLadderWallet, readVaultBalances } from '../ladder/read';
import { ladderProgramId, type LadderPoolView } from '../ladder/program';
import { solanaRpcEndpoint } from '../solana';
import { heldRead } from './heldReads';

// The endpoint and commitment SolanaProviders' ConnectionProvider uses.
let conn: Connection | null = null;
const connection = () => (conn ??= new Connection(solanaRpcEndpoint(), 'confirmed'));

/** A wallet's stakes in one Streamflow pool. Held only when every open stake's rewards were priced. */
export const sharedEntries = (pool: string, owner: string) =>
  heldRead(`sf-entries:${pool}:${owner}`, () => readEntries(pool, owner), (r) =>
    r.ok && r.entries.every((e) => e.closedTs !== 0 || (!e.pendingUnread && Object.values(e.pendingRaw).every((v) => v !== null))));

/** One Streamflow pool. Held only when every reward vault's balance was read. */
export const sharedPool = (pool: string) =>
  heldRead(`sf-pool:${pool}`, () => readPool(pool), (r) => r.ok && r.pool.rewardPools.every((rp) => rp.fundedRaw !== null));

/** One lock ladder pool. */
export const sharedLadderPool = (pool: string) =>
  heldRead(`ladder-pool:${pool}`, () => readLadderPool(connection(), ladderProgramId(), new PublicKey(pool)), (r) => r.ok);

/** A wallet's locks in one ladder. Held only when every lock was read. */
export const sharedLadderWallet = (pool: string, owner: string) =>
  heldRead(`ladder-wallet:${pool}:${owner}`, () => readLadderWallet(connection(), ladderProgramId(), new PublicKey(pool), new PublicKey(owner)), (r) =>
    r.ok && !r.value.truncated && !r.value.slots.some((s) => s.state === 'unreadable'));

/** A ladder's two vault balances. Held only when both were read. */
export const sharedVaultBalances = (pool: LadderPoolView) =>
  heldRead(`ladder-vaults:${pool.address}`, () => readVaultBalances(connection(), pool), (v) => v.stakeRaw !== null && v.rewardRaw !== null);
