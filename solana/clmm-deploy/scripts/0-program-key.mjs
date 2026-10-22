#!/usr/bin/env node
// THE PROGRAM KEY YOU JUST MADE: is it fit to become the range program's address? READ-ONLY: the key
// file is never opened here; its ADDRESS is asked of your own Solana tool, which prints nothing secret.
//
//   node 0-program-key.mjs --key <the program key file>
//
// It refuses a key file the build tool wrote by itself (target\deploy\...-keypair.json), and any key
// whose address already holds an account on mainnet or on devnet. It prints the address to give to a
// session: that address goes into the program, and the pack is staged for it.
import fs from 'node:fs';
import { CFG, args, addressOfKeyFile, isBuildToolKey, connect, read, addressesFree, Report, main, Stopped } from './lib/pack.mjs';

await main(async () => {
  const a = args();
  a.known(['--key']);
  const file = a.get('--key');
  if (!file) throw new Stopped('give the key file: --key <path>');
  const R = new Report('THE PROGRAM KEY\nRead-only: the key file is not opened by this script; nothing is sent.\n');
  R.check(fs.existsSync(file), `the file ${file} exists`, `there is no file ${file}`);
  R.check(!isBuildToolKey(file), 'it is not a key the build tool wrote by itself', `${file} is the key the build tool writes beside a program (target\\deploy). Never use it: make the key with the command in START-HERE.md`);
  const addr = addressOfKeyFile(file);
  if (!R.check(!!addr, `your Solana tool reads it as a key: address ${addr}`, `your Solana tool could not read ${file} as a key`)) return R.end('', 'Make the key again with the command in START-HERE.md.');
  R.check(addr !== CFG.placeholder && !CFG.denyKeys.includes(addr) && !Object.values(CFG.addr).includes(addr), 'it is a fresh address, none the venue or Raydium already uses', `${addr} is an address already in use by the venue or by Raydium's code`);
  for (const net of ['mainnet', 'devnet']) {
    // Read-only, so it asks both networks whatever this folder is for (a rehearsal folder too).
    const conn = connect(CFG.rpc[net]);
    const genesis = await read(`${net}'s genesis hash`, () => conn.getGenesisHash());
    if (genesis !== CFG.genesis[net]) { R.unread(`${CFG.rpc[net]} answers with genesis ${genesis}, not ${net}'s`); continue; }
    const { program: acc } = await addressesFree(conn, R, addr, net);
    R.check(!acc, `the address has no account on ${net}: nothing was ever deployed there`, `the address ALREADY has an account on ${net} (owner ${acc?.owner?.toBase58()}). Do not use this key: make a new one`);
  }
  if (R.ok) console.log(`\nThe range program's address will be:\n\n  ${addr}\n\nGive this address to the session doing the deploy, and to nobody else. Until the deploy it must stay\nprivate: anyone who knows it could block it for good by sending it SOL. Keep the key file where it is.`);
  return R.end('this key may become the range program\'s address.', 'Do not use this key. Make a new one with the command in START-HERE.md.');
});
