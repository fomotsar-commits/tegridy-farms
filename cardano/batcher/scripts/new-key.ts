// Makes the batcher's signing key, on the server, into a file only its owner can read
// (the owner's ruling: made on the server, never copied). Refuses to overwrite a key. Prints only
// the key hash and the address to fund; the key itself is never printed.
//   node scripts/new-key.ts <path> [mainnet|preprod]
import { existsSync, writeFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';

const [path, net = 'mainnet'] = process.argv.slice(2);
if (!path) throw new Error('usage: node scripts/new-key.ts <path> [mainnet|preprod]');
if (existsSync(path)) throw new Error(`${path} exists: a batcher key is never overwritten`);
const key = CSL.PrivateKey.generate_ed25519();
const cborHex = `5820${Buffer.from(key.as_bytes()).toString('hex')}`;
writeFileSync(path, `${JSON.stringify({ type: 'PaymentSigningKeyShelley_ed25519', description: 'Batcher signing key', cborHex }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const hash = key.to_public().hash();
const address = CSL.EnterpriseAddress.new(net === 'mainnet' ? 1 : 0, CSL.Credential.from_keyhash(hash)).to_address().to_bech32(undefined);
console.log(JSON.stringify({ keyHash: hash.to_hex(), address }));
