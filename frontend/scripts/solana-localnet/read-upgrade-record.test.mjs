// @vitest-environment node
//
// The reader that fills the runbook's record of the pool program's upgrade must print a
// record ONLY when mainnet holds the new build. Everything here runs on made-up chain
// answers: no network, no key. The refusals are the point. A reader that printed four
// well-shaped rows before the upgrade would hand someone the values that turn the record
// test green while the old program still runs.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADER, MAINNET_GENESIS, OLD_BUILD, PROGRAM_DATA, pickExecute, readProgramData, recordRows, registeredBuild, run, verdict } from './read-upgrade-record.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Two made-up builds, the new one larger than the old one, as on mainnet.
const newProgram = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) % 251));
const oldProgram = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 17 + 3) % 241));
const builds = { new: { sha256: sha(newProgram), bytes: newProgram.length }, old: { sha256: sha(oldProgram), bytes: oldProgram.length } };

const account = (slot, ...parts) => {
  const header = Buffer.alloc(HEADER);
  header.writeUInt32LE(3, 0);
  header.writeBigUInt64LE(BigInt(slot), 4);
  header[12] = 1;
  return Buffer.concat([header, ...parts]);
};
const asFirstDeployed = account(1000, oldProgram);
const afterAnEnlargeAlone = account(2000, oldProgram, Buffer.alloc(newProgram.length - oldProgram.length));
const afterTheUpgrade = account(3000, newProgram);

const SIGNATURE = '5'.repeat(88);
/** A stand-in chain: what each read answers, and a list of the reads that were made. */
function chain({ data, signatures = [], genesis = MAINNET_GENESIS }) {
  const asked = [];
  const rpc = async (method, params) => {
    asked.push(method);
    if (method === 'getGenesisHash') return genesis;
    if (method === 'getAccountInfo') {
      expect(params[0]).toBe(PROGRAM_DATA);
      return { context: { slot: 9999 }, value: data ? { data: [data.toString('base64'), 'base64'] } : null };
    }
    if (method === 'getSignaturesForAddress') return signatures;
    throw new Error(`unexpected read ${method}`);
  };
  return { rpc, asked };
}
async function read(options, extra = {}) {
  const lines = [];
  const c = chain(options);
  const code = await run({ rpc: c.rpc, builds, log: (l) => lines.push(l), ...extra });
  const text = lines.join('\n');
  return { code, text, rows: text.split('\n').filter((l) => l.startsWith('| ')), asked: c.asked };
}

describe('the reader of the upgrade record refuses until mainnet holds the new build', () => {
  it('the program as first deployed: NOT UPGRADED, no row, exit 2, and it never looks for a transaction', async () => {
    const r = await read({ data: asFirstDeployed, signatures: [{ slot: 1000, err: null, signature: SIGNATURE, blockTime: 1_790_000_000 }] });
    expect(r.code).toBe(2);
    expect(r.text).toContain('NOT UPGRADED');
    expect(r.text).toContain('(the account is too small to hold the new build)');
    expect(r.rows).toEqual([]);
    expect(r.asked).toEqual(['getGenesisHash', 'getAccountInfo']);
  });

  it('after an enlarge alone (large enough, a newer last-deployed slot, the old program): still NOT UPGRADED and no row', async () => {
    const r = await read({ data: afterAnEnlargeAlone, signatures: [{ slot: 2000, err: null, signature: SIGNATURE, blockTime: 1_790_000_000 }] });
    expect(r.code).toBe(2);
    expect(r.text).toContain('NOT UPGRADED');
    expect(r.text).toContain('last deployed in slot 2,000');
    expect(r.rows).toEqual([]);
    expect(r.asked).not.toContain('getSignaturesForAddress');
  });

  it('a program that is neither build: STOP, no row, exit 2', async () => {
    const other = Buffer.from(newProgram);
    other[100] ^= 1;
    const r = await read({ data: account(3000, other) });
    expect(r.code).toBe(2);
    expect(r.text).toContain('NEITHER the new build nor the old one');
    expect(r.rows).toEqual([]);
  });

  it('refuses an endpoint that is not mainnet before it reads anything else', async () => {
    const c = chain({ data: afterTheUpgrade, genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' });
    await expect(run({ rpc: c.rpc, builds, log: () => {} })).rejects.toThrow('is not mainnet');
    expect(c.asked).toEqual(['getGenesisHash']);
  });

  it('refuses an account that is not a program data account, and one that does not exist', async () => {
    const buffer = Buffer.from(afterTheUpgrade);
    buffer.writeUInt32LE(1, 0);
    await expect(run({ rpc: chain({ data: buffer }).rpc, builds, log: () => {} })).rejects.toThrow('not a ProgramData account');
    await expect(run({ rpc: chain({ data: null }).rpc, builds, log: () => {} })).rejects.toThrow('does not exist');
  });

  it('--rehearse-on-old prints the shape, says it is NOT the upgrade, and still exits 2', async () => {
    const r = await read({ data: asFirstDeployed, signatures: [{ slot: 1000, err: null, signature: SIGNATURE, blockTime: 1_790_000_000 }] }, { rehearse: true });
    expect(r.code).toBe(2);
    expect(r.text).toContain('REHEARSAL ONLY');
    expect(r.text).toContain('NOT the upgrade');
    expect(r.text).not.toContain('UPGRADED: the program on mainnet is the new build');
    expect(r.rows).toHaveLength(4);
  });
});

describe('and prints the four rows once it does', () => {
  it('the upgraded program: four rows from the chain, exit 0', async () => {
    const blockTime = Date.UTC(2026, 9, 9, 18, 30, 0) / 1000;
    const r = await read({
      data: afterTheUpgrade,
      signatures: [
        { slot: 3001, err: null, signature: 'later', blockTime },
        { slot: 3000, err: { InstructionError: [0, 'Custom'] }, signature: 'a failed try in the same slot', blockTime },
        { slot: 3000, err: null, signature: SIGNATURE, blockTime },
        { slot: 2000, err: null, signature: 'the enlarge', blockTime: blockTime - 600 },
      ],
    });
    expect(r.code).toBe(0);
    expect(r.text).toContain('UPGRADED: the program on mainnet is the new build');
    expect(r.rows).toEqual(recordRows({ day: '2026-10-09', deploySlot: 3000, signature: SIGNATURE, size: afterTheUpgrade.length }));
    expect(r.rows[1]).toBe('| Slot of the execute (the program\'s "Last Deployed In Slot") | `3,000` |');
    expect(r.rows[3]).toBe(`| Size of the program's data account afterwards (bytes) | \`${afterTheUpgrade.length.toLocaleString('en-US')}\` |`);
  });

  it('with spare room after the new build (someone enlarged further) it is still the new build', () => {
    const roomy = readProgramData(account(3000, newProgram, Buffer.alloc(10_240)), builds);
    expect(verdict(roomy, builds)).toBe('upgraded');
    expect(roomy.size).toBe(HEADER + newProgram.length + 10_240);
  });

  it('refuses to pick a transaction when the slot holds none, or more than one, that succeeded', async () => {
    expect(pickExecute([], 3000)).toEqual({ ok: false, found: 0 });
    expect(pickExecute([{ slot: 3000, err: null }, { slot: 3000, err: null }], 3000)).toEqual({ ok: false, found: 2 });
    const r = await read({ data: afterTheUpgrade, signatures: [{ slot: 2999, err: null, signature: SIGNATURE, blockTime: 1 }] });
    expect(r.code).toBe(3);
    expect(r.rows).toEqual([]);
  });

  it('the rows carry the labels the record test reads', () => {
    const test = readFileSync(join(HERE, '..', '..', 'src', 'test', 'poolProgramUpgradeRecord.test.ts'), 'utf-8');
    for (const row of recordRows({ day: '2026-10-09', deploySlot: 1, signature: SIGNATURE, size: 1 })) {
      const label = /^\| ([^|(]+?)( \(|\s\|)/.exec(row)[1];
      expect(test, `the record test has no row label "${label}"`).toContain(label);
    }
  });
});

describe('the builds it looks for', () => {
  it('the new build comes from the address registry row of this same account, not from a second copy', () => {
    const registry = JSON.parse(readFileSync(join(HERE, '..', 'addresses.json'), 'utf-8'));
    const row = registry.solana.find((e) => e.id === 'cp-swap-programdata-restart');
    expect(row.address).toBe(PROGRAM_DATA);
    expect(registeredBuild()).toEqual(row.expect.holdsProgram);
    expect(registeredBuild().sha256).not.toBe(OLD_BUILD.sha256);
  });

  it('refuses a registry that does not say which build the account holds', () => {
    expect(() => registeredBuild(join(HERE, 'golden', 'usdc-mint.mainnet.json'))).toThrow('no expect.holdsProgram');
  });
});
