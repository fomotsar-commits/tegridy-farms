// The ledger's minimum fee for a batch (Conway), from the ledger's own formulas, not EMURGO's
// estimate. EMURGO only counts the reference scripts it is told about; the ledger counts every
// one sitting on a spent or reference input, and anyone can put one on a pool or send one to
// the batcher. Computed on the transaction as it will be signed:
//   txFeePerByte x size + txFeeFixed
//   + the scripts' price: one ceiling over every redeemer's memory and steps at the set prices
//   + the reference scripts' price: their total size, each 25,600 bytes at 1.2 times the price
//     of the 25,600 before it, one floor at the end (the ledger's tierRefScriptFee)
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { refKey } from './chain.ts';
import { DecodeError } from './plutus.ts';
import type { ProtocolParams } from './build.ts';

export interface Rational {
  n: bigint;
  d: bigint;
}

/**
 * A price or rate from the protocol parameters, exactly: a JSON number as printed (0.0577,
 * 7.2e-7) or an "n/d" string (as Ogmios gives them). The chain publishes rationals.
 */
export function rational(x: number | string): Rational {
  const s = String(x).trim();
  const fraction = /^(\d+)\/(\d+)$/.exec(s);
  if (fraction) {
    const d = BigInt(fraction[2]!);
    if (d === 0n) throw new DecodeError(`a rate over zero: ${s}`);
    return { n: BigInt(fraction[1]!), d };
  }
  const m = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!m) throw new DecodeError(`not a protocol rate: ${s}`);
  const decimals = m[2] ?? '';
  const exp = Number(m[3] ?? '0') - decimals.length;
  const n = BigInt(m[1]! + decimals);
  return exp >= 0 ? { n: n * 10n ** BigInt(exp), d: 1n } : { n, d: 10n ** BigInt(-exp) };
}

/** The size the ledger charges for the reference script on this output: 0 if it has none. */
export function refScriptSize(outputHex: string): number {
  const sr = CSL.TransactionOutput.from_hex(outputHex).script_ref();
  if (!sr) return 0;
  return sr.is_plutus_script() ? sr.plutus_script()!.bytes().length : sr.native_script()!.to_bytes().length;
}

/** The ledger's tierRefScriptFee (multiplier 1.2, tiers of 25,600 bytes). */
export function refScriptFee(size: number, perByte: Rational): bigint {
  const TIER = 25_600n;
  let accN = 0n;
  let accD = 1n;
  const add = (n: bigint, d: bigint) => {
    accN = accN * d + n * accD;
    accD *= d;
  };
  let price = perByte;
  let rest = BigInt(size);
  while (rest >= TIER) {
    add(TIER * price.n, price.d);
    price = { n: price.n * 6n, d: price.d * 5n };
    rest -= TIER;
  }
  add(rest * price.n, price.d);
  return accN / accD;
}

/** The scripts' price: one ceiling over all of a transaction's memory and steps (the ledger's txscriptfee). */
export function scriptFee(mem: bigint, steps: bigint, pp: Pick<ProtocolParams, 'executionUnitPrices'>): bigint {
  const pm = rational(pp.executionUnitPrices.priceMemory);
  const ps = rational(pp.executionUnitPrices.priceSteps);
  const n = mem * pm.n * ps.d + steps * ps.n * pm.d;
  const d = pm.d * ps.d;
  return (n + d - 1n) / d;
}

const inputsOf = (l: CSL.TransactionInputs | undefined) => Array.from({ length: l?.len() ?? 0 }, (_, i) => l!.get(i));

/**
 * The minimum fee for `txHex`, signed by every key it needs that has not signed yet: the
 * payment keys of its spent and collateral inputs and its required signers (a batch makes no
 * key withdrawals and carries no certificates or native scripts). `spent` holds every output
 * the transaction spends, reads or pledges, keyed "txhash#index".
 */
export function ledgerMinFee(txHex: string, spent: Readonly<Record<string, string>>, pp: ProtocolParams): bigint {
  const tx = CSL.FixedTransaction.from_hex(txHex);
  const body = tx.body();
  const outputHex = (i: CSL.TransactionInput) => {
    const hex = spent[refKey(i)];
    if (hex === undefined) throw new DecodeError(`the output ${refKey(i)} is unknown`);
    return hex;
  };
  const inputs = inputsOf(body.inputs());
  const references = inputsOf(body.reference_inputs());

  const keys = new Set<string>();
  for (const i of [...inputs, ...inputsOf(body.collateral())]) {
    const cred = CSL.TransactionOutput.from_hex(outputHex(i)).address().payment_cred();
    if (!cred) throw new DecodeError(`${refKey(i)} sits at a Byron address`);
    const key = cred.to_keyhash();
    if (key) keys.add(key.to_hex());
  }
  const signers = body.required_signers();
  for (let i = 0; signers && i < signers.len(); i++) keys.add(signers.get(i).to_hex());
  const signed = tx.witness_set().vkeys();
  for (let i = 0; signed && i < signed.len(); i++) keys.delete(signed.get(i).vkey().public_key().hash().to_hex());
  // A real signature of the real size for each key still to sign.
  for (let i = 0; i < keys.size; i++) tx.sign_and_add_vkey_signature(CSL.PrivateKey.generate_ed25519());
  const size = BigInt(tx.to_bytes().length);

  let mem = 0n;
  let steps = 0n;
  const rs = tx.witness_set().redeemers();
  for (let i = 0; rs && i < rs.len(); i++) {
    mem += BigInt(rs.get(i).ex_units().mem().to_str());
    steps += BigInt(rs.get(i).ex_units().steps().to_str());
  }

  // Every spent or reference input once (the ledger takes the union), each script it carries.
  const read = new Map([...inputs, ...references].map((i) => [refKey(i), i]));
  const refBytes = [...read.values()].reduce((s, i) => s + refScriptSize(outputHex(i)), 0);

  return BigInt(pp.txFeePerByte) * size + BigInt(pp.txFeeFixed) + scriptFee(mem, steps, pp) + refScriptFee(refBytes, rational(pp.minFeeRefScriptCostPerByte));
}
