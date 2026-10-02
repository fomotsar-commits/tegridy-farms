// @vitest-environment node
//
// The two docs a person builds from, pinned to the code they describe, for the
// reserve-at-create change (owner decision 2026-09-26).
//
// 1. docs/OWN_CURVE_FRONTEND_CONTRACT.md §2.3 is the table a client author copies
//    the `create_launch` account list from. After the change the program takes 11
//    accounts, but the table kept the old 8, so a client written from it would send
//    8 keys and fail. This test reads the account list out of the Rust struct and
//    requires the table to match it, row for row, in order.
//
// 2. solana/tegridy-amm/MAINNET_RUNBOOK.md §0 quotes the deploy float. Its
//    tegridy_launch row kept the superseded escrow build's size ("re-measure") and a
//    ~6.0 SOL total after the new build was measured. This test requires every
//    program row to carry a measured size, rent that follows the runbook's own
//    formula, and a total that is the sum of the rows.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const LIB_RS = 'solana/tegridy-amm/programs/tegridy-launch/src/lib.rs';
const CONTRACT = 'docs/OWN_CURVE_FRONTEND_CONTRACT.md';
const RUNBOOK = 'solana/tegridy-amm/MAINNET_RUNBOOK.md';

/** 1-based line of the first line containing `needle`. */
function lineOf(text: string, needle: string): number {
  const i = text.split('\n').findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`not found: ${needle}`);
  return i + 1;
}

/** The field names of `pub struct <name><'info> { … }`, in declaration order, and its line span. */
function structFields(src: string, name: string): { fields: string[]; start: number; end: number } {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`pub struct ${name}<'info> {`));
  if (start < 0) throw new Error(`struct ${name} not found`);
  const endRel = lines.slice(start).findIndex((l) => l === '}');
  const body = lines.slice(start + 1, start + endRel);
  const fields = body
    .map((l) => /^\s{4}pub (\w+):/.exec(l)?.[1])
    .filter((f): f is string => Boolean(f));
  return { fields, start: start + 1, end: start + endRel + 1 };
}

/** The text of one `### ` section, heading included. */
function section(md: string, headingStart: string): string {
  const at = md.indexOf(headingStart);
  if (at < 0) throw new Error(`section not found: ${headingStart}`);
  const next = md.indexOf('\n### ', at + headingStart.length);
  return md.slice(at, next < 0 ? undefined : next);
}

/** `lib.rs:A-B` → [A, B]. */
function range(s: string): [number, number] {
  const m = /lib\.rs:(\d+)-(\d+)/.exec(s);
  if (!m) throw new Error(`no lib.rs:A-B citation in: ${s}`);
  return [Number(m[1]), Number(m[2])];
}

describe('OWN_CURVE_FRONTEND_CONTRACT §2.3 matches CreateLaunch', () => {
  const src = read(LIB_RS);
  const doc = read(CONTRACT);
  const s23 = section(doc, '### 2.3 `create_launch`');
  const struct = structFields(src, 'CreateLaunch');

  it('the struct still has the 11 accounts this guard was written for', () => {
    // If this fails the program changed; update the table and this number together.
    expect(struct.fields).toEqual([
      'creator',
      'global',
      'mint',
      'curve',
      'curve_vault',
      'token_program',
      'system_program',
      'rent',
      'fee_recipient',
      'treasury_token',
      'associated_token_program',
    ]);
  });

  it('the account table lists every account, in the order the program reads them', () => {
    const rows = [...s23.matchAll(/^\| (\d+) \| `(\w+)` \|/gm)].map((m) => [Number(m[1]), m[2]] as const);
    expect(rows.map(([n]) => n)).toEqual(struct.fields.map((_, i) => i + 1));
    expect(rows.map(([, name]) => name)).toEqual(struct.fields);
  });

  it('says the instruction pays the platform reserve, and that a wrong fee_recipient is refused', () => {
    const flat = s23.replace(/\s+/g, ' ');
    expect(flat).toMatch(/pays the platform reserve/i);
    expect(flat).toMatch(/`Unauthorized` \(wrong mint authority, or a `fee_recipient` other than `global\.fee_recipient`\)/);
  });

  it('cites the lines the handler and the struct are actually on', () => {
    const heading = s23.split('\n')[0];
    const [a, b] = range(heading);
    const fnLine = lineOf(src, 'pub fn create_launch(');
    expect(a).toBeLessThanOrEqual(fnLine);
    expect(b).toBeGreaterThan(fnLine);
    const structCite = /Accounts \(`CreateLaunch`, (lib\.rs:\d+-\d+)\)/.exec(s23)?.[1];
    expect(structCite, 'the struct citation line').toBeTruthy();
    const [c, d] = range(structCite as string);
    expect(c).toBeLessThanOrEqual(struct.start);
    expect(d).toBeGreaterThanOrEqual(struct.end);
  });
});

describe('MAINNET_RUNBOOK deploy float follows its own rent formula', () => {
  const rb = read(RUNBOOK);
  // (bytes + 128) × 5,080: the formula the section states.
  const RATE = 5_080;
  const HEADER = 45; // ProgramData = binary + 45 B header, as the section says.
  const floatAt = rb.indexOf('### DEPLOY FLOAT');
  const table = rb.slice(floatAt, rb.indexOf('**One copy of the rent', floatAt));
  const row = (name: string) => {
    const r = table.split('\n').find((l) => l.startsWith(`| \`${name}\``));
    if (!r) throw new Error(`no ${name} row`);
    return r;
  };
  const num = (s: string) => Number(s.replace(/,/g, ''));
  const sol2 = (lamports: number) => Math.round(lamports / 1e7) / 100;

  it('states the formula this test applies', () => {
    expect(rb).toMatch(/\(bytes \+ 128\) × 5,080 lamports/);
  });

  for (const name of ['raydium_cp_swap', 'tegridy_launch']) {
    it(`${name}: a measured binary, ProgramData = binary + 45 B, and rent from the formula`, () => {
      const r = row(name);
      expect(r).not.toMatch(/re-measure|superseded/i);
      const m = /binary \*\*([\d,]+) B\*\* → ProgramData \*\*([\d,]+) B\*\*/.exec(r);
      expect(m, `${name} row must read "binary **N B** → ProgramData **M B**"`).toBeTruthy();
      const [bin, pd] = [num(m![1]), num(m![2])];
      expect(pd).toBe(bin + HEADER);
      const rent = /\*\*~(\d+\.\d\d) SOL\*\*/.exec(r);
      expect(rent, `${name} row must quote rent as **~X.XX SOL**`).toBeTruthy();
      expect(Number(rent![1])).toBe(sol2((pd + 128) * RATE));
    });
  }

  it('the tegridy_launch row is the reserve-at-create mainnet build (470,728 B)', () => {
    // The a3c41afa… build, reproduced byte-identical twice from tag
    // wip/solana-reserve-at-create. A later rebuild must update this AND the row.
    expect(row('tegridy_launch')).toMatch(/binary \*\*470,728 B\*\*/);
  });

  it('the TOTAL is the sum of the rows, and the two other quotes of it agree', () => {
    const rents = ['raydium_cp_swap', 'tegridy_launch'].map((n) =>
      Number(/\*\*~(\d+\.\d\d) SOL\*\*/.exec(row(n))![1]),
    );
    const fees = Number(/^\| tx fees \| \| ~(\d+\.\d\d) SOL \|/m.exec(table)?.[1]);
    const total = /\*\*TOTAL\*\* \| \*\*~(\d+\.\d\d) SOL\*\*/.exec(table);
    expect(total, 'TOTAL must be quoted as **~X.XX SOL**').toBeTruthy();
    const sum = Math.round((rents[0] + rents[1] + fees) * 100) / 100;
    expect(Number(total![1])).toBe(sum);
    const heading = /### DEPLOY FLOAT — \*\*~(\d+\.\d\d) SOL\*\*/.exec(rb)?.[1];
    expect(Number(heading)).toBe(sum);
    const r1 = /\| R1 \| Confirm float on hand: \*\*~(\d+\.\d\d) SOL deploy rent/.exec(rb)?.[1];
    expect(Number(r1)).toBe(sum);
  });
});

// 3. The superseded escrow build. It was rebuilt and re-rehearsed as a3c41afa…, so any
//    doc that still tells the operator the rehearsed binary "predates" the change sends
//    them back to repeat finished work, or toward the wrong bytes. Every paragraph that
//    names 9b78be02… must call it superseded.
describe('the superseded escrow build (9b78be02…) is never named as current', () => {
  const DOCS = ['docs/TODO_OPERATOR.md', RUNBOOK, 'solana/tegridy-amm/idl/README.md'];
  for (const doc of DOCS) {
    it(`${doc}: every mention calls it superseded`, () => {
      const paragraphs = read(doc).split(/\n\s*\n/);
      const naming = paragraphs.filter((p) => p.includes('9b78be02'));
      for (const p of naming) expect(p, p.slice(0, 200)).toMatch(/superseded/i);
    });
  }

  it('the operator notes name the rehearsed a3c41afa… build and do not ask for a rebuild', () => {
    const todo = read('docs/TODO_OPERATOR.md');
    const p = todo.split(/\n\s*\n/).find((x) => x.includes('platform_reserve_bps = 369'));
    expect(p).toBeTruthy();
    expect(p).toMatch(/a3c41afa/);
    expect(p).not.toMatch(/rebuild and re-rehearse first/);
  });
});
