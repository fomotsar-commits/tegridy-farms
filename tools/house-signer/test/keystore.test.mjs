// The keystore: the official Web3 Secret Storage v3 vectors (PBKDF2 and scrypt) decrypt to
// the published key; a wrong password, an edited file or an unsupported cipher is refused;
// a new keystore round-trips and is never overwritten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  CREATE_SCRYPT, createKeystoreFile, decryptKeystore, encryptKeystore, KEYSTORE_FILE, keystoreAddressField, passwordProblem,
} from '../src/keystore.mjs';
import { addressOf } from '../src/sign.mjs';
import { bytesToPlainHex } from '../src/hex.mjs';
import { HOUSE, HOUSE_KEY, OTHER, tempDir } from './support/helpers.mjs';

const VECTORS = JSON.parse(fs.readFileSync(new URL('./fixtures/v3-vectors.json', import.meta.url), 'utf8'));
const FAST = { n: 2 ** 10, r: 8, p: 1 };

async function refusedBy(promise, pin) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.pin, pin, `expected ${pin}, got ${e.pin}: ${e.message}`);
    return true;
  });
}

test('the official PBKDF2-SHA-256 vector decrypts to the published key', async () => {
  const key = await decryptKeystore(VECTORS.pbkdf2, VECTORS.password);
  assert.equal(addressOf(key), VECTORS.address);
});

test('the official scrypt vector (N 2^18, r 1, p 8) decrypts to the published key', async () => {
  // OpenSSL refuses these parameters (RFC 7914: N < 2^(16r)); the keystore computes the
  // same scrypt with @noble/hashes for exactly that case.
  const key = await decryptKeystore(JSON.stringify(VECTORS.scrypt), VECTORS.password);
  assert.equal(addressOf(key), VECTORS.address);
});

test('node:crypto scrypt and @noble/hashes scrypt agree where both run', async () => {
  const { scrypt } = await import('@noble/hashes/scrypt.js');
  const salt = crypto.randomBytes(32);
  const native = crypto.scryptSync(Buffer.from('agree'), salt, 32, { N: 2 ** 12, r: 8, p: 2 });
  assert.deepEqual(Buffer.from(scrypt(Buffer.from('agree'), salt, { N: 2 ** 12, r: 8, p: 2, dkLen: 32 })), native);
});

test('PIN:K.mac a wrong password is refused by the MAC, before anything is decrypted', async () => {
  await refusedBy(decryptKeystore(VECTORS.pbkdf2, 'testpassword!'), 'K.mac');
  const doc = await encryptKeystore(HOUSE_KEY, 'right password here', FAST);
  await refusedBy(decryptKeystore(doc, 'wrong password here'), 'K.mac');
});

test('PIN:K.mac an edited ciphertext is refused', async () => {
  const doc = await encryptKeystore(HOUSE_KEY, 'right password here', FAST);
  const flipped = doc.crypto.ciphertext.slice(0, -1) + (doc.crypto.ciphertext.endsWith('0') ? '1' : '0');
  await refusedBy(decryptKeystore({ ...doc, crypto: { ...doc.crypto, ciphertext: flipped } }, 'right password here'), 'K.mac');
});

test('PIN:K.cipher a cipher other than aes-128-ctr is refused', async () => {
  const doc = structuredClone(VECTORS.pbkdf2);
  doc.crypto.cipher = 'aes-128-cbc';
  await refusedBy(decryptKeystore(doc, VECTORS.password), 'K.cipher');
});

test('PIN:K.address a keystore whose address field names another key is refused', async () => {
  const doc = await encryptKeystore(HOUSE_KEY, 'right password here', FAST);
  assert.equal(`0x${doc.address}`, HOUSE.toLowerCase());
  await refusedBy(decryptKeystore({ ...doc, address: OTHER.slice(2) }, 'right password here'), 'K.address');
});

test('PIN:K.key a keystore that decrypts to an invalid key (zero) is refused even with a good MAC', async () => {
  // Built by hand: the encryptor itself refuses invalid keys.
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const dk = crypto.scryptSync(Buffer.from('right password here'), salt, 32, { N: FAST.n, r: FAST.r, p: FAST.p });
  const cipher = crypto.createCipheriv('aes-128-ctr', dk.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.alloc(32)), cipher.final()]);
  const mac = keccak_256(Buffer.concat([dk.subarray(16, 32), ciphertext]));
  const doc = {
    version: 3,
    crypto: {
      cipher: 'aes-128-ctr', cipherparams: { iv: iv.toString('hex') }, ciphertext: ciphertext.toString('hex'), kdf: 'scrypt',
      kdfparams: { dklen: 32, n: FAST.n, r: FAST.r, p: FAST.p, salt: salt.toString('hex') }, mac: bytesToPlainHex(mac),
    },
  };
  await refusedBy(decryptKeystore(doc, 'right password here'), 'K.key');
});

test('KDF parameters outside safe bounds are refused rather than run', async () => {
  const doc = await encryptKeystore(HOUSE_KEY, 'right password here', FAST);
  const big = structuredClone(doc);
  big.crypto.kdfparams.n = 2 ** 22;
  await assert.rejects(decryptKeystore(big, 'right password here'), /scrypt n/);
  const odd = structuredClone(doc);
  odd.crypto.kdfparams.n = 1000;
  await assert.rejects(decryptKeystore(odd, 'right password here'), /power of two/);
  const pb = structuredClone(VECTORS.pbkdf2);
  pb.crypto.kdfparams.prf = 'hmac-sha1';
  await assert.rejects(decryptKeystore(pb, VECTORS.password), /hmac-sha256/);
  const v2 = { ...structuredClone(VECTORS.pbkdf2), version: 2 };
  await assert.rejects(decryptKeystore(v2, VECTORS.password), /version 3/);
  await assert.rejects(decryptKeystore('{not json', 'x'), /not valid JSON/);
});

test('encrypt then decrypt round-trips the key', async () => {
  const doc = await encryptKeystore(HOUSE_KEY, 'a long enough password', FAST);
  const back = await decryptKeystore(JSON.stringify(doc), 'a long enough password');
  assert.deepEqual(back, HOUSE_KEY);
});

test('create writes a scrypt 2^18 keystore that opens with its password, prints nothing but the address, and never overwrites', async () => {
  const dir = tempDir('create');
  try {
    const address = await createKeystoreFile(dir, 'correct horse battery staple');
    assert.match(address, /^0x[0-9a-f]{40}$/);
    const text = fs.readFileSync(path.join(dir, KEYSTORE_FILE), 'utf8');
    const doc = JSON.parse(text);
    assert.equal(doc.version, 3);
    assert.equal(doc.crypto.kdf, 'scrypt');
    assert.deepEqual([doc.crypto.kdfparams.n, doc.crypto.kdfparams.r, doc.crypto.kdfparams.p], [CREATE_SCRYPT.n, CREATE_SCRYPT.r, CREATE_SCRYPT.p]);
    assert.equal(keystoreAddressField(dir), address);
    const key = await decryptKeystore(text, 'correct horse battery staple');
    assert.equal(addressOf(key), address);
    await assert.rejects(createKeystoreFile(dir, 'correct horse battery staple'), /already exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a create that fails after the file is reserved leaves no file behind, and the next try still works', async () => {
  // The file is reserved with an exclusive create before the slow key derivation. If anything
  // after that fails (here: scrypt parameters it refuses), the empty reservation must go too,
  // or the owner's next `create` would refuse with "already exists" over a 0-byte file.
  const dir = tempDir('create-fail');
  try {
    await assert.rejects(createKeystoreFile(dir, 'correct horse battery staple', { n: 3, r: 8, p: 1 }));
    assert.equal(fs.existsSync(path.join(dir, KEYSTORE_FILE)), false);
    const address = await createKeystoreFile(dir, 'correct horse battery staple');
    assert.match(address, /^0x[0-9a-f]{40}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create refuses short or non-ASCII passwords', async () => {
  assert.match(passwordProblem('short'), /12 characters/);
  assert.match(passwordProblem('pässwörd-long-enough'), /ASCII/);
  assert.equal(passwordProblem('correct horse battery staple'), null);
  const dir = tempDir('create-weak');
  try {
    await assert.rejects(createKeystoreFile(dir, 'short'), /12 characters/);
    assert.equal(fs.existsSync(path.join(dir, KEYSTORE_FILE)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
