// The guard in front of EMURGO's library: every real datum and script passes; nesting past the
// limit, in any form, is refused; malformed bytes are refused, never thrown; and it agrees with a
// plain recursive reading on thousands of generated items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { MAX_CBOR_DEPTH, shallowCbor } from '../src/cbor.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/minswap-batches.json', import.meta.url), 'utf8')) as { spent: Record<string, string> };

test('every real Minswap datum and script passes', () => {
  let datums = 0;
  let scripts = 0;
  for (const hex of Object.values(fx.spent)) {
    const o = CSL.TransactionOutput.from_hex(hex);
    const d = o.plutus_data();
    if (d) assert.ok(shallowCbor(d.to_hex()), `datum ${d.to_hex().slice(0, 40)}`), datums++;
    const s = o.script_ref();
    if (s?.is_plutus_script()) assert.ok(shallowCbor(Buffer.from(s.plutus_script()!.bytes()).toString('hex'))), scripts++;
  }
  assert.ok(datums >= 30 && scripts >= 3, `${datums} datums, ${scripts} scripts`);
});

test('nesting past the limit is refused in every form: lists, maps, tags, indefinite lists', () => {
  const at = (open: string, close: string, n: number, inner = '00') => open.repeat(n) + inner + close.repeat(n);
  // Each `open` adds one level (a map nests through its value: key 00, then the next map).
  for (const [open, close, inner] of [['81', '', '00'], ['a100', '', '00'], ['9f', 'ff', '00'], ['c2', '', '40']] as const) {
    assert.equal(shallowCbor(at(open, close, MAX_CBOR_DEPTH, inner)), true, `${open} x${MAX_CBOR_DEPTH}`);
    assert.equal(shallowCbor(at(open, close, MAX_CBOR_DEPTH + 1, inner)), false, `${open} x${MAX_CBOR_DEPTH + 1}`);
  }
  // A Plutus constructor (tag 121 around a list) is two levels.
  assert.equal(shallowCbor(at('d87981', '', MAX_CBOR_DEPTH / 2)), true);
  assert.equal(shallowCbor(at('d87981', '', MAX_CBOR_DEPTH / 2 + 1)), false);
  // The datum that breaks EMURGO's library (about 1,600 deep).
  assert.equal(shallowCbor(`${'81'.repeat(1_600)}00`), false);
});

test('malformed bytes are refused, never thrown: truncated, trailing, an unknown head, a stray break, odd hex', () => {
  for (const hex of ['', '8', '82', '8200', '820000', '820000' + '00', 'ff', '9f', '9f00', '5f41', '1c', '43010203ff', 'zz', '58ff00']) {
    assert.doesNotThrow(() => shallowCbor(hex));
  }
  assert.equal(shallowCbor(''), false);
  assert.equal(shallowCbor('8200'), false, 'a two-item list with one item');
  assert.equal(shallowCbor('820000'), true);
  assert.equal(shallowCbor('82000000'), false, 'a byte after the item');
  assert.equal(shallowCbor('ff'), false);
  assert.equal(shallowCbor('1c'), false, 'a reserved head');
  assert.equal(shallowCbor('58ff00'), false, 'a byte string longer than what follows');
  assert.equal(shallowCbor('5f4101420203ff'), true, 'chunked bytes');
  assert.equal(shallowCbor('5f8100ff'), false, 'a list inside chunked bytes');
});

test('it agrees with a plain recursive reading on thousands of generated items', () => {
  // A seeded generator of CBOR items with a known depth.
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) % n);
  // Mostly chains, which reach the limit; a few branches near the top keep the items small.
  const gen = (depth: number): { hex: string; depth: number } => {
    const r = depth > 72 ? 0 : depth < 50 ? 2 + rnd(4) : rnd(6);
    if (r === 0) return { hex: rnd(2) ? '1a00010000' : '4401020304', depth: 0 };
    if (r === 1) return { hex: '80', depth: 1 };
    const kids = Array.from({ length: depth < 3 ? 1 + rnd(3) : 1 }, () => gen(depth + 1));
    const d = 1 + Math.max(...kids.map((k) => k.depth));
    const body = kids.map((k) => k.hex).join('');
    if (r === 2) return { hex: (0x80 + kids.length).toString(16) + body, depth: d };
    if (r === 3) return { hex: `9f${body}ff`, depth: d };
    if (r === 4) return { hex: `d879${(0x80 + kids.length).toString(16)}${body}`, depth: d + 1 };
    return { hex: `a1${kids[0]!.hex}00`, depth: kids[0]!.depth + 1 };
  };
  let checked = 0;
  for (let i = 0; i < 3_000; i++) {
    const item = gen(0);
    assert.equal(shallowCbor(item.hex), item.depth <= MAX_CBOR_DEPTH, `${item.hex.slice(0, 60)} depth ${item.depth}`);
    checked++;
  }
  assert.equal(checked, 3_000);
});
