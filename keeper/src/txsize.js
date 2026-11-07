// Would one correction fit in one Solana transaction?
//
// A transaction is at most 1,232 bytes. Our pool's swap names 13 accounts that are
// in no lookup table, and Jupiter's leg brings its own; if the two do not fit, the
// live keeper needs a lookup table of our own, which the OWNER must create and sign
// on mainnet. That takes lead time, so week 1 measures it.
//
// This file computes the exact size of a version-0 transaction without building or
// signing one. `classify` is web3.js's own rule (CompiledKeys.extractTableLookup):
// a signer or an invoked program is always written out in full; any other account
// found in a lookup table is named by a one-byte index instead. `sizeFromCompiled`
// is the wire format, and test/txsize.test.mjs checks it against the byte length of
// a real mainnet transaction.

export const MAX_TX_BYTES = 1232;
/** Accounts one transaction may lock. 64 is the long-standing limit; treated as the ceiling here. */
export const MAX_ACCOUNT_LOCKS = 64;

/** Bytes a compact-u16 length takes. */
export function compactLen(n) {
  if (n < 0x80) return 1;
  if (n < 0x4000) return 2;
  return 3;
}

/**
 * Split accounts into written-out keys and lookup-table indexes.
 * instructions: [{ programId, accounts: [{ pubkey, isSigner, isWritable }], dataLength }]
 * lookupTables: { tableAddress: [address, ...] }
 */
export function classify({ payer, instructions, lookupTables = {} }) {
  const meta = new Map();
  const touch = (key, f) => {
    const m = meta.get(key) ?? { isSigner: false, isWritable: false, isInvoked: false };
    meta.set(key, f(m));
  };
  touch(payer, (m) => ({ ...m, isSigner: true, isWritable: true }));
  for (const ix of instructions) {
    touch(ix.programId, (m) => ({ ...m, isInvoked: true }));
    for (const a of ix.accounts) touch(a.pubkey, (m) => ({ ...m, isSigner: m.isSigner || a.isSigner, isWritable: m.isWritable || a.isWritable }));
  }
  const lookups = [];
  for (const [table, addresses] of Object.entries(lookupTables)) {
    const set = new Set(addresses);
    let writable = 0;
    let readonly = 0;
    for (const [key, m] of [...meta]) {
      if (m.isSigner || m.isInvoked || !set.has(key)) continue;
      if (m.isWritable) writable++;
      else readonly++;
      meta.delete(key);
    }
    if (writable + readonly > 0) lookups.push({ table, writable, readonly });
  }
  const staticKeys = [...meta.keys()];
  const signatures = [...meta.values()].filter((m) => m.isSigner).length;
  return { staticKeys: staticKeys.length, signatures, lookups };
}

/**
 * The exact serialized length of a v0 transaction:
 * signatures, then the message (version byte, 3-byte header, keys, blockhash,
 * instructions, lookup tables).
 */
export function sizeFromCompiled({ signatures, staticKeys, instructions, lookups, legacy = false }) {
  // A legacy message has no version byte and no lookup-table section.
  let msg = (legacy ? 0 : 1) + 3; // version prefix + header
  msg += compactLen(staticKeys) + 32 * staticKeys;
  msg += 32; // recent blockhash
  msg += compactLen(instructions.length);
  for (const ix of instructions) {
    msg += 1 + compactLen(ix.accountCount) + ix.accountCount + compactLen(ix.dataLength) + ix.dataLength;
  }
  if (legacy) return compactLen(signatures) + 64 * signatures + msg;
  msg += compactLen(lookups.length);
  for (const l of lookups) {
    msg += 32 + compactLen(l.writable) + l.writable + compactLen(l.readonly) + l.readonly;
  }
  return compactLen(signatures) + 64 * signatures + msg;
}

export function measure({ payer, instructions, lookupTables }) {
  const c = classify({ payer, instructions, lookupTables });
  const bytes = sizeFromCompiled({
    signatures: c.signatures,
    staticKeys: c.staticKeys,
    instructions: instructions.map((ix) => ({ accountCount: ix.accounts.length, dataLength: ix.dataLength })),
    lookups: c.lookups,
  });
  const locks = c.staticKeys + c.lookups.reduce((n, l) => n + l.writable + l.readonly, 0);
  return { bytes, fits: bytes <= MAX_TX_BYTES, accounts: locks, accountsOk: locks <= MAX_ACCOUNT_LOCKS, staticKeys: c.staticKeys, tables: c.lookups.length };
}
