// @vitest-environment node
//
// The release folder built from mainnet for the CI e2e (stage-from-mainnet.mjs). What it holds:
// a program's file is the ELF mainnet runs, cut at its section headers and never padded; a pin
// mainnet does not run is refused, naming both hashes, and then nothing is written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { elfOf, stage } from './stage-from-mainnet.mjs';
import { PINNED_SHA256, LAUNCH_PROGRAM, CP_SWAP_PROGRAM } from './genesis-accounts.mjs';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** An ELF-shaped buffer: section headers at `shoff`, `n` of 64 bytes, ending the file. */
function fakeElf(shoff, n, fill = 7) {
  const elf = Buffer.alloc(shoff + n * 64, fill);
  elf.writeUInt32BE(0x7f454c46, 0);
  elf.writeBigUInt64LE(BigInt(shoff), 0x28);
  elf.writeUInt16LE(64, 0x3a);
  elf.writeUInt16LE(n, 0x3c);
  return elf;
}

const programData = (elf, pad) => Buffer.concat([Buffer.alloc(45, 3), elf, Buffer.alloc(pad)]);

afterEach(() => vi.unstubAllGlobals());

describe('elfOf', () => {
  it('cuts the ProgramData header and its tail padding off, keeping the ELF byte for byte', () => {
    const elf = fakeElf(1000, 12);
    expect(sha256(elfOf(programData(elf, 8414)))).toBe(sha256(elf));
    expect(sha256(elfOf(programData(elf, 0)))).toBe(sha256(elf));
  });

  it('refuses an account that holds no ELF, or one whose section headers run past it', () => {
    expect(() => elfOf(Buffer.alloc(200))).toThrow(/does not hold an ELF/);
    expect(() => elfOf(programData(fakeElf(1000, 12), 0).subarray(0, 1200))).toThrow(/past its/);
  });
});

describe('stage', () => {
  /** A mainnet whose two programs run `elves[id]`. */
  function mainnet(elves) {
    const pd = (id) => new PublicKey(crypto.createHash('sha256').update(id).digest()).toBase58();
    const accounts = new Map();
    for (const [id, elf] of Object.entries(elves)) {
      const program = Buffer.alloc(36);
      program.writeUInt32LE(2, 0);
      new PublicKey(pd(id)).toBuffer().copy(program, 4);
      accounts.set(id, { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', data: program });
      accounts.set(pd(id), { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', data: programData(elf, 4096) });
    }
    vi.stubGlobal('fetch', async (_url, init) => {
      const address = JSON.parse(init.body).params[0];
      const a = accounts.get(address);
      return new Response(JSON.stringify({ result: { value: a ? { owner: a.owner, data: [a.data.toString('base64'), 'base64'] } : null } }));
    });
  }

  it('refuses a pin mainnet does not run, naming both hashes, and writes nothing', async () => {
    mainnet({ [LAUNCH_PROGRAM.toBase58()]: fakeElf(500, 3), [CP_SWAP_PROGRAM.toBase58()]: fakeElf(600, 3) });
    const out = path.join(os.tmpdir(), `stage-test-${process.pid}-${Date.now()}`);
    const soFile = Object.keys(PINNED_SHA256).find((f) => f.endsWith('.so'));
    await expect(stage(out)).rejects.toThrow(new RegExp(`${soFile.replace(/\./g, '\\.')}: mainnet's \\w+ runs [0-9a-f]{64}, this checkout pins ${PINNED_SHA256[soFile]}`));
    expect(fs.existsSync(out)).toBe(false);
  });
});
