// One-time operator tool: create the wSOL + USDC fee ATAs for the Tegridy
// Solana fee wallet, using the SAME libraries + derivation the app uses.
//
// SAFETY: this reads a keypair from a LOCAL file path you provide. It is never
// transmitted anywhere except to sign the ATA-create transaction you send to
// the RPC. Review this file before running — it only creates two associated
// token accounts (idempotent) and prints their addresses.
//
// RUN (from the frontend/ directory, so the @solana/* deps resolve):
//   FEE_KEYPAIR=/path/to/fee-wallet-keypair.json node create-fee-atas.mjs
// Optional: SOLANA_RPC_URL=https://your-keyed-rpc node create-fee-atas.mjs
//
// The keypair you pass is the PAYER (pays ~0.002 SOL rent per ATA). The ATA
// OWNER is hardcoded to the fee wallet below, so even if you pay from a
// different funded wallet, the fee accounts are still owned by the fee wallet.

import fs from 'node:fs';
import os from 'node:os';
import {
  Connection, Keypair, PublicKey,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

const FEE_OWNER = 'DVGiHe98CzEf7VuCS6YpVDFnp38ubJmKNLt6aMJwAyER';
const SOL_MINT = 'So11111111111111111111111111111111111111112';   // wSOL
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const kpPath = (process.env.FEE_KEYPAIR || `${os.homedir()}/.config/solana/id.json`).replace(/^~/, os.homedir());
if (!fs.existsSync(kpPath)) {
  console.error(`Keypair file not found: ${kpPath}\nSet FEE_KEYPAIR=/path/to/keypair.json`);
  process.exit(1);
}
const raw = fs.readFileSync(kpPath, 'utf8').trim();
let secret;
if (raw.startsWith('[')) {
  // Solana CLI format: JSON array of 64 bytes.
  secret = Uint8Array.from(JSON.parse(raw));
} else {
  // Phantom "Export Private Key" format: a base58 string. Save it to a file
  // (never paste a private key into a shell command) and point FEE_KEYPAIR at it.
  const bs58 = (await import('bs58')).default;
  secret = bs58.decode(raw);
}
const payer = Keypair.fromSecretKey(secret);
const owner = new PublicKey(FEE_OWNER);

const wsolAta = getAssociatedTokenAddressSync(new PublicKey(SOL_MINT), owner, true);
const usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), owner, true);

console.log('Payer (signs + pays rent):', payer.publicKey.toBase58());
console.log('Fee owner (ATA owner)    :', FEE_OWNER);
console.log('wSOL fee ATA             :', wsolAta.toBase58());
console.log('USDC fee ATA             :', usdcAta.toBase58());
if (payer.publicKey.toBase58() !== FEE_OWNER) {
  console.log('NOTE: payer != fee owner — fine, ATAs are still owned by the fee wallet.');
}

const conn = new Connection(RPC, 'confirmed');
const tx = new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, wsolAta, owner, new PublicKey(SOL_MINT), TOKEN_PROGRAM_ID),
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, usdcAta, owner, new PublicKey(USDC_MINT), TOKEN_PROGRAM_ID),
);
const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
console.log('\n✅ Done. Signature:', sig);

const infos = await conn.getMultipleAccountsInfo([wsolAta, usdcAta]);
console.log('wSOL ATA exists now:', !!infos[0]);
console.log('USDC ATA exists now:', !!infos[1]);
