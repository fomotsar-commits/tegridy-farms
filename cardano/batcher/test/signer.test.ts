// The batcher's key: made by scripts/new-key.ts into a file only its owner reads, never printed,
// never overwritten; loaded, it signs as the key whose hash it printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { keyFromFile, makeKeyFile, signerOf } from '../src/signer.ts';

const SCRIPT = new URL('../scripts/new-key.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('a new key: only its hash and address printed, the file never overwritten, and it signs as that key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batcher-key-'));
  try {
    const path = join(dir, 'batcher.skey');
    const out = execFileSync(process.execPath, [SCRIPT, path], { encoding: 'utf8' });
    const printed = JSON.parse(out) as { keyHash: string; address: string };
    const file = JSON.parse(readFileSync(path, 'utf8')) as { cborHex: string };
    assert.ok(!out.includes(file.cborHex.slice(4)), 'the key itself was printed');
    assert.match(printed.address, /^addr1v/);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o077, 0, 'the key file is readable by others');
    else {
      // Node ignores the mode on Windows: the access list must name this user alone.
      const acl = execFileSync('icacls', [path], { encoding: 'utf8' });
      const entries = acl.split(/\r?\n/).map((l) => l.replace(path, '').trim()).filter((l) => /:\(/.test(l));
      assert.equal(entries.length, 1, acl);
      assert.ok(entries[0]!.toLowerCase().includes(`\\${String(process.env.USERNAME).toLowerCase()}:(f)`), acl);
    }
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, path], { stdio: 'pipe' }), /never overwritten/);
    assert.equal(readFileSync(path, 'utf8').includes(file.cborHex), true);

    const signer = signerOf(keyFromFile(path));
    assert.equal(signer.keyHash, printed.keyHash);
    // An empty transaction body, signed: the witness is the printed key's.
    const body = CSL.TransactionBody.new_tx_body(CSL.TransactionInputs.new(), CSL.TransactionOutputs.new(), CSL.BigNum.from_str('0'));
    const tx = CSL.Transaction.new(body, CSL.TransactionWitnessSet.new(), undefined).to_hex();
    const signed = CSL.Transaction.from_hex(signer.sign(tx));
    assert.equal(signed.witness_set().vkeys()!.get(0).vkey().public_key().hash().to_hex(), printed.keyHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('anything but a payment signing key file is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batcher-key-'));
  try {
    const path = join(dir, 'bad.skey');
    writeFileSync(path, JSON.stringify({ type: 'StakeSigningKeyShelley_ed25519', cborHex: `5820${'11'.repeat(32)}` }));
    assert.throws(() => keyFromFile(path), /not a payment signing key/);
    writeFileSync(path, 'not json');
    assert.throws(() => keyFromFile(path), /not readable JSON/);
    assert.throws(() => keyFromFile(join(dir, 'missing.skey')), /cannot be read \(ENOENT\): is the volume mounted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the key is written whole, then linked into place: a half-made one left by a kill is replaced, and nothing but the key is left', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batcher-key-'));
  try {
    const path = join(dir, 'batcher.skey');
    // A run killed before the link: its .new was never shown, so nothing was funded.
    writeFileSync(`${path}.new`, '{"type": "PaymentSigningKeyShelley_ed25519", "cbor');
    const made = makeKeyFile(path, 1);
    assert.deepEqual(readdirSync(dir), ['batcher.skey']);
    assert.equal(signerOf(keyFromFile(path)).keyHash, made.keyHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a link never replaces what is at the key path, even what only looks absent (a dangling symlink)', { skip: process.platform === 'win32' ? 'symlinks need an administrator on Windows; CI runs it on Linux' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'batcher-key-'));
  try {
    const path = join(dir, 'batcher.skey');
    symlinkSync(join(dir, 'nowhere'), path);
    assert.throws(() => makeKeyFile(path, 1), /never overwritten/);
    assert.ok(lstatSync(path).isSymbolicLink(), 'the link was replaced');
    assert.deepEqual(readdirSync(dir), ['batcher.skey']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
