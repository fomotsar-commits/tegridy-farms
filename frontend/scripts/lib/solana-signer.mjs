// A Solana signer and transaction builder in plain Node, with no package: the jobs that hold a
// key run without an npm install, so no third-party code runs next to it (venue-volume.yml's
// rule). Everything here is checked against @solana/web3.js in solana-signer.test.mjs.
//
//   isOnCurve(bytes)            curve25519-dalek's CompressedEdwardsY::decompress().is_some(),
//                               which is what Solana's own is_on_curve asks
//   findProgramAddress(...)     Solana's find_program_address: the first bump from 255 down
//                               whose hash is off the curve
//   associatedTokenAddress(...) the associated token account program's address for (owner, mint)
//   keypairSigner(json)         an ed25519 signer from a keypair file's 64 numbers (node:crypto)
//   compileLegacy(...)          a legacy transaction message; signTransaction(...) the wire bytes
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { base58, unbase58 } from "./venue-volume-chain.mjs";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** A 32-byte key from a base58 string, or the bytes themselves; refuses anything else. */
export function keyBytes(k) {
  const b = typeof k === "string" ? unbase58(k) : Buffer.from(k);
  if (b.length !== 32) throw new Error(`a key must be 32 bytes, this one is ${b.length}`);
  return b;
}

// ed25519 over GF(2^255 - 19).
const P = (1n << 255n) - 19n;
const mod = (a) => ((a % P) + P) % P;
function pow(b, e) {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const D = mod(-121665n * pow(121666n, P - 2n));

/**
 * Is this 32-byte string the encoding of a point on the ed25519 curve? As curve25519-dalek's
 * decompress decides it: y is the low 255 bits (the top bit is x's sign) reduced mod p, and the
 * point exists when u / v (u = y^2 - 1, v = d y^2 + 1) has a square root (sqrt_ratio_i).
 */
export function isOnCurve(bytes) {
  const b = keyBytes(bytes);
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  y = mod(y & ((1n << 255n) - 1n));
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = (((v * v) % P) * v) % P;
  const v7 = (((v3 * v3) % P) * v) % P;
  const x = (((u * v3) % P) * pow((u * v7) % P, (P - 5n) / 8n)) % P;
  const check = (((v * x) % P) * x) % P;
  return check === u || check === mod(-u);
}

/** create_program_address: null when the hash lands on the curve. Seeds are Buffers of at most 32 bytes. */
export function createProgramAddress(seeds, programId) {
  const h = createHash("sha256");
  for (const s of seeds) {
    if (s.length > 32) throw new Error("a seed is at most 32 bytes");
    h.update(s);
  }
  h.update(keyBytes(programId));
  h.update(Buffer.from("ProgramDerivedAddress"));
  const out = h.digest();
  return isOnCurve(out) ? null : out;
}

/** find_program_address: { address (base58), bump }. */
export function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const a = createProgramAddress([...seeds, Buffer.from([bump])], programId);
    if (a) return { address: base58(a), bump };
  }
  throw new Error("no bump gives an address off the curve");
}

/** The associated token account of `owner` for `mint` under `tokenProgram` (base58 in, base58 out). */
export function associatedTokenAddress(owner, mint, tokenProgram) {
  return findProgramAddress([keyBytes(owner), keyBytes(tokenProgram), keyBytes(mint)], ATA_PROGRAM).address;
}

/** The associated token account program's CreateIdempotent: `payer` pays, `owner` owns. */
export function createIdempotentIx({ payer, owner, mint, tokenProgram }) {
  return {
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  };
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
/**
 * A signer from a Solana keypair file's text (a JSON array of 64 numbers: the secret seed, then
 * the public key). Refuses a file whose two halves do not belong together.
 */
export function keypairSigner(text) {
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new Error("the keypair is not JSON");
  }
  if (!Array.isArray(arr) || arr.length !== 64 || arr.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error("a keypair is a JSON array of 64 numbers from 0 to 255");
  }
  const seed = Buffer.from(arr.slice(0, 32));
  const publicKey = Buffer.from(arr.slice(32));
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  if (!Buffer.from(spki.subarray(spki.length - 32)).equals(publicKey)) throw new Error("the keypair's public half does not match its secret");
  return { address: base58(publicKey), sign: (message) => edSign(null, message, key) };
}

/** Solana's compact-u16. */
export function compactU16(n) {
  const out = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return Buffer.from(out);
    }
    out.push(b | 0x80);
  }
}

/**
 * A legacy message: the fee payer first, then the other signers, writable before read-only,
 * then the other accounts, writable before read-only (each group in first-seen order), then the
 * header, the keys, the blockhash and the instructions. Instructions are
 * { programId, keys: [{ pubkey, isSigner, isWritable }], data } with base58 keys.
 */
export function compileLegacy({ payer, instructions, recentBlockhash }) {
  const metas = new Map();
  const touch = (pubkey, isSigner, isWritable) => {
    const m = metas.get(pubkey) ?? { pubkey, isSigner: false, isWritable: false, order: metas.size };
    m.isSigner ||= isSigner;
    m.isWritable ||= isWritable;
    metas.set(pubkey, m);
  };
  touch(payer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) touch(k.pubkey, k.isSigner, k.isWritable);
    touch(ix.programId, false, false);
  }
  const rank = (m) => (m.pubkey === payer ? 0 : m.isSigner ? (m.isWritable ? 1 : 2) : m.isWritable ? 3 : 4);
  const keys = [...metas.values()].sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  const index = new Map(keys.map((k, i) => [k.pubkey, i]));
  const signers = keys.filter((k) => k.isSigner);
  const header = Buffer.from([
    signers.length,
    signers.filter((k) => !k.isWritable).length,
    keys.filter((k) => !k.isSigner && !k.isWritable).length,
  ]);
  const parts = [header, compactU16(keys.length), ...keys.map((k) => keyBytes(k.pubkey)), keyBytes(recentBlockhash), compactU16(instructions.length)];
  for (const ix of instructions) {
    const data = Buffer.from(ix.data);
    parts.push(
      Buffer.from([index.get(ix.programId)]),
      compactU16(ix.keys.length),
      Buffer.from(ix.keys.map((k) => index.get(k.pubkey))),
      compactU16(data.length),
      data
    );
  }
  if (keys.length > 256) throw new Error("a legacy message holds at most 256 accounts");
  return { message: Buffer.concat(parts), signers: signers.map((k) => k.pubkey) };
}

/** The wire bytes of a legacy transaction whose only signer is `signer` (the fee payer). */
export function signTransaction(compiled, signer) {
  if (compiled.signers.length !== 1 || compiled.signers[0] !== signer.address) {
    throw new Error(`this transaction needs the signatures of ${compiled.signers.join(", ")}, not only ${signer.address}`);
  }
  const sig = signer.sign(compiled.message);
  return Buffer.concat([compactU16(1), sig, compiled.message]);
}
