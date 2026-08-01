// One-off: create the operator PAYER keypair the DBC harness signs with.
//
// Deliberately NOT the Solana CLI: installing it on this box is unnecessary when
// @solana/web3.js is already here, and the CLI's own test-validator is documented as
// broken under Windows symlink privileges anyway.
//
// Writes the CLI-compatible secret-key array (what OPERATOR_KEYPAIR expects), prints ONLY
// the public key, and REFUSES to overwrite an existing file — clobbering a funded payer
// would strand its SOL with no way back.
//
//   node scripts/make-operator-keypair.mjs <output-path>

import { Keypair } from '@solana/web3.js';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'operator-payer.json');

if (existsSync(out)) {
  console.error(`REFUSING: ${out} already exists.`);
  console.error('Overwriting a keypair destroys it. Delete it yourself if you are certain.');
  process.exit(1);
}

const kp = Keypair.generate();
mkdirSync(dirname(out), { recursive: true });
// EXCLUSIVE create. The existsSync above is only for the friendly error message — on its
// own it is a time-of-check-to-time-of-use race, so the "never overwrite" promise would be
// best-effort rather than a guarantee. Here that promise is load-bearing: the file it would
// clobber is a FUNDED payer keypair, and overwriting it strands the SOL with no way back.
// `wx` makes the create fail atomically if the path exists. (Flagged by CodeQL.)
try {
  writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)), { flag: 'wx', mode: 0o600 });
} catch (e) {
  if (e && e.code === 'EEXIST') {
    console.error(`REFUSING: ${out} appeared while this script was running.`);
    console.error('Nothing was written. Overwriting a keypair destroys it.');
    process.exit(1);
  }
  throw e;
}

console.log('');
console.log('  Keypair written to : ' + out);
console.log('  PUBLIC KEY         : ' + kp.publicKey.toBase58());
console.log('');
console.log('  FUND THAT PUBLIC KEY with ~0.5 SOL, then set:');
  console.log("    $env:OPERATOR_KEYPAIR = '" + out + "'");
console.log('');
console.log('  The file IS the private key. Do not commit it, paste it, or screenshot it.');
console.log('');
