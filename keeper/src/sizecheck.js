// The size check: put the planned correction together as instructions (ours and
// Jupiter's) and measure it. Nothing is signed, simulated or sent; the transaction
// is never even serialized. It needs JUPITER_API_KEY (Jupiter serves /build only
// with a key) and KEEPER_TAKER, a public wallet address to build for.
//
// UPPER BOUND. The taker's token accounts are derived addresses the keeper does not
// compute. Where Jupiter's own setup names one, that real address is used; where it
// does not, a stand-in is counted as a separate account, which can only make the
// measured size LARGER than the real one. So "fits" is safe to believe, and "does
// not fit" by a few dozen bytes may be the stand-in.
//
// NOT ON JUPITER'S WORD. Jupiter says which lookup tables hold which addresses; the
// keeper reads each table from the chain and measures with what the chain holds (a
// table that is missing, not a lookup table, or being retired counts as no table).
// A token account Jupiter's setup names is used only when Jupiter creates it for
// the taker, paid by the taker, and it is none of our pool's own accounts.

import { PROGRAM_ID, MAX_JUPITER_ACCOUNTS, TIP_LAMPORTS, SOL_MINT } from './config.js';
import { checkForcedRoute, checkHop } from './jupiter.js';
import { measure } from './txsize.js';
import { encode } from './base58.js';

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
/** A lookup table's fixed header (LOOKUP_TABLE_META_SIZE); its addresses follow, 32 bytes each. */
const ALT_META_LEN = 56;

/** The addresses a lookup table account holds, or null if it is not a usable table. */
export function decodeLookupTable(acc) {
  if (acc?.owner !== ALT_PROGRAM || acc.data?.[1] !== 'base64') return null;
  const d = Buffer.from(acc.data[0], 'base64');
  if (d.length < ALT_META_LEN || (d.length - ALT_META_LEN) % 32 !== 0 || d.readUInt32LE(0) !== 1) return null;
  if (d.readBigUInt64LE(4) !== 0xffffffffffffffffn) return null; // being retired: a transaction cannot use it
  const out = [];
  for (let o = ALT_META_LEN; o < d.length; o += 32) out.push(encode(d.subarray(o, o + 32)));
  return out;
}

/** Jupiter's tables, as the chain holds them. */
export async function tablesOnChain(rpc, named) {
  const keys = Object.keys(named);
  if (keys.length === 0) return {};
  const res = await rpc('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed' }]);
  const out = {};
  keys.forEach((k, i) => {
    const list = decodeLookupTable(res?.value?.[i]);
    if (list) out[k] = list;
  });
  return out;
}

/** mint -> the taker's token account, as Jupiter's own create-account steps name it for the taker. */
export function atasNamedBy(instructions, taker, ours) {
  const m = new Map();
  for (const ix of instructions) {
    // Associated token account create(-idempotent): payer, account, owner, mint, system, token program.
    if (ix.programId !== ATA_PROGRAM || ix.accounts.length < 6) continue;
    const [payer, account, owner, mint] = ix.accounts.map((a) => a.pubkey);
    if (payer !== taker || owner !== taker || ours.has(account)) continue;
    m.set(mint, account);
  }
  return m;
}

/** Our leg: compute limit, wrap SOL when SOL goes in, make the output account, then the swap (13 accounts). */
export function ourLeg({ snap, taker, inputMint, outputMint, ataOf }) {
  const inIs0 = inputMint === snap.mint0;
  const a = snap.accounts;
  const progIn = inIs0 ? a.token0Program : a.token1Program;
  const progOut = inIs0 ? a.token1Program : a.token0Program;
  const ataIn = ataOf(inputMint);
  const ataOut = ataOf(outputMint);
  const ixs = [{ programId: COMPUTE_BUDGET_PROGRAM, accounts: [], dataLength: 5 }];
  if (inputMint === SOL_MINT) {
    ixs.push({ programId: SYSTEM_PROGRAM, accounts: [{ pubkey: taker, isSigner: true, isWritable: true }, { pubkey: ataIn, isSigner: false, isWritable: true }], dataLength: 12 });
    ixs.push({ programId: progIn, accounts: [{ pubkey: ataIn, isSigner: false, isWritable: true }], dataLength: 1 });
  }
  ixs.push({
    programId: ATA_PROGRAM,
    accounts: [
      { pubkey: taker, isSigner: true, isWritable: true },
      { pubkey: ataOut, isSigner: false, isWritable: true },
      { pubkey: taker, isSigner: false, isWritable: false },
      { pubkey: outputMint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: progOut, isSigner: false, isWritable: false },
    ],
    dataLength: 1,
  });
  ixs.push({
    programId: PROGRAM_ID,
    accounts: [
      { pubkey: taker, isSigner: true, isWritable: false },
      { pubkey: a.authority, isSigner: false, isWritable: false },
      { pubkey: a.ammConfig, isSigner: false, isWritable: false },
      { pubkey: snap.address, isSigner: false, isWritable: true },
      { pubkey: ataIn, isSigner: false, isWritable: true },
      { pubkey: ataOut, isSigner: false, isWritable: true },
      { pubkey: inIs0 ? a.vault0 : a.vault1, isSigner: false, isWritable: true },
      { pubkey: inIs0 ? a.vault1 : a.vault0, isSigner: false, isWritable: true },
      { pubkey: progIn, isSigner: false, isWritable: false },
      { pubkey: progOut, isSigner: false, isWritable: false },
      { pubkey: inputMint, isSigner: false, isWritable: false },
      { pubkey: outputMint, isSigner: false, isWritable: false },
      { pubkey: a.observation, isSigner: false, isWritable: true },
    ],
    // discriminator + amount in + minimum out (swap_base_output has the same shape).
    dataLength: 24,
  });
  return ixs;
}

/**
 * Build the outside hops the judged trade would use and measure the whole thing.
 * `record` is judgePool's result with `legs` (each leg's `in` is what that leg is
 * planned on, minimums included); `snap` the pool read.
 */
export async function sizeCheck({ jupiter, rpc, names, pool, snap, record, taker, ownPools }) {
  const hops = [];
  const coinIsSol = pool.coinSymbol === 'SOL';
  const buyHere = record.direction === 'buy-here-sell-outside';
  const pumpLeg = record.legs.find((l) => l.where === 'pump.fun');
  const hopLeg = record.legs.find((l) => l.where.includes('(no Raydium)'));
  const pumpIo = buyHere ? { inputMint: pool.token, outputMint: SOL_MINT } : { inputMint: SOL_MINT, outputMint: pool.token };
  hops.push({ ...pumpIo, amount: BigInt(pumpLeg.in), dexes: [names.pump], forced: true });
  if (!coinIsSol && hopLeg) {
    const io = buyHere ? { inputMint: SOL_MINT, outputMint: pool.coin } : { inputMint: pool.coin, outputMint: SOL_MINT };
    hops.push({ ...io, amount: BigInt(hopLeg.in), excludeDexes: names.raydium, forced: false });
  }

  const outside = [];
  const named = {};
  for (const h of hops) {
    const { forced, ...ask } = h;
    const b = await jupiter.build({ ...ask, taker, maxAccounts: MAX_JUPITER_ACCOUNTS, tipLamports: outside.length === 0 ? TIP_LAMPORTS : 0n });
    if (forced) checkForcedRoute(b.steps, names);
    else checkHop(b.steps, names, ownPools);
    outside.push(...b.instructions);
    Object.assign(named, b.lookupTables);
  }

  const tables = await tablesOnChain(rpc, named);
  const a = snap.accounts;
  const ours = new Set([snap.address, a.ammConfig, a.authority, a.vault0, a.vault1, a.observation, ...ownPools]);
  const atas = atasNamedBy(outside, taker, ours);
  let standIns = 0;
  const ataOf = (mint) => {
    if (atas.has(mint)) return atas.get(mint);
    standIns++;
    atas.set(mint, `stand-in account for ${mint}`);
    return atas.get(mint);
  };
  const legOurs = buyHere
    ? ourLeg({ snap, taker, inputMint: pool.coin, outputMint: pool.token, ataOf })
    : ourLeg({ snap, taker, inputMint: pool.token, outputMint: pool.coin, ataOf });

  const m = measure({ payer: taker, instructions: [...legOurs, ...outside], lookupTables: tables });
  return {
    ...m,
    upperBound: standIns > 0,
    standIns,
    tablesNamed: Object.keys(named).length,
    tablesOnChain: Object.keys(tables).length,
    jupiterHops: hops.length,
  };
}
