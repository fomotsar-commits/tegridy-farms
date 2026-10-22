// Reads solana/tegridy-clmm's own Rust source and returns what a client needs: each
// instruction's accounts (in order, with signer and writable flags) and arguments, every
// struct's fields, and the error codes. Nothing is typed in by hand, so the harness cannot
// drift from the program it tests. Anchor's default encoding: sha256("global:<name>")[..8].
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const sha8 = (s) => createHash('sha256').update(s).digest().subarray(0, 8);

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.rs') ? [p] : [];
  });
}

/** Source with line comments and doc comments removed; block comments too. */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//');
      return i >= 0 && !/"[^"]*\/\/[^"]*"/.test(l) ? l.slice(0, i) : l;
    })
    .join('\n');
}

/** The text between the bracket at `open` and its match. */
function matched(s, open, a = '{', b = '}') {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === a) depth++;
    else if (s[i] === b && --depth === 0) return s.slice(open + 1, i);
  }
  throw new Error('unbalanced at ' + open);
}

/** Split on commas at depth 0 of (), <>, [], {}. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('(<[{'.includes(ch)) depth++;
    if (')>]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Struct bodies keyed by name, with the attributes written just above each. */
function structs(src) {
  const out = {};
  // An attribute is #[...] holding single non-bracket characters or one level of [...]: no two
  // repeats can match the same text, so the scan stays linear.
  const re = /((?:#\[(?:[^[\]]|\[[^[\]]*\])*\]\s*)*)pub struct (\w+)(?:<[^>{]*>)?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const body = matched(src, m.index + m[0].length - 1);
    out[m[2]] = { attrs: m[1], body };
  }
  return out;
}

/** Fields of a struct body: [{ name, type, attrs }] in order. */
function fields(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s|,/.test(body[i])) i++;
    let attrs = '';
    while (body.startsWith('#[', i)) {
      const inner = matched(body, i + 1, '[', ']');
      attrs += inner + '\n';
      i += inner.length + 3;
      while (i < body.length && /\s/.test(body[i])) i++;
    }
    const rest = body.slice(i);
    const m = /^(?:pub(?:\([^)]*\))?\s+)?(\w+)\s*:\s*/.exec(rest);
    if (!m) {
      if (rest.trim()) throw new Error('cannot read field at: ' + rest.slice(0, 80));
      break;
    }
    i += m[0].length;
    let depth = 0;
    let type = '';
    for (; i < body.length; i++) {
      const ch = body[i];
      if ('(<['.includes(ch)) depth++;
      if (')>]'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) break;
      type += ch;
    }
    out.push({ name: m[1], type: type.trim().replace(/\s+/g, ' '), attrs });
  }
  return out;
}

export function loadSpec(programSrcDir) {
  const all = files(programSrcDir).map((p) => ({ p, src: strip(readFileSync(p, 'utf-8')) }));
  const byName = {};
  for (const { p, src } of all) {
    for (const [name, s] of Object.entries(structs(src))) {
      if (byName[name]) throw new Error(`struct ${name} defined twice (${p})`);
      byName[name] = { ...s, file: p, fields: fields(s.body) };
    }
  }

  // #[program] functions: name, the Accounts struct, and the arguments after ctx.
  const lib = all.find((f) => f.p.endsWith('lib.rs')).src;
  const prog = matched(lib, lib.indexOf('{', lib.indexOf('pub mod raydium_clmm')));
  const instructions = {};
  const fnRe = /pub fn (\w+)(?:<[^>]*>)?\s*\(/g;
  let m;
  while ((m = fnRe.exec(prog))) {
    const params = splitTop(matched(prog, m.index + m[0].length - 1, '(', ')'));
    const ctx = /Context<\s*(?:'info\s*,\s*)?(\w+)/.exec(params[0]);
    if (!ctx) throw new Error('no Context in ' + m[1]);
    const st = byName[ctx[1]];
    if (!st || !/derive\([^)]*Accounts/.test(st.attrs)) throw new Error('no Accounts struct ' + ctx[1]);
    const accounts = st.fields.map((f) => {
      const a = f.attrs.replace(/^account\(|\)\s*$/g, '');
      if (/^Option</.test(f.type)) throw new Error(`${ctx[1]}.${f.name}: optional account not handled`);
      return {
        name: f.name,
        signer: /^(Box<)?Signer</.test(f.type),
        writable: /\b(mut|init|init_if_needed|zero)\b/.test(a),
        type: f.type,
      };
    });
    const args = params.slice(1).map((p) => {
      const [n, ...t] = p.split(':');
      return { name: n.trim(), type: t.join(':').trim() };
    });
    instructions[m[1]] = { name: m[1], disc: sha8('global:' + m[1]), accounts, args, accountsStruct: ctx[1] };
  }

  // Error codes: Anchor numbers a #[error_code] enum from 6000 in declaration order.
  const errSrc = all.find((f) => f.p.endsWith('error.rs')).src;
  const en = matched(errSrc, errSrc.indexOf('{', errSrc.indexOf('pub enum ErrorCode')));
  const errors = {};
  let code = 6000;
  for (const v of splitTop(en.replace(/#\[msg\(\s*"(?:[^"\\]|\\.)*"\s*\)\]/g, ''))) {
    const name = /^(\w+)/.exec(v.trim())[1];
    errors[code++] = name;
  }

  // Fieldless enums only (variant names in order); one with data stays unknown, so its use fails loudly.
  const enums = {};
  for (const { src } of all) {
    for (const e of src.matchAll(/pub enum (\w+)\s*\{/g)) {
      const vs = splitTop(matched(src, e.index + e[0].length - 1).replace(/#\[[^\]]*\]/g, ''));
      if (vs.every((v) => /^\w+$/.test(v))) enums[e[1]] = vs;
    }
  }

  return {
    structs: byName, enums, instructions, errors, sources: all.map((f) => f.src),
    accountDisc: (n) => sha8('account:' + n), eventDisc: (n) => sha8('event:' + n),
  };
}
