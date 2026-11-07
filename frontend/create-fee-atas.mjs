// One-time operator tool: create the fee wallet's wSOL, USDC and USDT associated
// token accounts (ATAs), with the SAME libraries and derivation the app uses
// (src/lib/jupiter.ts feeAccountFor: legacy SPL token program, owner may be off
// curve). Jupiter refuses a swap whose feeAccount does not exist, and jupiter.ts
// picks the fee mint from {wSOL, USDC, USDT} by the pair alone, so all three
// accounts must exist before a build that names a mint reaches production.
//
// SAFETY: this reads a keypair from a LOCAL file path you provide. It is never
// transmitted anywhere except to sign the ATA-create transaction you send to
// the RPC. Review this file before running: it only creates associated token
// accounts (idempotent; the ones that already exist are skipped) and prints
// their addresses.
//
// RUN (from the frontend/ directory, so the @solana/* deps resolve):
//   node create-fee-atas.mjs --dry-run          # derive and read only: no keypair, nothing sent
//   FEE_KEYPAIR=/path/to/keypair.json node create-fee-atas.mjs
// Optional: SOLANA_RPC_URL=https://your-keyed-rpc node create-fee-atas.mjs
//
// The keypair you pass is the PAYER (pays ~0.002 SOL rent per missing ATA). The
// ATA OWNER is hardcoded to the fee wallet below, so even if you pay from a
// different funded wallet, the fee accounts are still owned by the fee wallet.

import fs from 'node:fs';
import os from 'node:os';
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// The Squads vault: the live VITE_SOLANA_FEE_ACCOUNT (scripts/addresses.json
// `squads-vault`; `swap-fee-account` records the wallet that held the role before
// 2026-10-10, and nothing is sent there now). The printed owner must equal
// Vercel's VITE_SOLANA_FEE_ACCOUNT, or the accounts belong to the wrong owner.
const FEE_OWNER = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
// The fee-mint set of src/lib/jupiter.ts pickFeeMint, all legacy SPL.
const MINTS = [
  { symbol: 'wSOL', mint: 'So11111111111111111111111111111111111111112' },
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
];
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('--print');

const owner = new PublicKey(FEE_OWNER);
const atas = MINTS.map((m) => ({
  ...m,
  ata: getAssociatedTokenAddressSync(new PublicKey(m.mint), owner, true),
}));

console.log('Fee owner (ATA owner)    :', FEE_OWNER);
for (const a of atas) console.log(`${a.symbol.padEnd(4)} fee ATA             :`, a.ata.toBase58());

/** The payer's keypair from FEE_KEYPAIR, or null (said on stderr) when the file is missing. */
async function loadPayer() {
  const kpPath = (process.env.FEE_KEYPAIR || `${os.homedir()}/.config/solana/id.json`).replace(/^~/, os.homedir());
  if (!fs.existsSync(kpPath)) {
    console.error(`Keypair file not found: ${kpPath}\nSet FEE_KEYPAIR=/path/to/keypair.json`);
    return null;
  }
  const raw = fs.readFileSync(kpPath, 'utf8').trim();
  // Solana CLI format: a JSON array of 64 bytes. Otherwise Phantom's "Export Private
  // Key" format, a base58 string: save it to a file (never paste a private key into
  // a shell command) and point FEE_KEYPAIR at it. bs58 is loaded only on that path.
  const secret = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : (await import('bs58')).default.decode(raw);
  return Keypair.fromSecretKey(secret);
}

// Returns instead of calling process.exit: on Windows, exiting while the RPC
// connection's socket is still closing trips a libuv assertion after the output.
async function main() {
  // A read the RPC refuses throws here; a null entry is an account that is absent.
  const conn = new Connection(RPC, 'confirmed');
  const before = await conn.getMultipleAccountsInfo(atas.map((a) => a.ata));
  const missing = atas.filter((_, i) => !before[i]);
  console.log('');
  for (const [i, a] of atas.entries()) console.log(`${a.symbol.padEnd(4)} ATA exists on chain :`, before[i] ? 'yes' : 'NO');

  if (!missing.length) {
    console.log('\nAll three fee accounts exist. Nothing to send.');
    return 0;
  }
  if (DRY_RUN) {
    console.log(`\nDry run: ${missing.map((a) => a.symbol).join(', ')} would be created (~0.002 SOL rent each). Nothing sent.`);
    return 0;
  }

  const payer = await loadPayer();
  if (!payer) return 1;
  console.log('\nPayer (signs + pays rent):', payer.publicKey.toBase58());
  if (payer.publicKey.toBase58() !== FEE_OWNER) {
    console.log('NOTE: payer != fee owner. Fine: the accounts are still owned by the fee wallet.');
  }
  console.log('Creating:', missing.map((a) => `${a.symbol} ${a.ata.toBase58()}`).join(', '));

  const tx = new Transaction().add(
    ...missing.map((a) => createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, a.ata, owner, new PublicKey(a.mint), TOKEN_PROGRAM_ID,
    )),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
  console.log('\nDone. Signature:', sig);

  const after = await conn.getMultipleAccountsInfo(atas.map((a) => a.ata));
  for (const [i, a] of atas.entries()) console.log(`${a.symbol.padEnd(4)} ATA exists now      :`, after[i] ? 'yes' : 'NO');
  if (after.some((x) => !x)) {
    console.error('A fee account is still missing after the send: read the signature on an explorer before running again.');
    return 1;
  }
  return 0;
}

process.exitCode = await main();
