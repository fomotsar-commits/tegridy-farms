#!/usr/bin/env node
// The release folder the local-validator e2e needs, built where the release is not on disk (CI).
//
//   node scripts/solana-localnet/stage-from-mainnet.mjs --out <dir>
//
// Every file genesis-accounts.mjs pins (PINNED_SHA256) is written to <dir> under its pinned name,
// with a checksum list, or nothing is written. A program's .so is read from mainnet (its
// ProgramData, the ELF cut at its section headers), so it can only be the build mainnet runs; an
// IDL is the committed one, or the committed pool IDL without create_lp_metadata, which
// src/lib/launcher/solana/write/idl.test.ts holds is the release's. Each must hash to its pin.
// Mainnet is only read. Exit 1, naming the file and both hashes, when a pin is not mainnet's.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import * as genesis from './genesis-accounts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IDL_DIR = path.join(HERE, '..', '..', '..', 'solana', 'tegridy-amm', 'idl');
const RPC = process.env.MAINNET_RPC || 'https://api.mainnet-beta.solana.com';
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
/** ProgramData: u32 tag, u64 slot, Option<Pubkey> authority, then the ELF. */
const PROGRAM_DATA_HEADER = 45;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function accountData(address) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'base64', commitment: 'finalized' }] }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    const body = await res.json();
    const v = body?.result?.value;
    if (!v) throw new Error(`${address}: no account on mainnet (${res.status} ${JSON.stringify(body?.error ?? null)})`);
    return { owner: v.owner, data: Buffer.from(v.data[0], 'base64') };
  }
}

/** The ELF a program runs on mainnet, without the ProgramData's tail padding. */
export function elfOf(programData) {
  const elf = programData.subarray(PROGRAM_DATA_HEADER);
  if (elf.readUInt32BE(0) !== 0x7f454c46) throw new Error('the ProgramData does not hold an ELF');
  const end = Number(elf.readBigUInt64LE(0x28)) + elf.readUInt16LE(0x3a) * elf.readUInt16LE(0x3c);
  if (!(end > 0 && end <= elf.length)) throw new Error(`the ELF's section headers end at ${end}, past its ${elf.length} bytes`);
  return elf.subarray(0, end);
}

async function mainnetElf(program) {
  const p = await accountData(program.toBase58());
  if (p.owner !== UPGRADEABLE_LOADER || p.data.readUInt32LE(0) !== 2) throw new Error(`${program.toBase58()} is not an upgradeable program`);
  const programData = new PublicKey(p.data.subarray(4, 36)).toBase58();
  return elfOf((await accountData(programData)).data);
}

/** Where each pinned file comes from. */
function sourceOf(file) {
  if (file.endsWith('.so')) {
    if (file.startsWith('tegridy_launch')) return { program: genesis.LAUNCH_PROGRAM };
    if (file.startsWith('cp_swap')) return { program: genesis.CP_SWAP_PROGRAM };
  }
  if (file.endsWith('.idl.json')) {
    if (file.startsWith('tegridy_launch')) return { idl: 'tegridy_launch.json' };
    if (file.startsWith('raydium_cp_swap')) return { idl: 'raydium_cp_swap.json' };
  }
  throw new Error(`no source known for the pinned file ${file}`);
}

/** The committed IDL, or the release's (the committed pool IDL without create_lp_metadata). */
function idlCandidates(name) {
  const raw = fs.readFileSync(path.join(IDL_DIR, name));
  const idl = JSON.parse(raw.toString('utf8'));
  const without = { ...idl, instructions: idl.instructions.filter((i) => i.name !== 'create_lp_metadata') };
  return [raw, Buffer.from(JSON.stringify(without, null, 2))];
}

export async function stage(out) {
  const files = [];
  for (const [file, pin] of Object.entries(genesis.PINNED_SHA256)) {
    const src = sourceOf(file);
    let bytes;
    if (src.program) {
      bytes = await mainnetElf(src.program);
      const got = sha256(bytes);
      if (got !== pin) throw new Error(`${file}: mainnet's ${src.program.toBase58()} runs ${got}, this checkout pins ${pin}`);
    } else {
      bytes = idlCandidates(src.idl).find((b) => sha256(b) === pin);
      if (!bytes) throw new Error(`${file}: no committed IDL (solana/tegridy-amm/idl/${src.idl}) hashes to its pin ${pin}`);
    }
    files.push({ file, pin, bytes });
  }
  fs.mkdirSync(out, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(out, f.file), f.bytes);
  // Each list names every file: the checks find a file's line in the list they read it from.
  const sums = files.map((f) => `${f.pin}  ${f.file}\n`).join('');
  for (const list of new Set(['SHA256SUMS', ...(genesis.UPGRADE_SUMS ? [genesis.UPGRADE_SUMS] : [])])) fs.writeFileSync(path.join(out, list), sums);
  return files.map((f) => `${f.file} ${f.pin.slice(0, 8)} ${f.bytes.length} B`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out');
  const out = at > 0 ? process.argv[at + 1] : null;
  if (!out) {
    console.error('usage: node scripts/solana-localnet/stage-from-mainnet.mjs --out <dir>');
    process.exit(2);
  }
  stage(path.resolve(out)).then(
    (lines) => console.log(`staged from ${RPC} into ${path.resolve(out)}:\n  ${lines.join('\n  ')}`),
    (e) => {
      console.error(`REFUSING: ${e.message}`);
      process.exit(1);
    },
  );
}
