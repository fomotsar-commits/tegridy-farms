// The batcher's key: made by scripts/new-key.ts into a file only its owner reads, never printed,
// never overwritten; loaded, it signs as the key whose hash it printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { keyFromFile, signerOf } from '../src/signer.ts';

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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
