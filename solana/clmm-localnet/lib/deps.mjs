// The two Solana libraries, taken from the frontend's install (frontend/package-lock.json,
// which the npm advisory gate already audits), so this harness adds no npm project of its own.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(join(REPO, 'frontend', 'package.json'));

const web3 = require('@solana/web3.js');
const spl = require('@solana/spl-token');

export const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, LAMPORTS_PER_SOL, SYSVAR_RENT_PUBKEY,
} = web3;
export { spl };
