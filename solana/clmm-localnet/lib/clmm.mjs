// A client for tegridy-clmm built from its source (rust-spec.mjs): instructions by name with
// accounts by name, the program's PDAs, price and tick maths, account and event decoding.
import { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, spl } from './deps.mjs';
import { ADDR, PROGRAM_SRC } from './config.mjs';
import { loadSpec } from './rust-spec.mjs';
import { makeCodec, readConsts } from './codec.mjs';
import { conn } from './chain.mjs';

export const spec = loadSpec(PROGRAM_SRC);
export const consts = readConsts(spec.sources);
export const codec = makeCodec(spec, consts);
const seedText = Object.fromEntries(spec.sources.flatMap((s) => [...s.matchAll(/pub const (\w+_SEED): &str = "([^"]+)";/g)].map((m) => [m[1], m[2]])));
const seed = (n) => { if (!seedText[n]) throw new Error('no seed ' + n); return Buffer.from(seedText[n]); };
const P = ADDR.program;
const pda = (...s) => PublicKey.findProgramAddressSync(s, P)[0];
const be = (n, bytes) => { const b = Buffer.alloc(bytes); bytes === 2 ? b.writeUInt16BE(n) : b.writeInt32BE(n); return b; };

export const PDA = {
  ammConfig: (index) => pda(seed('AMM_CONFIG_SEED'), be(index, 2)),
  pool: (cfg, m0, m1) => pda(seed('POOL_SEED'), cfg.toBuffer(), m0.toBuffer(), m1.toBuffer()),
  vault: (pool, mint) => pda(seed('POOL_VAULT_SEED'), pool.toBuffer(), mint.toBuffer()),
  observation: (pool) => pda(seed('OBSERVATION_SEED'), pool.toBuffer()),
  bitmap: (pool) => pda(seed('POOL_TICK_ARRAY_BITMAP_SEED'), pool.toBuffer()),
  tickArray: (pool, start) => pda(seed('TICK_ARRAY_SEED'), pool.toBuffer(), be(start, 4)),
  position: (nftMint) => pda(seed('POSITION_SEED'), nftMint.toBuffer()),
  operation: () => pda(seed('OPERATION_SEED')),
  rewardVault: (pool, mint) => pda(seed('POOL_REWARD_VAULT_SEED'), pool.toBuffer(), mint.toBuffer()),
  limitNonce: (owner, i) => pda(owner.toBuffer(), Buffer.from([i])),
  limitOrder: (owner, nonceAcc, n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return pda(owner.toBuffer(), nonceAcc.toBuffer(), b); },
  permission: (authority) => pda(seed('PERMISSION_SEED'), authority.toBuffer()),
  supportMint: (mint) => pda(seed('SUPPORT_MINT_SEED'), mint.toBuffer()),
  dynamicFee: (index) => pda(seed('DYNAMIC_FEE_CONFIG_SEED'), be(index, 2)),
};

/** Accounts every instruction may name by role, so a call passes only what is specific to it. */
export const COMMON = {
  system_program: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
  token_program: ADDR.token, token_program_2022: ADDR.token2022, associated_token_program: ADDR.ata,
  get memo_program() { return ADDR.memo; }, metadata_program: ADDR.metaplex,
};

/**
 * One instruction: `accounts` by the names the program's Accounts struct uses, `args` by its
 * argument names, `remaining` appended in order. Any missing account or argument throws.
 */
export function ix(name, accounts, args = {}, remaining = []) {
  const s = spec.instructions[name];
  if (!s) throw new Error('no instruction ' + name);
  const keys = s.accounts.map((a) => {
    const k = accounts[a.name] ?? COMMON[a.name];
    if (!k) throw new Error(`${name}: account ${a.name} not given`);
    return { pubkey: new PublicKey(k), isSigner: a.signer, isWritable: a.writable };
  });
  for (const k of Object.keys(accounts)) if (!s.accounts.some((a) => a.name === k)) throw new Error(`${name} has no account ${k}`);
  const data = Buffer.concat([s.disc, ...s.args.map((a) => {
    if (!(a.name in args)) throw new Error(`${name}: argument ${a.name} not given`);
    return codec.enc(a.type, args[a.name]);
  })]);
  return new TransactionInstruction({ programId: P, keys: [...keys, ...remaining.map((r) => ({ isSigner: false, isWritable: true, ...r, pubkey: new PublicKey(r.pubkey) }))], data });
}

export async function account(name, address) {
  const a = await conn.getAccountInfo(address, 'confirmed');
  if (!a) return null;
  if (!a.owner.equals(P)) throw new Error(`${address.toBase58()} is not owned by the program`);
  return { ...codec.decodeAccount(name, a.data), _bytes: a.data.length, _lamports: a.lamports };
}

/** Events the program logged in a transaction (`Program data:` lines, Anchor event encoding). */
export function events(logs) {
  const names = Object.entries(spec.structs).filter(([, s]) => /#\[event\]/.test(s.attrs)).map(([n]) => n);
  const byDisc = new Map(names.map((n) => [spec.eventDisc(n).toString('hex'), n]));
  const out = [];
  for (const l of logs) {
    const m = /^Program data: (.+)$/.exec(l);
    if (!m) continue;
    const b = Buffer.from(m[1], 'base64');
    const n = byDisc.get(b.subarray(0, 8).toString('hex'));
    if (n) out.push({ name: n, ...codec.dec(n, b, 8)[0] });
  }
  return out;
}

// ---- prices and ticks -------------------------------------------------------------------
const Q64 = 1n << 64n;
const isqrt = (n) => { if (n < 2n) return n; let x = BigInt(Math.floor(Math.sqrt(Number(n)))); while (x * x > n) x--; while ((x + 1n) * (x + 1n) <= n) x++; return x; };
/** sqrt(token1 per token0, in base units) as Q64.64, from a rational num/den. */
export const sqrtPriceX64 = (num, den) => isqrt((BigInt(num) << 128n) / BigInt(den));
export const priceOf = (sqrtX64) => Number(sqrtX64) ** 2 / Number(Q64) ** 2;
export const tickAt = (price) => Math.floor(Math.log(price) / Math.log(1.0001));
export const alignDown = (tick, spacing) => Math.floor(tick / spacing) * spacing;
export const arrayStart = (tick, spacing) => Math.floor(tick / (spacing * consts.TICK_ARRAY_SIZE)) * spacing * consts.TICK_ARRAY_SIZE;

/** The pool's two mints in the program's order (token_mint_0 < token_mint_1 by bytes). */
export const order = (a, b) => (Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a]);

export const ataOf = (owner, mint, programId) => spl.getAssociatedTokenAddressSync(mint, owner, true, programId);
