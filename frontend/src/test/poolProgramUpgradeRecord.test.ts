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
// This test fails while the marker is anywhere in the tree, and while any of the four cells
// does not look like the thing it names. After the day it stays as the guard on that record.
//
// WHAT IT IS NOT. It is not the lock on that release. It checks SHAPE: a date, a slot that
// falls on that date, 64 bytes of base58, a size. It cannot tell a made-up signature from a
// real one, and a reviewer turned it green with five typed values while mainnet still ran
// the old program (2026-10-09). The check that mainnet itself has to satisfy is the address
// registry's chain read: `scripts/verify-addresses.mjs --onchain` hashes the program on
// mainnet against the build on the registry's row, and src/test/poolProgramCopy.test.ts
// ties the site's wording and the harness pins to that row. The values for the four cells
// come from `scripts/solana-localnet/read-upgrade-record.mjs`, which prints them only when
// mainnet holds the new build. Never from memory.
//
// To try values without touching a checkout, point POOL_UPGRADE_RECORD_ROOT at a scratch
// clone of the repository and run this file from here. CI never sets it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.POOL_UPGRADE_RECORD_ROOT ? resolve(process.env.POOL_UPGRADE_RECORD_ROOT) : join(HERE, '..', '..', '..');

/** Built from its parts, so this file never holds the word it searches the tree for. */
const MARKER = ['UNFILLED', 'UNTIL', 'THE', 'UPGRADE', 'EXECUTES'].join('-');
/**
 * How the editor's note beside the parked changelog line begins. The marker word can be
 * deleted and the note left standing, and it would then ship in the changelog. Built from
 * its parts for the same reason as the marker.
 */
const EDITORS_NOTE = ['(move this line', 'under the heading'].join(' ');

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

/**
 * The last finalized slot at which mainnet was read still running the OLD build, and its
 * day: 2026-10-09, 04:07 UTC, by `scripts/solana-localnet/read-upgrade-record.mjs` (the
 * program was `88b98aa9…`, in a 691,685-byte account last deployed in slot 451,687,458).
 * The upgrade cannot have executed at or before that slot, or before that day. The floors
 * used to be the first deploy's slot and 2026-10-08, which let a slot from before any
 * upgrade through.
 */
const LAST_SLOT_SEEN_WITH_THE_OLD_BUILD = 454_754_407;
const NOT_BEFORE = '2026-10-09';
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
    else if (day < NOT_BEFORE) out.push(`"${ROWS.day}" is ${day}: mainnet still ran the old build on ${NOT_BEFORE}`);
    else if (day > now.toISOString().slice(0, 10)) out.push(`"${ROWS.day}" is ${day}, which has not come yet`);
    else dayMs = ms;
  }

  const slotText = filled('slot');
  if (slotText !== null) {
    const slot = wholeNumber(slotText);
    if (slot === null) out.push(`"${ROWS.slot}" is "${slotText}", not a whole number`);
    else if (slot <= LAST_SLOT_SEEN_WITH_THE_OLD_BUILD) out.push(`"${ROWS.slot}" is ${slot}, not after slot ${LAST_SLOT_SEEN_WITH_THE_OLD_BUILD}, where mainnet was last read still running the old build`);
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

/** Every tracked line that still holds `needle`, as `path:line: text`. Throws if the tree cannot be searched. */
function placesHolding(root: string, needle: string): string[] {
  try {
    const found = execFileSync('git', ['-c', 'core.quotepath=off', 'grep', '-n', '-I', '-F', '-e', needle], {
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
    throw new Error(`could not search ${root} for "${needle}": ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** What is still unfinished in the tree: the marker word, and the editor's note that sat beside it. */
function leftInTheTree(root: string): string[] {
  return [
    ...placesHolding(root, MARKER).map((place) => `still holds the marker ${MARKER}: ${place}`),
    ...placesHolding(root, EDITORS_NOTE).map((place) => `still holds the editor's note "${EDITORS_NOTE} ...": ${place}`),
  ];
}

describe('the pool program upgrade is on record', () => {
  it('all four facts are filled in from the chain, and no unfinished marker is left anywhere in the tree', () => {
    const left = leftInTheTree(ROOT);
    const record = recordProblems(readRecord(readFileSync(join(ROOT, 'solana', 'tegridy-amm', 'MAINNET_RUNBOOK.md'), 'utf-8')), new Date());
    expect(
      [...left, ...record],
      'fill these from mainnet after the upgrade executes: `node frontend/scripts/solana-localnet/read-upgrade-record.mjs` prints the four rows, and only when mainnet holds the new build',
    ).toEqual([]);
  });

  // The tree search, on a tree made for the purpose. Once the marker is gone from the real
  // tree the test above no longer shows that the search can find anything. This does, on
  // every run: the marker word, the editor's note with the word deleted and the bracket left
  // standing, and a clean tree. Only tracked files are searched, as in the real tree.
  it('finds the marker word, and the editor’s note left behind without it, in a tree that holds them', () => {
    const tree = mkdtempSync(join(tmpdir(), 'pool-upgrade-record-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      git('init', '-q');
      writeFileSync(join(tree, 'RUNBOOK.md'), `| Day of the execute (UTC) | \`${MARKER}\` |\n`);
      writeFileSync(join(tree, 'CHANGELOG.md'), `# Changelog\n\n- ${EDITORS_NOTE} of the day it reaches trunk) Solana pools: the pool program was upgraded.\n`);
      writeFileSync(join(tree, 'untracked.md'), `${MARKER}\n`);
      git('add', 'RUNBOOK.md', 'CHANGELOG.md');
      const left = leftInTheTree(tree);
      expect(left).toHaveLength(2);
      expect(left[0]).toContain(`still holds the marker ${MARKER}: RUNBOOK.md:1:`);
      expect(left[1]).toContain(`still holds the editor's note "${EDITORS_NOTE} ...": CHANGELOG.md:3:`);

      writeFileSync(join(tree, 'RUNBOOK.md'), '| Day of the execute (UTC) | `2026-10-09` |\n');
      writeFileSync(join(tree, 'CHANGELOG.md'), '# Changelog\n\n- Solana pools: the pool program was upgraded.\n');
      expect(leftInTheTree(tree)).toEqual([]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
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
    // The day: a real date, not before the last day the old build was read, not in the future.
    expect(one({ ...good, day: '10/09/2026' })[0]).toContain('not a date written YYYY-MM-DD');
    expect(one({ ...good, day: '2026-02-30' })[0]).toContain('not a date written YYYY-MM-DD');
    expect(one({ ...good, day: '2026-10-07' })[0]).toContain('mainnet still ran the old build');
    expect(one({ ...good, day: '2026-10-08' })[0]).toContain('mainnet still ran the old build');
    expect(one({ ...good, day: '2026-10-11' })[0]).toContain('has not come yet');
    // The slot: a whole number, after the last read of the old build, and one that falls on the day.
    expect(one({ ...good, slot: 'soon' })[0]).toContain('not a whole number');
    expect(one({ ...good, slot: '451,687,458' })[0]).toContain('last read still running the old build');
    // The values a reviewer typed on 2026-10-09 with the old program still running: that day,
    // and a slot at which the old build had just been read. They passed the floors of then.
    expect(one({ ...good, slot: '454,744,979' })[0]).toContain('last read still running the old build');
    expect(one({ ...good, slot: '454,754,407' })[0]).toContain('last read still running the old build');
    expect(one({ ...good, slot: '454,754,408' })).toEqual([]);
    expect(one({ ...good, slot: '474,790,112' })[0]).toContain('does not fall on 2026-10-09');
    // An early slot under a later day: the floor lets it through, the day does not.
    expect(recordProblems({ ...good, day: '2026-10-13' }, new Date('2026-10-14T12:00:00Z'))[0]).toContain('does not fall on 2026-10-13');
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
