// The house key at rest: a Web3 Secret Storage v3 file (the format geth, MetaMask and
// Foundry's `cast wallet` read), encrypted with a password only the owner types.
//
// Decrypting: the key-derivation function is scrypt or PBKDF2-HMAC-SHA256, the cipher is
// AES-128-CTR, from node:crypto (see scryptAsync for the one legacy case it cannot compute).
// The MAC, keccak256(derivedKey[16..31] ++ ciphertext),
// is checked in constant time BEFORE anything is decrypted, so a wrong password or an
// edited file is refused rather than turned into some other key.
//
// Creating: a fresh key from crypto.randomBytes, scrypt n = 2^18, r = 8, p = 1 (geth's
// "standard" strength), written once with flag 'wx' so an existing keystore is never
// overwritten. Only the address is ever printed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scrypt as nobleScrypt } from '@noble/hashes/scrypt.js';
import { keccak256 } from './keccak.mjs';
import { addressOf, isValidPrivateKey } from './sign.mjs';
import { bytesToPlainHex, concatBytes, eqAddr, isPlainObject, plainHexToBytes } from './hex.mjs';

export const KEYSTORE_FILE = 'keystore.json';
export const CREATE_SCRYPT = Object.freeze({ n: 2 ** 18, r: 8, p: 1 });

// Bounds on what a keystore may ask the KDF for. A file asking for more is refused rather
// than allowed to exhaust memory or time; real keystores sit far inside these.
const SCRYPT_MAX_N = 2 ** 20;
const SCRYPT_MAX_R = 8;
const SCRYPT_MAX_P = 16;
const PBKDF2_MAX_C = 10_000_000;

export class KeystoreError extends Error {
  constructor(message, pin) {
    super(message);
    this.pin = pin;
  }
}

function fail(reason, pin) {
  throw new KeystoreError(reason, pin);
}

function hexField(value, bytes, what) {
  if (typeof value !== 'string') fail(`the keystore's ${what} is missing`);
  const clean = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) fail(`the keystore's ${what} is not hex`);
  const out = plainHexToBytes(clean);
  if (bytes !== undefined && out.length !== bytes) fail(`the keystore's ${what} should be ${bytes} bytes`);
  return out;
}

/**
 * scrypt from node:crypto (native). OpenSSL also enforces RFC 7914's bound N < 2^(16r),
 * which the original Web3 Secret Storage scrypt vector (N 2^18, r 1, p 8) and keystores
 * made the same way exceed; for exactly that refusal the same function is computed with the
 * pinned @noble/hashes scrypt instead. Keystores this signer creates (r 8) never need it.
 */
function scryptAsync(password, salt, n, r, p) {
  const maxmem = 256 * n * r + 16 * 1024 * 1024;
  const onlyTheRfcBound = (e) => e?.code === 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS' && 16 * r < 53 && n >= 2 ** (16 * r);
  return new Promise((resolve, reject) => {
    const viaNoble = () => {
      try {
        resolve(nobleScrypt(password, salt, { N: n, r, p, dkLen: 32, maxmem }));
      } catch (e) {
        reject(e);
      }
    };
    try {
      // node checks the parameters synchronously (throws) and runs the work asynchronously.
      crypto.scrypt(password, salt, 32, { N: n, r, p, maxmem }, (err, key) => {
        if (!err) resolve(new Uint8Array(key));
        else if (onlyTheRfcBound(err)) viaNoble();
        else reject(err);
      });
    } catch (e) {
      if (onlyTheRfcBound(e)) viaNoble();
      else reject(e);
    }
  });
}

function pbkdf2Async(password, salt, c) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, c, 32, 'sha256', (err, key) => (err ? reject(err) : resolve(new Uint8Array(key))));
  });
}

async function deriveKey(cryptoSection, passwordBytes) {
  const params = cryptoSection.kdfparams;
  if (!isPlainObject(params)) fail('the keystore has no kdfparams');
  if (params.dklen !== 32) fail('the keystore must derive a 32-byte key (dklen 32)');
  const salt = hexField(params.salt, undefined, 'salt');
  if (salt.length < 16) fail('the keystore salt is shorter than 16 bytes');
  if (cryptoSection.kdf === 'scrypt') {
    const { n, r, p } = params;
    if (!Number.isSafeInteger(n) || n < 2 || n > SCRYPT_MAX_N || (n & (n - 1)) !== 0) fail('the keystore scrypt n is not a power of two within bounds');
    if (!Number.isSafeInteger(r) || r < 1 || r > SCRYPT_MAX_R) fail('the keystore scrypt r is out of bounds');
    if (!Number.isSafeInteger(p) || p < 1 || p > SCRYPT_MAX_P) fail('the keystore scrypt p is out of bounds');
    return scryptAsync(passwordBytes, salt, n, r, p);
  }
  if (cryptoSection.kdf === 'pbkdf2') {
    if (params.prf !== 'hmac-sha256') fail('the keystore pbkdf2 prf must be hmac-sha256');
    const { c } = params;
    if (!Number.isSafeInteger(c) || c < 1 || c > PBKDF2_MAX_C) fail('the keystore pbkdf2 iteration count is out of bounds');
    return pbkdf2Async(passwordBytes, salt, c);
  }
  return fail('the keystore kdf must be scrypt or pbkdf2');
}

function aes128ctr(key16, iv, input) {
  const cipher = crypto.createDecipheriv('aes-128-ctr', key16, iv);
  return new Uint8Array(Buffer.concat([cipher.update(input), cipher.final()]));
}

/** keystore JSON (text or parsed) + password -> the 32-byte private key. Throws KeystoreError. */
export async function decryptKeystore(json, password) {
  if (typeof password !== 'string') fail('a password is required');
  let doc;
  try {
    doc = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    fail('the keystore is not valid JSON');
  }
  if (!isPlainObject(doc) || doc.version !== 3) fail('not a version 3 keystore');
  const section = doc.crypto ?? doc.Crypto;
  if (!isPlainObject(section)) fail('the keystore has no crypto section');
  if (section.cipher !== 'aes-128-ctr') fail('the keystore cipher must be aes-128-ctr', 'K.cipher'); // PIN:K.cipher
  const iv = hexField(section.cipherparams?.iv, 16, 'iv');
  const ciphertext = hexField(section.ciphertext, 32, 'ciphertext');
  const mac = hexField(section.mac, 32, 'mac');
  const dk = await deriveKey(section, Buffer.from(password, 'utf8'));
  try {
    const computed = keccak256(concatBytes(dk.slice(16, 32), ciphertext));
    if (!crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(mac))) fail('wrong password, or the keystore file has been damaged or edited', 'K.mac'); // PIN:K.mac
    const key = aes128ctr(dk.slice(0, 16), iv, ciphertext);
    if (!isValidPrivateKey(key)) fail('the keystore decrypts to something that is not a valid key', 'K.key'); // PIN:K.key
    if (doc.address !== undefined && !eqAddr(`0x${String(doc.address).replace(/^0x/i, '')}`, addressOf(key))) fail('the keystore address field does not match its key; the file has been edited', 'K.address'); // PIN:K.address
    return key;
  } finally {
    dk.fill(0);
  }
}

/** Encrypt a key into a v3 keystore object (scrypt). `fixed` lets tests pin salt/iv/id. */
export async function encryptKeystore(privateKey, password, { n, r, p } = CREATE_SCRYPT, fixed = {}) {
  if (!isValidPrivateKey(privateKey)) fail('not a valid private key');
  const salt = fixed.salt ?? new Uint8Array(crypto.randomBytes(32));
  const iv = fixed.iv ?? new Uint8Array(crypto.randomBytes(16));
  const dk = await scryptAsync(Buffer.from(password, 'utf8'), salt, n, r, p);
  try {
    const cipher = crypto.createCipheriv('aes-128-ctr', dk.slice(0, 16), iv);
    const ciphertext = new Uint8Array(Buffer.concat([cipher.update(privateKey), cipher.final()]));
    const mac = keccak256(concatBytes(dk.slice(16, 32), ciphertext));
    return {
      address: addressOf(privateKey).slice(2),
      crypto: {
        cipher: 'aes-128-ctr',
        cipherparams: { iv: bytesToPlainHex(iv) },
        ciphertext: bytesToPlainHex(ciphertext),
        kdf: 'scrypt',
        kdfparams: { dklen: 32, n, p, r, salt: bytesToPlainHex(salt) },
        mac: bytesToPlainHex(mac),
      },
      id: fixed.id ?? crypto.randomUUID(),
      version: 3,
    };
  } finally {
    dk.fill(0);
  }
}

/** Printable ASCII only, at least 12 characters: other wallets hash non-ASCII passwords differently. */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 12) return 'the password must be at least 12 characters';
  if (!/^[\x20-\x7e]+$/.test(password)) return 'use plain ASCII characters (other wallets read accented or non-Latin passwords differently)';
  return null;
}

/**
 * Make a brand-new house key and write keys/keystore.json. Refuses to overwrite.
 * Returns the address; the key itself never leaves this function.
 */
export async function createKeystoreFile(keysDir, password, params = CREATE_SCRYPT) {
  const problem = passwordProblem(password);
  if (problem) fail(problem);
  const file = path.join(keysDir, KEYSTORE_FILE);
  if (fs.existsSync(file)) fail(`${file} already exists; the signer never overwrites a key`);
  let key;
  do {
    key = new Uint8Array(crypto.randomBytes(32));
  } while (!isValidPrivateKey(key));
  try {
    const doc = await encryptKeystore(key, password, params);
    // Prove the file opens with this password before it is the only copy of the key.
    const back = await decryptKeystore(doc, password);
    const same = crypto.timingSafeEqual(Buffer.from(back), Buffer.from(key));
    back.fill(0);
    if (!same) fail('the new keystore did not decrypt back to its key; nothing was written');
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return `0x${doc.address}`;
  } finally {
    key.fill(0);
  }
}

/** The address a keystore file says it holds, without the password (the field is not authenticated). */
export function keystoreAddressField(keysDir) {
  const doc = JSON.parse(fs.readFileSync(path.join(keysDir, KEYSTORE_FILE), 'utf8'));
  if (typeof doc.address !== 'string' || !/^(0x)?[0-9a-fA-F]{40}$/.test(doc.address)) fail('the keystore has no address field');
  return `0x${doc.address.replace(/^0x/i, '').toLowerCase()}`;
}
