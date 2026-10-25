// Makes the batcher's signing key, on the server, into a file only its owner can read
// (the owner's ruling: made on the server, never copied). Refuses to overwrite a key. Prints only
// the key hash and the address to fund; the key itself is never printed.
// On Windows, Node ignores the file mode: the file's access list is cut down to the current user
// (icacls), and if that fails the new, never-used key is deleted rather than left readable.
//   node scripts/new-key.ts <path> [mainnet|preprod]
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';

const [path, net = 'mainnet'] = process.argv.slice(2);
if (!path) throw new Error('usage: node scripts/new-key.ts <path> [mainnet|preprod]');
if (existsSync(path)) throw new Error(`${path} exists: a batcher key is never overwritten`);
const key = CSL.PrivateKey.generate_ed25519();
const cborHex = `5820${Buffer.from(key.as_bytes()).toString('hex')}`;
writeFileSync(path, `${JSON.stringify({ type: 'PaymentSigningKeyShelley_ed25519', description: 'Batcher signing key', cborHex }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
if (process.platform === 'win32') {
  const user = process.env.USERNAME;
  try {
    if (!user) throw new Error('USERNAME is not set');
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'pipe' });
  } catch (e) {
    rmSync(path, { force: true });
    throw new Error(`the key file's access could not be limited to ${user ?? 'this user'}, so the new key was deleted: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const hash = key.to_public().hash();
const address = CSL.EnterpriseAddress.new(net === 'mainnet' ? 1 : 0, CSL.Credential.from_keyhash(hash)).to_address().to_bech32(undefined);
console.log(JSON.stringify({ keyHash: hash.to_hex(), address }));
