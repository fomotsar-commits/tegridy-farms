// The two-key treasury's payment script, rebuilt from its members' payment key hashes (public),
// for the batcher's settings (sweep.treasuryScript), and checked against the treasury's address:
//   node scripts/treasury-script.ts all <key hash> <key hash> [...] --address <treasury address>
//   node scripts/treasury-script.ts 2 <key hash> <key hash> [...] --address <treasury address>
// "all": every key must sign; a number n: at least n of them. It prints the script (hex) and its
// hash, and whether the address is paid to it. The batcher checks the same again when it starts
// (src/sweep.ts checkTreasury), so a wrong script is refused there, never used.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { checkTreasury } from '../src/sweep.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--address');
const address = at >= 0 ? args[at + 1] : undefined;
const [kind, ...keys] = at >= 0 ? args.slice(0, at) : args;
if (!kind || keys.length < 2 || !keys.every((k) => /^[0-9a-f]{56}$/.test(k)) || !(kind === 'all' || /^[1-9]\d*$/.test(kind))) {
  console.error('usage: node scripts/treasury-script.ts <all|n> <key hash> <key hash> [...] --address <treasury address>');
  process.exit(1);
}
const parts = CSL.NativeScripts.new();
for (const k of keys) parts.add(CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex(k))));
const script = kind === 'all' ? CSL.NativeScript.new_script_all(CSL.ScriptAll.new(parts)) : CSL.NativeScript.new_script_n_of_k(CSL.ScriptNOfK.new(Number(kind), parts));
console.log(JSON.stringify({ treasuryScript: script.to_hex(), scriptHash: script.hash().to_hex() }));
if (address) {
  try {
    checkTreasury({ address, script: script.to_hex() }, 1);
    console.log(`${address} is paid to this script: put both in BATCHER_SETTINGS' sweep`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
