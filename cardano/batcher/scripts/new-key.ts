// Makes the batcher's signing key, on the server, into a file only its owner can read
// (src/signer.ts makeKeyFile; the service itself does the same on its first boot with
// BATCHER_MAKE_KEY=1). Prints only the key hash and the address to fund.
//   node scripts/new-key.ts <path> [mainnet|preprod]
import { makeKeyFile } from '../src/signer.ts';

const [path, net = 'mainnet'] = process.argv.slice(2);
if (!path) throw new Error('usage: node scripts/new-key.ts <path> [mainnet|preprod]');
console.log(JSON.stringify(makeKeyFile(path, net === 'mainnet' ? 1 : 0)));
