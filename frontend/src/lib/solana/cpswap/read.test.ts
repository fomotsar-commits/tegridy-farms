// @vitest-environment node
//
// readPoolAt keeps the account OWNER: the bytes of a pool can be
// copied under any program, so a pool (and its vaults) only count when the right
// program owns them.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { readPoolAt } from './read';
import {
  ACCOUNT_POOL_STATE,
  POOL_STATE_LEN,
  POOL_STATE_OFFSETS,
  derivePool,
  deriveVault,
  sortMints,
} from './program';
import type { AccountSnapshot, CurveRpc } from '../../launcher/solana/curve/read';

const PROGRAM = new PublicKey('EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const CONFIG = Keypair.generate().publicKey;
const A = Keypair.generate().publicKey;
const B = Keypair.generate().publicKey;
const { token0, token1 } = sortMints(A, B);
const POOL = derivePool(PROGRAM, CONFIG, token0, token1);
const V0 = deriveVault(PROGRAM, POOL, token0);
const V1 = deriveVault(PROGRAM, POOL, token1);

function poolBytes(): Uint8Array {
  const d = new Uint8Array(POOL_STATE_LEN);
  d.set(ACCOUNT_POOL_STATE, 0);
  const o = POOL_STATE_OFFSETS;
  d.set(CONFIG.toBytes(), o.ammConfig);
  d.set(V0.toBytes(), o.token0Vault);
  d.set(V1.toBytes(), o.token1Vault);
  d.set(token0.toBytes(), o.token0Mint);
  d.set(token1.toBytes(), o.token1Mint);
  d.set(TOKEN.toBytes(), o.token0Program);
  d.set(TOKEN.toBytes(), o.token1Program);
  return d;
}

function tokenAccount(amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
}

function rpc(accounts: Record<string, AccountSnapshot>): CurveRpc {
  return {
    async getAccountInfo(a: PublicKey) {
      return accounts[a.toBase58()] ?? null;
    },
    async getMinimumBalanceForRentExemption() {
      return 0;
    },
  };
}

const healthy = (): Record<string, AccountSnapshot> => ({
  [POOL.toBase58()]: { data: poolBytes(), owner: PROGRAM, lamports: 1 },
  [V0.toBase58()]: { data: tokenAccount(100n), owner: TOKEN, lamports: 1 },
  [V1.toBase58()]: { data: tokenAccount(200n), owner: TOKEN, lamports: 1 },
});

describe('pool reads check the owner', () => {
  it('a pool owned by the program, with token-program vaults, reads', async () => {
    const r = await readPoolAt(rpc(healthy()), PROGRAM, POOL);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect([r.value.reserve0, r.value.reserve1]).toEqual([100n, 200n]);
  });

  it('the same bytes under another program are NOT a pool', async () => {
    const accts = healthy();
    accts[POOL.toBase58()] = { ...accts[POOL.toBase58()]!, owner: Keypair.generate().publicKey };
    expect(await readPoolAt(rpc(accts), PROGRAM, POOL)).toEqual({ kind: 'not-a-pool', address: POOL.toBase58() });
  });

  it('a vault not owned by the token program the pool names is refused, never quoted', async () => {
    const accts = healthy();
    accts[V1.toBase58()] = { ...accts[V1.toBase58()]!, owner: Keypair.generate().publicKey };
    expect((await readPoolAt(rpc(accts), PROGRAM, POOL)).kind).toBe('unreadable');
  });
});
