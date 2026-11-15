// A transaction as the chain holds it (Koios tx_cbor), read with EMURGO's library: its bytes hash
// to its id, then every output: lovelace, one coin's amount, a pool datum if it carries one. The
// rehearsal's proofs (PR #1148): the opening fee to the treasury, a fill against its minimum.
//   KOIOS_URL=... node scripts/read-tx.ts <txid> [--pay <bech32>] [--coin <policy>.<name> --to <bech32> --minimum <n>]
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { decodePoolDatum } from '../src/types.ts';

const id = process.argv[2];
const flag = (f: string) => {
  const at = process.argv.indexOf(f);
  return at < 0 ? undefined : process.argv[at + 1];
};
if (!id || !process.env.KOIOS_URL) throw new Error('usage: KOIOS_URL=... node scripts/read-tx.ts <txid> [--pay <bech32>] [--coin <policy>.<name> --to <bech32> --minimum <n>]');
const [policy, name] = (flag('--coin') ?? '.').split('.') as [string, string];
const r = await fetch(`${process.env.KOIOS_URL}/tx_cbor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _tx_hashes: [id] }) });
const [row] = (await r.json()) as { cbor: string }[];
if (!row) throw new Error(`${id} is not on chain (yet)`);
const tx = CSL.FixedTransaction.from_hex(row.cbor);
const hash = tx.transaction_hash().to_hex();
console.log(`bytes hash to ${hash} ${hash === id ? '(= the id)' : '(NOT the id)'}`);
const outs = tx.body().outputs();
let paid = 0n;
for (let i = 0; i < outs.len(); i++) {
  const o = outs.get(i);
  const a = o.address().to_bech32(undefined);
  const lovelace = BigInt(o.amount().coin().to_str());
  const q = policy ? o.amount().multiasset()?.get_asset(CSL.ScriptHash.from_hex(policy), CSL.AssetName.new(Buffer.from(name, 'hex'))) : undefined;
  const coin = q ? BigInt(q.to_str()) : 0n;
  let line = `#${i} ${lovelace} lovelace${policy ? `, ${coin} of the coin` : ''} -> ${a}`;
  if (a === flag('--pay')) {
    paid += lovelace;
    line += '  <- the payee';
  }
  if (a === flag('--to') && flag('--minimum')) line += `  <- ${coin >= BigInt(flag('--minimum')!) ? 'AT LEAST' : 'BELOW'} the minimum ${flag('--minimum')}`;
  const d = o.plutus_data();
  if (d) {
    try {
      const p = decodePoolDatum(d);
      line += `  pool: reserves ${p.reserveA} / ${p.reserveB}, fee share ${p.feeSharing ?? 'none'}`;
    } catch {
      // not a pool
    }
  }
  console.log(line);
}
if (flag('--pay')) console.log(`paid to ${flag('--pay')} in all: ${paid} lovelace`);
