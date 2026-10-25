// Runs a transaction's scripts with `aiken tx simulate` (Aiken 1.0.24, the compiler our
// contracts are built with), offline: the transaction, plus every output it spends or reads.
// A batch is only ever sent once this has run every script in it to success.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { refKey } from './chain.ts';

export interface ScriptBudget {
  tag: string;
  index: number;
  mem: bigint;
  steps: bigint;
}

export type SimulationResult = { ok: true; budgets: ScriptBudget[] } | { ok: false; error: string };

/**
 * The transaction with every CBOR tag 258 removed (the item it wraps kept). Conway marks sets
 * (inputs, signatures, ...) with tag 258; Aiken 1.0.24's parser predates Conway and wants the
 * plain array. Only the encoding changes: the same items, in the same order. A real CBOR
 * walk, so a byte string that happens to contain d9 01 02 is never touched.
 */
export function withoutSetTags(hex: string): string {
  const b = Buffer.from(hex, 'hex');
  const out: number[] = [];
  let p = 0;
  const arg = (info: number): number | null => {
    if (info < 24) return info;
    const n = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (n === 0) return null; // indefinite
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + b[p + 1 + i]!;
    return v;
  };
  const headLen = (info: number) => (info < 24 || info === 31 ? 1 : 1 + (info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 8));
  const copy = (n: number) => {
    for (let i = 0; i < n; i++) out.push(b[p + i]!);
    p += n;
  };
  const item = (): void => {
    const first = b[p];
    if (first === undefined) throw new Error('truncated CBOR');
    const major = first >> 5;
    const info = first & 31;
    const n = arg(info);
    const h = headLen(info);
    if (major === 0 || major === 1) return copy(h);
    if (major === 2 || major === 3) {
      if (n !== null) return copy(h + n);
      copy(1);
      while (b[p] !== 0xff) item();
      return copy(1);
    }
    if (major === 4 || major === 5) {
      const per = major === 5 ? 2 : 1;
      copy(h);
      if (n !== null) for (let i = 0; i < n * per; i++) item();
      else {
        while (b[p] !== 0xff) item();
        copy(1);
      }
      return;
    }
    if (major === 6) {
      if (n === 258) p += h;
      else copy(h);
      return item();
    }
    return copy(h); // simple values and floats
  };
  item();
  if (p !== b.length) throw new Error('trailing bytes after the transaction');
  return Buffer.from(out).toString('hex');
}

/**
 * The transaction with its redeemers in the array layout ([tag, index, data, ex units] each).
 * Conway allows a map layout, which EMURGO's builder writes and Aiken 1.0.24 cannot read; the
 * same redeemers either way. Only the copy handed to the simulator is changed.
 */
export function withArrayRedeemers(txHex: string): string {
  const tx = CSL.Transaction.from_hex(txHex);
  const ws = tx.witness_set();
  const rs = ws.redeemers();
  if (!rs) return txHex;
  const items: string[] = [];
  for (let i = 0; i < rs.len(); i++) items.push(rs.get(i).to_hex());
  ws.set_redeemers(CSL.Redeemers.from_hex(cborArrayHead(items.length) + items.join('')));
  return CSL.Transaction.new(tx.body(), ws, tx.auxiliary_data()).to_hex();
}

function cborArrayHead(n: number): string {
  if (n < 24) return (0x80 | n).toString(16).padStart(2, '0');
  if (n < 256) return `98${n.toString(16).padStart(2, '0')}`;
  return `99${n.toString(16).padStart(4, '0')}`;
}

/** Every input the transaction spends, reads or pledges as collateral, each once. */
function allInputs(body: CSL.TransactionBody): CSL.TransactionInput[] {
  const seen = new Map<string, CSL.TransactionInput>();
  for (const list of [body.inputs(), body.reference_inputs(), body.collateral()]) {
    for (let i = 0; list && i < list.len(); i++) seen.set(refKey(list.get(i)), list.get(i));
  }
  return [...seen.values()];
}

/**
 * `aiken tx simulate`: evaluates every script in `txHex` against the outputs in `spentHex`
 * (keyed "txhash#index"). `aiken` is the path to Aiken 1.0.24; the slot settings default to
 * mainnet's.
 */
export function simulate(aiken: string, txHex: string, spentHex: Readonly<Record<string, string>>): SimulationResult {
  const body = CSL.FixedTransaction.from_hex(txHex).body();
  const ins = allInputs(body);
  const missing = ins.map(refKey).filter((k) => spentHex[k] === undefined);
  if (missing.length) return { ok: false, error: `outputs unknown for ${missing.join(', ')}` };
  const dir = mkdtempSync(join(tmpdir(), 'batcher-sim-'));
  try {
    writeFileSync(join(dir, 'tx'), withoutSetTags(withArrayRedeemers(txHex)));
    writeFileSync(join(dir, 'inputs'), cborArrayHead(ins.length) + ins.map((i) => i.to_hex()).join(''));
    writeFileSync(join(dir, 'outputs'), cborArrayHead(ins.length) + ins.map((i) => spentHex[refKey(i)]).join(''));
    const r = spawnSync(aiken, ['tx', 'simulate', join(dir, 'tx'), join(dir, 'inputs'), join(dir, 'outputs')], { encoding: 'utf-8' });
    const strip = (s: string | null) => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    const stdout = strip(r.stdout);
    const log = strip(r.stderr);
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status !== 0) return { ok: false, error: `${stdout}${log}`.trim() };
    // stdout: one {mem, cpu} per redeemer, in the order the log names them ("Redeemer Spend → 0").
    let parsed: { mem: number; cpu: number }[];
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { ok: false, error: `unreadable simulator output: ${`${stdout}${log}`.trim().slice(0, 400)}` };
    }
    const named = [...log.matchAll(/Redeemer (\w+) → (\d+)/g)].map((m) => ({ tag: m[1]!, index: Number(m[2]) }));
    if (named.length !== parsed.length) return { ok: false, error: `the simulator ran ${parsed.length} scripts but named ${named.length}` };
    return { ok: true, budgets: parsed.map((b, i) => ({ ...named[i]!, mem: BigInt(b.mem), steps: BigInt(b.cpu) })) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
