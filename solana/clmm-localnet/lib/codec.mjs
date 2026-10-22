// Borsh for the Rust types this program uses, read from type strings as written in the
// source ("u64", "[u64; 16]", "Option<bool>", "Vec<Pubkey>", a struct name). Packed
// zero-copy accounts and borsh accounts both lay fields out back to back with no padding,
// so one reader serves both; `decodeAccount` refuses a size that does not match.
import { PublicKey } from './deps.mjs';

const INTS = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16 };

export function makeCodec(spec, consts) {
  const parse = (t) => {
    t = t.trim().replace(/^Box<(.*)>$/, '$1');
    let m;
    if ((m = /^\[(.+);\s*(\w+)\]$/.exec(t))) {
      const n = /^\d+$/.test(m[2]) ? Number(m[2]) : consts[m[2]];
      if (n === undefined) throw new Error('unknown length ' + m[2]);
      return { kind: 'array', of: m[1], n };
    }
    if ((m = /^Option<(.+)>$/.exec(t))) return { kind: 'option', of: m[1] };
    if ((m = /^Vec<(.+)>$/.exec(t))) return { kind: 'vec', of: m[1] };
    if (INTS[t]) return { kind: 'int', t };
    if (t === 'bool') return { kind: 'bool' };
    if (t === 'Pubkey') return { kind: 'pubkey' };
    const st = spec.structs[t];
    if (st) return { kind: 'struct', name: t, fields: st.fields };
    // A fieldless enum is one byte, its variant's position.
    if (spec.enums[t]) return { kind: 'int', t: 'u8' };
    throw new Error('unknown type ' + t);
  };

  const size = (t) => {
    const p = parse(t);
    switch (p.kind) {
      case 'int': return INTS[p.t];
      case 'bool': return 1;
      case 'pubkey': return 32;
      case 'array': return p.n * size(p.of);
      case 'struct': return p.fields.reduce((s, f) => s + size(f.type), 0);
      default: throw new Error('no fixed size for ' + t);
    }
  };

  const dec = (t, b, o) => {
    const p = parse(t);
    switch (p.kind) {
      case 'int': {
        const n = INTS[p.t];
        const signed = p.t[0] === 'i';
        let v = 0n;
        for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
        if (signed && v >= 1n << BigInt(8 * n - 1)) v -= 1n << BigInt(8 * n);
        return [n <= 4 ? Number(v) : v, o + n];
      }
      case 'bool': return [b[o] !== 0, o + 1];
      case 'pubkey': return [new PublicKey(b.subarray(o, o + 32)), o + 32];
      case 'array': {
        if (p.of === 'u8') return [Buffer.from(b.subarray(o, o + p.n)), o + p.n];
        const out = [];
        for (let i = 0; i < p.n; i++) { let v; [v, o] = dec(p.of, b, o); out.push(v); }
        return [out, o];
      }
      case 'option': return b[o] === 0 ? [null, o + 1] : dec(p.of, b, o + 1);
      case 'vec': {
        const n = b.readUInt32LE(o); o += 4;
        const out = [];
        for (let i = 0; i < n; i++) { let v; [v, o] = dec(p.of, b, o); out.push(v); }
        return [out, o];
      }
      case 'struct': {
        const out = {};
        for (const f of p.fields) [out[f.name], o] = dec(f.type, b, o);
        return [out, o];
      }
    }
  };

  const enc = (t, v) => {
    const p = parse(t);
    switch (p.kind) {
      case 'int': {
        const n = INTS[p.t];
        let x = BigInt(v);
        if (x < 0n) x += 1n << BigInt(8 * n);
        const out = Buffer.alloc(n);
        for (let i = 0; i < n; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
        if (x !== 0n) throw new Error(`${v} does not fit ${p.t}`);
        return out;
      }
      case 'bool': return Buffer.from([v ? 1 : 0]);
      case 'pubkey': return new PublicKey(v).toBuffer();
      case 'array': return Buffer.concat(v.map((x) => enc(p.of, x)));
      case 'option': return v === null || v === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), enc(p.of, v)]);
      case 'vec': {
        const len = Buffer.alloc(4); len.writeUInt32LE(v.length);
        return Buffer.concat([len, ...v.map((x) => enc(p.of, x))]);
      }
      case 'struct': return Buffer.concat(p.fields.map((f) => {
        if (!(f.name in v)) throw new Error(`${p.name}.${f.name} missing`);
        return enc(f.type, v[f.name]);
      }));
    }
  };

  /** An account's fields, after checking its 8-byte discriminator and its exact length. */
  const decodeAccount = (name, data) => {
    const want = spec.accountDisc(name);
    if (!data.subarray(0, 8).equals(want)) throw new Error(`not a ${name} account`);
    const [v, end] = dec(name, data, 8);
    if (end !== data.length) throw new Error(`${name}: decoded ${end} bytes of ${data.length}`);
    return v;
  };

  return { size, dec, enc, decodeAccount };
}

/** `pub const NAME: usize = 60;` (and i32/u16) across the source, for array lengths. */
export function readConsts(srcTexts) {
  const out = {};
  for (const s of srcTexts) {
    for (const m of s.matchAll(/(?:pub )?const (\w+)\s*:\s*(?:usize|u8|u16|u32|i32)\s*=\s*(\d+)\s*;/g)) out[m[1]] = Number(m[2]);
  }
  return out;
}
