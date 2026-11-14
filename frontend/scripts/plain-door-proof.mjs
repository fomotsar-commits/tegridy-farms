#!/usr/bin/env node
/**
 * Proof that the plain door (scripts/lib/plain-door.mjs, KEEPER_TWO_DOORS) reads the real RPC's
 * answers as it should. It sends NOTHING that can land: the one transaction it hands the RPC is
 * signed by a key made here and thrown away, which holds no SOL, so the RPC's own test run refuses
 * it (no fee payer) and never passes it on. Read-only in effect; no key file is read.
 *
 *   node scripts/plain-door-proof.mjs
 *
 * It checks, against KEEPER_RPC_URL (default: the public mainnet RPC):
 *   1. a transaction the test run refuses comes back 'refused', with the RPC's reason;
 *   2. the same call the way the robot makes it (preflight at 'processed', 2 retries) is accepted
 *      by the RPC as a call (the options are ones it knows);
 *   3. an endpoint that cannot be reached comes back 'unread', never 'refused'.
 */
import { base58 } from '@scure/base';
import { Connection, Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { plainDoor } from './lib/plain-door.mjs';

const RPC = process.env.KEEPER_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const conn = new Connection(RPC, 'confirmed');
const thrown = Keypair.generate();
const { blockhash } = await conn.getLatestBlockhash('confirmed');
const tx = new VersionedTransaction(
  new TransactionMessage({ payerKey: thrown.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: thrown.publicKey, toPubkey: thrown.publicKey, lamports: 1 })] }).compileToV0Message(),
);
tx.sign([thrown]);

let failed = 0;
const check = (name, ok, said) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(said)}`);
};

const asRobot = plainDoor({ sendRaw: (raw) => conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'processed', maxRetries: 2 }) });
const refused = await asRobot(tx);
check('a transaction whose test run fails is refused by the plain door, nothing sent', refused.door === 'refused' && typeof refused.why === 'string' && refused.why.length > 0, refused);

const status = (await conn.getSignatureStatuses([base58.encode(tx.signatures[0])])).value[0];
check('the chain does not know its signature', status === null, status);

const dead = new Connection('http://127.0.0.1:9/', 'confirmed');
const unread = await plainDoor({ sendRaw: (raw) => dead.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'processed', maxRetries: 2 }) })(tx);
check('an RPC that cannot be reached is unread, never a refusal', unread.door === 'unread', unread);

console.log(failed ? `RESULT: ${failed} check(s) failed` : 'RESULT: ok, the plain door reads the RPC as expected (nothing was sent)');
process.exitCode = failed ? 1 : 0;
