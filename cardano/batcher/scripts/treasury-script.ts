// The two-key treasury's scripts, rebuilt from its members' key hashes (public) and matched to its
// address, for the batcher's settings ("sweep"):
//   node scripts/treasury-script.ts --address <the treasury's address> --payment <key hash> <key hash> [...]
//        [--stake <key hash> <key hash> [...]] [--batcher <the batcher's key hash>]
// A wallet's script lists its keys in its own order, as "all of" them or "at least n of" them:
// every order and every form is tried, and only one the address is paid to (and, for a base
// address, staked to) is printed, as the "sweep" block's treasury, treasuryScript and
// treasuryStakeScript. The batcher's own checks (src/sweep.ts checkTreasury) are run on it too,
// and run again when the batcher starts, so a wrong script is refused there, never used.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { checkTreasury } from '../src/sweep.ts';

const usage = 'usage: node scripts/treasury-script.ts --address <address> --payment <key hash> <key hash> [...] [--stake <key hash> <key hash> [...]] [--batcher <key hash>]';
const fail = (why: string): never => {
  console.error(why);
  process.exit(1);
};
const args = process.argv.slice(2);
const list = (flag: string): string[] => {
  const at = args.indexOf(flag);
  if (at < 0) return [];
  const end = args.findIndex((a, i) => i > at && a.startsWith('--'));
  return args.slice(at + 1, end < 0 ? args.length : end);
};
const address = list('--address')[0] ?? fail(usage);
const payment = list('--payment');
const stake = list('--stake');
const batcher = list('--batcher')[0];
for (const k of [...payment, ...stake, ...(batcher ? [batcher] : [])]) if (!/^[0-9a-f]{56}$/.test(k)) fail(`${k} is not a key hash (56 hex characters)\n${usage}`);
if (payment.length < 2 || payment.length > 6 || (stake.length && (stake.length < 2 || stake.length > 6))) fail(`two to six keys each\n${usage}`);

const permutations = (xs: string[]): string[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
/** The script, in some order and form, whose hash is `hash`; or null. */
function find(keys: string[], hash: string): string | null {
  for (const order of permutations(keys)) {
    const parts = CSL.NativeScripts.new();
    for (const k of order) parts.add(CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex(k))));
    const forms = [CSL.NativeScript.new_script_all(CSL.ScriptAll.new(parts)), ...Array.from({ length: keys.length - 1 }, (_, i) => CSL.NativeScript.new_script_n_of_k(CSL.ScriptNOfK.new(i + 2, parts)))];
    for (const s of forms) if (s.hash().to_hex() === hash) return s.to_hex();
  }
  return null;
}

let a: CSL.Address;
try {
  a = CSL.Address.from_bech32(address);
} catch {
  fail(`${address} is not an address`);
}
const paidTo = a!.payment_cred()?.to_scripthash()?.to_hex() ?? fail('the address is paid to one key, not a script');
const treasuryScript = find(payment, paidTo) ?? fail('no order or form of the --payment keys is the script the address is paid to: are they the wallet\'s own payment keys?');
const base = CSL.BaseAddress.from_address(a!);
let treasuryStakeScript: string | undefined;
if (base) {
  const stakedTo = base.stake_cred().to_scripthash()?.to_hex() ?? fail("the address's stake part is one key, not a script: not a two-key wallet's address");
  if (!stake.length) fail(`the address has a stake script: give its keys with --stake\n${usage}`);
  treasuryStakeScript = find(stake, stakedTo) ?? fail('no order or form of the --stake keys is the address\'s stake script');
}
try {
  checkTreasury({ address, script: treasuryScript, stakeScript: treasuryStakeScript }, 1, batcher ?? '00'.repeat(28));
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
console.log(JSON.stringify({ treasury: address, treasuryScript, ...(treasuryStakeScript ? { treasuryStakeScript } : {}) }));
if (!batcher) console.error('(not checked against the batcher\'s own key: give --batcher, or the batcher checks it when it starts)');
