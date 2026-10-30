// Our pools, read straight from the chain.
//
// The layouts are the site's own (frontend/src/lib/solana/cpswap/program.ts), and
// test/pool.test.mjs reads that file and fails if the two ever differ. The swap
// maths is not copied at all: it is imported from the site's exact BigInt port of
// the program (math.ts), so the keeper and the swap page cannot disagree by a unit.

import { swapBaseInput, vaultAmountWithoutFee } from '../../frontend/src/lib/solana/cpswap/math.ts';
import { encode } from './base58.js';
import { PROGRAM_ID } from './config.js';

export const ACCOUNT_POOL_STATE = Uint8Array.from([247, 237, 227, 245, 215, 195, 222, 70]);
export const ACCOUNT_AMM_CONFIG = Uint8Array.from([218, 244, 33, 104, 203, 203, 43, 111]);

export const AMM_CONFIG_OFFSETS = {
  bump: 8,
  disableCreatePool: 9,
  index: 10,
  tradeFeeRate: 12,
  protocolFeeRate: 20,
  fundFeeRate: 28,
  createPoolFee: 36,
  protocolOwner: 44,
  fundOwner: 76,
  creatorFeeRate: 108,
};
export const AMM_CONFIG_LEN = 236;

export const POOL_STATE_OFFSETS = {
  ammConfig: 8,
  poolCreator: 40,
  token0Vault: 72,
  token1Vault: 104,
  lpMint: 136,
  token0Mint: 168,
  token1Mint: 200,
  token0Program: 232,
  token1Program: 264,
  observationKey: 296,
  authBump: 328,
  status: 329,
  lpMintDecimals: 330,
  mint0Decimals: 331,
  mint1Decimals: 332,
  lpSupply: 333,
  protocolFeesToken0: 341,
  protocolFeesToken1: 349,
  fundFeesToken0: 357,
  fundFeesToken1: 365,
  openTime: 373,
  recentEpoch: 381,
  creatorFeeOn: 389,
  enableCreatorFee: 390,
  creatorFeesToken0: 397,
  creatorFeesToken1: 405,
};
export const POOL_STATE_LEN = 637;

/** A set bit DISABLES the action; the program refuses a swap when bit 2 is set. */
export const POOL_STATUS_DISABLE_SWAP = 4;

/** An SPL token account (Token and Token-2022 share the first 165 bytes): mint, owner, amount. */
const TOKEN_ACCOUNT_MIN_LEN = 165;

const u8 = (d, o) => d[o];
const u16 = (d, o) => d.readUInt16LE(o);
const u64 = (d, o) => d.readBigUInt64LE(o);
const pk = (d, o) => encode(d.subarray(o, o + 32));

function hasDiscriminator(d, want) {
  if (d.length < 8) return false;
  for (let i = 0; i < 8; i++) if (d[i] !== want[i]) return false;
  return true;
}

export function decodeAmmConfig(d) {
  if (d.length < AMM_CONFIG_LEN) throw new Error('fee tier account is too short');
  if (!hasDiscriminator(d, ACCOUNT_AMM_CONFIG)) throw new Error('not a fee tier account');
  const o = AMM_CONFIG_OFFSETS;
  return {
    index: u16(d, o.index),
    tradeFeeRate: u64(d, o.tradeFeeRate),
    protocolFeeRate: u64(d, o.protocolFeeRate),
    fundFeeRate: u64(d, o.fundFeeRate),
    creatorFeeRate: u64(d, o.creatorFeeRate),
    protocolOwner: pk(d, o.protocolOwner),
    fundOwner: pk(d, o.fundOwner),
  };
}

export function decodePoolState(d) {
  if (d.length < POOL_STATE_LEN) throw new Error('pool account is too short');
  if (!hasDiscriminator(d, ACCOUNT_POOL_STATE)) throw new Error('not a pool account');
  const o = POOL_STATE_OFFSETS;
  return {
    ammConfig: pk(d, o.ammConfig),
    token0Vault: pk(d, o.token0Vault),
    token1Vault: pk(d, o.token1Vault),
    token0Mint: pk(d, o.token0Mint),
    token1Mint: pk(d, o.token1Mint),
    token0Program: pk(d, o.token0Program),
    token1Program: pk(d, o.token1Program),
    observationKey: pk(d, o.observationKey),
    status: u8(d, o.status),
    mint0Decimals: u8(d, o.mint0Decimals),
    mint1Decimals: u8(d, o.mint1Decimals),
    protocolFeesToken0: u64(d, o.protocolFeesToken0),
    protocolFeesToken1: u64(d, o.protocolFeesToken1),
    fundFeesToken0: u64(d, o.fundFeesToken0),
    fundFeesToken1: u64(d, o.fundFeesToken1),
    creatorFeeOn: u8(d, o.creatorFeeOn),
    enableCreatorFee: u8(d, o.enableCreatorFee) !== 0,
    creatorFeesToken0: u64(d, o.creatorFeesToken0),
    creatorFeesToken1: u64(d, o.creatorFeesToken1),
  };
}

export function decodeTokenAccount(d) {
  if (d.length < TOKEN_ACCOUNT_MIN_LEN) throw new Error('token account is too short');
  return { mint: pk(d, 0), owner: pk(d, 32), amount: u64(d, 64) };
}

function bytesOf(account, what) {
  if (!account) throw new Error(`${what} does not exist`);
  const [b64, enc] = account.data ?? [];
  if (enc !== 'base64' || typeof b64 !== 'string') throw new Error(`${what} came back in an unexpected encoding`);
  return Buffer.from(b64, 'base64');
}

/**
 * Turn four raw accounts (pool, fee tier, vault 0, vault 1), all read at ONE slot,
 * into the tradable reserves. Every link is checked against the pool's own words:
 * a vault that is not the pool's, holds another mint, or belongs to another program
 * makes the whole read fail. A failed read is "unread", never a price.
 */
export function snapshotFrom({ address, slot, accounts: [poolAcc, configAcc, vault0Acc, vault1Acc] }) {
  if (poolAcc?.owner !== PROGRAM_ID) throw new Error('the pool account is not owned by our pool program');
  const pool = decodePoolState(bytesOf(poolAcc, 'the pool'));
  if (configAcc?.owner !== PROGRAM_ID) throw new Error('the fee tier is not owned by our pool program');
  const config = decodeAmmConfig(bytesOf(configAcc, 'the fee tier'));
  if ((pool.status & POOL_STATUS_DISABLE_SWAP) !== 0) throw new Error('swaps are switched off on this pool');

  const vault0 = decodeTokenAccount(bytesOf(vault0Acc, 'vault 0'));
  const vault1 = decodeTokenAccount(bytesOf(vault1Acc, 'vault 1'));
  const heldBy = [vault0Acc.owner, vault1Acc.owner];
  const expected = [pool.token0Program, pool.token1Program];
  if (heldBy[0] !== expected[0] || heldBy[1] !== expected[1]) throw new Error("a vault is not held by the pool's token program");
  if (vault0.mint !== pool.token0Mint || vault1.mint !== pool.token1Mint) throw new Error('a vault holds the wrong coin');
  if (vault0.owner !== vault1.owner) throw new Error('the two vaults have different owners');

  // The vaults also hold fees owed to the venue (and fund and creator), which are not
  // part of the curve. pool.rs vault_amount_without_fee.
  const reserve0 = vaultAmountWithoutFee(vault0.amount, pool.protocolFeesToken0, pool.fundFeesToken0, pool.creatorFeesToken0);
  const reserve1 = vaultAmountWithoutFee(vault1.amount, pool.protocolFeesToken1, pool.fundFeesToken1, pool.creatorFeesToken1);
  if (reserve0 === null || reserve1 === null || reserve0 <= 0n || reserve1 <= 0n) throw new Error('the pool holds less than the fees it owes');

  return {
    address,
    slot,
    mint0: pool.token0Mint,
    mint1: pool.token1Mint,
    decimals0: pool.mint0Decimals,
    decimals1: pool.mint1Decimals,
    reserve0,
    reserve1,
    tradeFeeRate: config.tradeFeeRate,
    protocolFeeRate: config.protocolFeeRate,
    fundFeeRate: config.fundFeeRate,
    creatorFeeRate: pool.enableCreatorFee ? config.creatorFeeRate : 0n,
    creatorFeeOn: pool.creatorFeeOn,
    protocolOwner: config.protocolOwner,
    fundOwner: config.fundOwner,
    // For the transaction-size check: the accounts a swap on this pool names.
    accounts: {
      ammConfig: pool.ammConfig,
      authority: vault0.owner,
      vault0: null, // filled by readPool from the addresses it asked for
      vault1: null,
      token0Program: pool.token0Program,
      token1Program: pool.token1Program,
      observation: pool.observationKey,
    },
  };
}

/**
 * Read a pool. The first call learns the pool's fee tier and vaults from the pool
 * itself; every call after reads all four accounts in ONE request, so the reserves
 * and the fees owed come from the same slot.
 */
export async function readPool(rpc, address, cache = new Map()) {
  let links = cache.get(address);
  if (!links) {
    const first = await rpc('getMultipleAccounts', [[address], { encoding: 'base64', commitment: 'confirmed' }]);
    const acc = first?.value?.[0];
    if (acc?.owner !== PROGRAM_ID) throw new Error('the pool account is not owned by our pool program');
    const p = decodePoolState(bytesOf(acc, 'the pool'));
    links = { config: p.ammConfig, vault0: p.token0Vault, vault1: p.token1Vault };
    cache.set(address, links);
  }
  const res = await rpc('getMultipleAccounts', [[address, links.config, links.vault0, links.vault1], { encoding: 'base64', commitment: 'confirmed' }]);
  const accounts = res?.value;
  if (!Array.isArray(accounts) || accounts.length !== 4) throw new Error('the pool read came back incomplete');
  // The pool may only ever name the links it named when the keeper started. A change
  // means something re-pointed it, which no instruction of ours can do (a program
  // upgrade, or an RPC that lies). The first links are never forgotten, so the pool
  // stays unread, and alerted as money, until someone restarts the keeper on purpose.
  if (accounts[0]?.owner !== PROGRAM_ID) throw new Error('the pool account is not owned by our pool program');
  const p = decodePoolState(bytesOf(accounts[0], 'the pool'));
  if (p.ammConfig !== links.config || p.token0Vault !== links.vault0 || p.token1Vault !== links.vault1) {
    const e = new Error('the pool now names a different fee tier or vault than when the keeper started');
    e.code = 'REPOINTED';
    throw e;
  }
  const snap = snapshotFrom({ address, slot: res.context?.slot ?? null, accounts });
  snap.accounts.vault0 = links.vault0;
  snap.accounts.vault1 = links.vault1;
  return snap;
}

/** pool.rs is_creator_fee_on_input. null for a mode the program would reject. */
export function creatorFeeOnInput(creatorFeeOn, inputIsToken0) {
  if (creatorFeeOn === 0) return true;
  if (creatorFeeOn === 1) return inputIsToken0;
  if (creatorFeeOn === 2) return !inputIsToken0;
  return null;
}

/** What our pool pays out for `amountIn` of `inputMint`, exactly as the program would. null if it would refuse. */
export function ownSwap(snap, inputMint, amountIn) {
  const inputIsToken0 = inputMint === snap.mint0;
  if (!inputIsToken0 && inputMint !== snap.mint1) return null;
  const onInput = creatorFeeOnInput(snap.creatorFeeOn, inputIsToken0);
  if (onInput === null) return null;
  const r = swapBaseInput({
    inputAmount: amountIn,
    inputVaultAmount: inputIsToken0 ? snap.reserve0 : snap.reserve1,
    outputVaultAmount: inputIsToken0 ? snap.reserve1 : snap.reserve0,
    tradeFeeRate: snap.tradeFeeRate,
    creatorFeeRate: snap.creatorFeeRate,
    protocolFeeRate: snap.protocolFeeRate,
    fundFeeRate: snap.fundFeeRate,
    isCreatorFeeOnInput: onInput,
  });
  return r;
}

/** The pool's mid price: whole `coin` per whole `token`, before any fee. */
export function ownMid(snap, tokenMint) {
  const tokenIs0 = tokenMint === snap.mint0;
  const rt = Number(tokenIs0 ? snap.reserve0 : snap.reserve1) / 10 ** (tokenIs0 ? snap.decimals0 : snap.decimals1);
  const rc = Number(tokenIs0 ? snap.reserve1 : snap.reserve0) / 10 ** (tokenIs0 ? snap.decimals1 : snap.decimals0);
  return rc / rt;
}
