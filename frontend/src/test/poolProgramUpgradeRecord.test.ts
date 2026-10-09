// @vitest-environment node
//
// THE POOL PROGRAM'S UPGRADE, ON RECORD.
//
// The release that moved the site's wording and the harness pins to the upgraded pool program
// was written BEFORE the upgrade executed, so that it could ship in the same hour. Four facts
// did not exist yet: the day of the execute, its slot, its transaction, and the size the
// program's data account ended at. Nobody may make those up. So each was left as one marker
// word in one table (MAINNET_RUNBOOK.md, section 4b, "The upgrade as it executed"), and the
// changelog line for the release was parked behind the same word until it could be filed
// under the day it reached trunk.
//
// This test is what kept that release from merging early: it fails while the marker is
// anywhere in the tree, and while any of the four cells does not look like the thing it
// names. After the day it stays as the guard on that record.
//
// To try values without touching a checkout, point POOL_UPGRADE_RECORD_ROOT at a scratch
// clone of the repository and run this file from here. CI never sets it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.POOL_UPGRADE_RECORD_ROOT ? resolve(process.env.POOL_UPGRADE_RECORD_ROOT) : join(HERE, '..', '..', '..');

/** Built from its parts, so this file never holds the word it searches the tree for. */
const MARKER = ['UNFILLED', 'UNTIL', 'THE', 'UPGRADE', 'EXECUTES'].join('-');

/** The paragraph that opens the record, and the label each of its four rows starts with. */
const RECORD_OPENS = '**The upgrade as it executed.**';
const ROWS = {
  day: 'Day of the execute',
  slot: 'Slot of the execute',
  signature: 'Transaction of the execute',
  dataAccountBytes: "Size of the program's data account afterwards",
} as const;
type Fact = keyof typeof ROWS;
type UpgradeRecord = Partial<Record<Fact, string>>;

/** The four cells of the record, as written. A row that is not there is left out. */
function readRecord(runbook: string): UpgradeRecord {
  // A checkout on Windows may hold CRLF line ends, and `$` does not match before a CR.
  const text = runbook.replace(/\r\n/g, '\n');
  const at = text.indexOf(RECORD_OPENS);
  if (at < 0) return {};
  const rows = [...text.slice(at).split(/\n## |\n### /)[0]!.matchAll(/^\| ([^|\n]+?) \| `([^`\n]*)` \|$/gm)];
  const out: UpgradeRecord = {};
  for (const fact of Object.keys(ROWS) as Fact[]) {
    const row = rows.find((m) => m[1]!.startsWith(ROWS[fact]));
    if (row) out[fact] = row[2]!;
  }
  return out;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** How many bytes a base58 string decodes to, or null when a character is not base58. */
function base58ByteLength(text: string): number | null {
  if (text.length === 0) return null;
  let value = 0n;
  for (const ch of text) {
    const digit = BASE58.indexOf(ch);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const leadingZeroBytes = /^1*/.exec(text)![0].length;
  let valueBytes = 0;
  for (let v = value; v > 0n; v >>= 8n) valueBytes += 1;
  return leadingZeroBytes + valueBytes;
}
function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const b of bytes) value = value * 256n + BigInt(b);
  let out = '';
  for (; value > 0n; value /= 58n) out = BASE58[Number(value % 58n)] + out;
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const wholeNumber = (text: string): number | null =>
  /^\d{1,3}(,\d{3})+$|^\d+$/.test(text) ? Number(text.replace(/,/g, '')) : null;

/** The program's "last deployed" slot before the upgrade (the 2026-09-29 deploy). */
const SLOT_OF_THE_FIRST_DEPLOY = 451_687_458;
/** The day the runbook last read mainnet with nothing sent (07:42 UTC). */
const NOT_BEFORE = '2026-10-08';
/**
 * A slot and a time read together on mainnet (frontend/scripts/addresses.json, the two
 * venue pools: "finalized slot 454,077,498 (2026-10-07T01:38Z)"). Mainnet made about 3.7
 * slots a second that week. A day and a slot that disagree by more than this band were not
 * read from the same transaction.
 */
const ANCHOR = { slot: 454_077_498, atMs: Date.UTC(2026, 9, 7, 1, 38) };
const SLOTS_PER_SECOND = { slowest: 1.5, fastest: 6 };
/** The new program, 724,688 bytes, behind the loader's 45-byte header. */
const SMALLEST_DATA_ACCOUNT = 724_733;
const LARGEST_DATA_ACCOUNT = 10 * 1024 * 1024 + 45;

/** What is wrong with the record. An empty list means every cell has the shape of its fact. */
function recordProblems(rec: UpgradeRecord, now: Date): string[] {
  const out: string[] = [];
  const filled = (fact: Fact): string | null => {
    const v = rec[fact];
    if (v === undefined) out.push(`the record has no row "${ROWS[fact]}"`);
    else if (v.includes(MARKER) || v.trim() === '') out.push(`"${ROWS[fact]}" is not filled in yet`);
    else return v;
    return null;
  };

  const day = filled('day');
  let dayMs: number | null = null;
  if (day !== null) {
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) out.push(`"${ROWS.day}" is "${day}", not a date written YYYY-MM-DD`);
    else if (day < NOT_BEFORE) out.push(`"${ROWS.day}" is ${day}: nothing had been sent on ${NOT_BEFORE}`);
    else if (day > now.toISOString().slice(0, 10)) out.push(`"${ROWS.day}" is ${day}, which has not come yet`);
    else dayMs = ms;
  }

  const slotText = filled('slot');
  if (slotText !== null) {
    const slot = wholeNumber(slotText);
    if (slot === null) out.push(`"${ROWS.slot}" is "${slotText}", not a whole number`);
    else if (slot <= SLOT_OF_THE_FIRST_DEPLOY) out.push(`"${ROWS.slot}" is ${slot}, not after the first deploy's slot ${SLOT_OF_THE_FIRST_DEPLOY}`);
    else if (dayMs !== null) {
      const earliest = ANCHOR.slot + ((dayMs - ANCHOR.atMs) / 1000) * SLOTS_PER_SECOND.slowest;
      const latest = ANCHOR.slot + ((dayMs + 86_400_000 - ANCHOR.atMs) / 1000) * SLOTS_PER_SECOND.fastest;
      if (slot < earliest || slot > latest) {
        out.push(`slot ${slot} does not fall on ${day}: that day's slots lie between about ${Math.floor(earliest)} and ${Math.ceil(latest)}`);
      }
    }
  }

  const signature = filled('signature');
  if (signature !== null && base58ByteLength(signature) !== 64) {
    out.push(`"${ROWS.signature}" is not a transaction signature: it must be base58 for exactly 64 bytes`);
  }

  const bytesText = filled('dataAccountBytes');
  if (bytesText !== null) {
    const bytes = wholeNumber(bytesText);
    if (bytes === null) out.push(`"${ROWS.dataAccountBytes}" is "${bytesText}", not a whole number`);
    else if (bytes < SMALLEST_DATA_ACCOUNT) out.push(`"${ROWS.dataAccountBytes}" is ${bytes}: the new program does not fit in less than ${SMALLEST_DATA_ACCOUNT} bytes`);
    else if (bytes > LARGEST_DATA_ACCOUNT) out.push(`"${ROWS.dataAccountBytes}" is ${bytes}: no program account is that large`);
  }
  return out;
}

/** Every tracked line that still holds the marker, as `path:line: text`. Throws if the tree cannot be searched. */
function markerPlaces(root: string): string[] {
  try {
    const found = execFileSync('git', ['-c', 'core.quotepath=off', 'grep', '-n', '-I', '-F', '-e', MARKER], {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return found.split('\n').filter(Boolean).map((l) => {
      const m = /^([^:]+):(\d+):(.*)$/.exec(l);
      return m ? `${m[1]}:${m[2]}: ${m[3]!.trim().slice(0, 90)}` : l;
    });
  } catch (e) {
    // `git grep` exits 1 when nothing matches. Anything else means the search did not run.
    if ((e as { status?: number }).status === 1) return [];
    throw new Error(`could not search ${root} for the unfinished marker: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

describe('the pool program upgrade is on record', () => {
  it('all four facts are filled in from the chain, and no unfinished marker is left anywhere in the tree', () => {
    const left = markerPlaces(ROOT).map((place) => `still holds the marker ${MARKER}: ${place}`);
    const record = recordProblems(readRecord(readFileSync(join(ROOT, 'solana', 'tegridy-amm', 'MAINNET_RUNBOOK.md'), 'utf-8')), new Date());
    expect([...left, ...record], 'fill these from mainnet after the upgrade executes (the pull request lists how)').toEqual([]);
  });

  // The checker above, on records made up for the purpose. Without these it would only ever
  // have been seen failing on the marker, never refusing a wrong value.
  const signature = base58Encode(createHash('sha512').update('a made-up signature for this test').digest());
  const good: UpgradeRecord = { day: '2026-10-09', slot: '454,790,112', signature, dataAccountBytes: '724,733' };
  const today = new Date('2026-10-10T12:00:00Z');
  const table = (rec: UpgradeRecord) =>
    `intro\n\n${RECORD_OPENS} Read from mainnet.\n\n| | |\n|---|---|\n${(Object.keys(ROWS) as Fact[])
      .filter((f) => rec[f] !== undefined)
      .map((f) => `| ${ROWS[f]} (and a note) | \`${rec[f]}\` |`)
      .join('\n')}\n\nAfter the table.\n\n### A. Next part\n\n| Day of the execute | \`not this one\` |\n`;

  it('reads the four cells out of the runbook table, and nothing after the next heading', () => {
    expect(readRecord(table(good))).toEqual(good);
    expect(readRecord('no record here')).toEqual({});
    expect(readRecord(table({ day: '2026-10-09' }))).toEqual({ day: '2026-10-09' });
  });

  it('accepts a well-formed record', () => {
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
    expect(recordProblems(good, today)).toEqual([]);
    expect(recordProblems({ ...good, slot: '454790112', dataAccountBytes: '734973' }, today)).toEqual([]);
  });

  it('refuses a cell that is unfilled, missing, or not the shape of its fact', () => {
    const one = (rec: UpgradeRecord) => recordProblems(rec, today);
    expect(one({ ...good, day: MARKER })).toEqual([`"${ROWS.day}" is not filled in yet`]);
    expect(one({ ...good, signature: `${MARKER} ` })).toEqual([`"${ROWS.signature}" is not filled in yet`]);
    expect(one({ day: good.day, slot: good.slot, signature })).toEqual([`the record has no row "${ROWS.dataAccountBytes}"`]);
    expect(one({})).toHaveLength(4);
    // The day: a real date, not before the last read with nothing sent, not in the future.
    expect(one({ ...good, day: '10/09/2026' })[0]).toContain('not a date written YYYY-MM-DD');
    expect(one({ ...good, day: '2026-02-30' })[0]).toContain('not a date written YYYY-MM-DD');
    expect(one({ ...good, day: '2026-10-07' })[0]).toContain('nothing had been sent');
    expect(one({ ...good, day: '2026-10-11' })[0]).toContain('has not come yet');
    // The slot: a whole number, after the first deploy, and one that falls on the day.
    expect(one({ ...good, slot: 'soon' })[0]).toContain('not a whole number');
    expect(one({ ...good, slot: '451,687,458' })[0]).toContain('not after the first deploy');
    expect(one({ ...good, slot: '454,123,843' })[0]).toContain('does not fall on 2026-10-09');
    expect(one({ ...good, slot: '474,790,112' })[0]).toContain('does not fall on 2026-10-09');
    // The transaction: base58 for 64 bytes. An address (32 bytes) and a hex hash are not.
    expect(one({ ...good, signature: 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT' })[0]).toContain('not a transaction signature');
    expect(one({ ...good, signature: '99a9e73dc469755b178d8029196be0ee8f92e557bbd65e15e4511084b6a0fe25' })[0]).toContain('not a transaction signature');
    expect(one({ ...good, signature: signature.slice(0, -1) + '0' })[0]).toContain('not a transaction signature');
    // The data account: at least the new program and its header.
    expect(one({ ...good, dataAccountBytes: '691,685' })[0]).toContain('does not fit');
    expect(one({ ...good, dataAccountBytes: '724,688' })[0]).toContain('does not fit');
    expect(one({ ...good, dataAccountBytes: 'about 725 KB' })[0]).toContain('not a whole number');
  });
});
