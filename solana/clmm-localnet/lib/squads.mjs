// The vault signing through Squads v4: create a vault transaction, propose it, two members
// approve, wait out the time lock, execute. Encoded from Squads' own IDL (read from its mainnet
// IDL account by setup.mjs); `checkIdl` fails if the IDL's argument layout differs from this file.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PublicKey, TransactionInstruction, SystemProgram } from './deps.mjs';
import { ADDR, WORK } from './config.mjs';
import { conn, send, clockNow, wait } from './chain.mjs';

const P = ADDR.squads;
const disc = (n) => createHash('sha256').update('global:' + n).digest().subarray(0, 8);
const u8 = (n) => Buffer.from([n]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const noMemo = Buffer.from([0]);

export function checkIdl() {
  const idl = JSON.parse(readFileSync(join(WORK, 'mainnet', 'squads.idl.json'), 'utf-8'));
  const t = (n) => idl.types.find((x) => x.name === n).type.fields.map((f) => `${f.name}:${JSON.stringify(f.type)}`).join(',');
  const want = {
    VaultTransactionCreateArgs: 'vaultIndex:"u8",ephemeralSigners:"u8",transactionMessage:"bytes",memo:{"option":"string"}',
    ProposalCreateArgs: 'transactionIndex:"u64",draft:"bool"',
    ProposalVoteArgs: 'memo:{"option":"string"}',
  };
  for (const [n, w] of Object.entries(want)) if (t(n) !== w) throw new Error(`Squads IDL ${n} is ${t(n)}, this file encodes ${w}`);
  const acc = (n) => idl.instructions.find((i) => i.name === n).accounts.map((a) => a.name + (a.isMut ? '*' : '') + (a.isSigner ? '!' : '')).join(' ');
  const wantAcc = {
    vaultTransactionCreate: 'multisig* transaction* creator! rentPayer*! systemProgram',
    proposalCreate: 'multisig proposal* creator! rentPayer*! systemProgram',
    proposalApprove: 'multisig member*! proposal*',
    vaultTransactionExecute: 'multisig proposal* transaction member!',
  };
  for (const [n, w] of Object.entries(wantAcc)) if (acc(n) !== w) throw new Error(`Squads IDL ${n} accounts are ${acc(n)}`);
  return idl;
}

export const vaultPda = (multisig, index = 0) =>
  PublicKey.findProgramAddressSync([Buffer.from('multisig'), multisig.toBuffer(), Buffer.from('vault'), u8(index)], P)[0];
const txPda = (multisig, i) => PublicKey.findProgramAddressSync([Buffer.from('multisig'), multisig.toBuffer(), Buffer.from('transaction'), u64(i)], P)[0];
const proposalPda = (multisig, i) =>
  PublicKey.findProgramAddressSync([Buffer.from('multisig'), multisig.toBuffer(), Buffer.from('transaction'), u64(i), Buffer.from('proposal')], P)[0];

export async function readMultisig(multisig) {
  const d = (await conn.getAccountInfo(multisig)).data;
  const rc = d[94];
  let o = 94 + (rc ? 33 : 1) + 1;
  const n = d.readUInt32LE(o); o += 4;
  const members = [];
  for (let i = 0; i < n; i++) { members.push({ key: new PublicKey(d.subarray(o, o + 32)), mask: d[o + 32] }); o += 33; }
  return { threshold: d.readUInt16LE(72), timeLock: d.readUInt32LE(74), transactionIndex: Number(d.readBigUInt64LE(78)), staleIndex: Number(d.readBigUInt64LE(86)), members };
}

const STATUS = ['Draft', 'Active', 'Rejected', 'Approved', 'Executing', 'Executed', 'Cancelled'];
export async function readProposal(multisig, i) {
  const a = await conn.getAccountInfo(proposalPda(multisig, i));
  if (!a) return null;
  const d = a.data;
  const s = d[8 + 32 + 8];
  return { status: STATUS[s], timestamp: s === 4 ? null : Number(d.readBigInt64LE(8 + 32 + 8 + 1)) };
}

/** Squads' TransactionMessage: one-byte counts and one-byte (data: two-byte) lengths. */
function compileMessage(vault, ixs) {
  const metas = new Map();
  const touch = (k, signer, writable) => {
    const s = k.toBase58();
    const m = metas.get(s) || { key: k, signer: false, writable: false };
    m.signer ||= signer; m.writable ||= writable; metas.set(s, m);
  };
  touch(vault, true, true);
  for (const ix of ixs) {
    for (const a of ix.keys) touch(a.pubkey, a.isSigner, a.isWritable);
    touch(ix.programId, false, false);
  }
  const all = [...metas.values()];
  for (const m of all) if (m.signer && !m.key.equals(vault)) throw new Error(`a vault transaction cannot need signer ${m.key.toBase58()}`);
  const order = (m) => (m.signer ? 0 : 2) + (m.writable ? 0 : 1);
  all.sort((a, b) => order(a) - order(b));
  const index = new Map(all.map((m, i) => [m.key.toBase58(), i]));
  const parts = [
    u8(all.filter((m) => m.signer).length), u8(all.filter((m) => m.signer && m.writable).length),
    u8(all.filter((m) => !m.signer && m.writable).length),
    u8(all.length), ...all.map((m) => m.key.toBuffer()),
    u8(ixs.length),
    ...ixs.flatMap((ix) => [u8(index.get(ix.programId.toBase58())), u8(ix.keys.length), Buffer.from(ix.keys.map((k) => index.get(k.pubkey.toBase58()))), u16(ix.data.length), ix.data]),
    u8(0),
  ];
  return { bytes: Buffer.concat(parts), accounts: all };
}

export const approveIx = (i, member) => new TransactionInstruction({
  programId: P, data: Buffer.concat([disc('proposal_approve'), noMemo]),
  keys: [{ pubkey: ADDR.multisig, isSigner: false, isWritable: false }, { pubkey: member.publicKey, isSigner: true, isWritable: true }, { pubkey: proposalPda(ADDR.multisig, i), isSigner: false, isWritable: true }],
});

export function executeIx(i, msg, executor) {
  const ms = ADDR.multisig;
  return new TransactionInstruction({
    programId: P, data: disc('vault_transaction_execute'),
    keys: [
      { pubkey: ms, isSigner: false, isWritable: false }, { pubkey: proposalPda(ms, i), isSigner: false, isWritable: true },
      { pubkey: txPda(ms, i), isSigner: false, isWritable: false }, { pubkey: executor.publicKey, isSigner: true, isWritable: false },
      // The vault signs inside the program (invoke_signed), so no account here is a signer.
      ...msg.accounts.map((m) => ({ pubkey: m.key, isSigner: false, isWritable: m.writable })),
    ],
  });
}

export const squadsPdas = (i) => [txPda(ADDR.multisig, i), proposalPda(ADDR.multisig, i)];

/** Waits until the chain clock passes the proposal's approval time plus the lock. */
export async function waitLock(i) {
  const p = await readProposal(ADDR.multisig, i);
  const lock = (await readMultisig(ADDR.multisig)).timeLock;
  while ((await clockNow()) < p.timestamp + lock) await wait(1000);
  return { approvedAt: p.timestamp, lock };
}

/**
 * Runs `ixs` as the vault: create + propose + first approval (member A), second approval
 * (member B), wait for the lock, execute. Options let a check stop early or misbehave:
 * { approvals: 1|2, executeEarly: true, executor }. Returns every step's record.
 */
export async function asVault(label, ixs, members, opts = {}) {
  const ms = ADDR.multisig;
  const vault = vaultPda(ms);
  const before = await readMultisig(ms);
  const i = before.transactionIndex + 1;
  const msg = compileMessage(vault, ixs);
  const [A, B] = members;
  if (opts.onIndex) opts.onIndex(i);
  const create = new TransactionInstruction({
    programId: P, data: Buffer.concat([disc('vault_transaction_create'), u8(0), u8(0), u32(msg.bytes.length), msg.bytes, noMemo]),
    keys: [
      { pubkey: ms, isSigner: false, isWritable: true }, { pubkey: txPda(ms, i), isSigner: false, isWritable: true },
      { pubkey: A.publicKey, isSigner: true, isWritable: false }, { pubkey: A.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  const propose = new TransactionInstruction({
    programId: P, data: Buffer.concat([disc('proposal_create'), u64(i), u8(0)]),
    keys: [
      { pubkey: ms, isSigner: false, isWritable: false }, { pubkey: proposalPda(ms, i), isSigner: false, isWritable: true },
      { pubkey: A.publicKey, isSigner: true, isWritable: false }, { pubkey: A.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  const steps = { index: i, msg };
  steps.create = await send(`${label}: create + propose + approve (member A)`, [create, propose, approveIx(i, A)], [A]);
  if (!steps.create.ok) return { ...steps, executed: false };
  if ((opts.approvals ?? 2) >= 2) steps.approveB = await send(`${label}: approve (member B)`, [approveIx(i, B)], [B]);
  const executor = opts.executor || A;
  steps.proposal = await readProposal(ms, i);
  if (opts.earlyAttempt) {
    // An execute sent at once, before the lock has run: Squads must refuse it.
    steps.early = await send(`${label}: execute before the time lock`, [executeIx(i, msg, executor)], [executor], { expectFail: true });
    steps.afterEarly = await readProposal(ms, i);
  }
  if (opts.approvals === 1 && opts.stopIfPending && steps.proposal.status !== 'Approved') {
    steps.execute = await send(`${label}: execute with one approval`, [executeIx(i, msg, executor)], [executor], { expectFail: true });
    steps.after = await readProposal(ms, i);
    return { ...steps, executed: steps.execute.ok && steps.after?.status === 'Executed' };
  }
  if (steps.proposal.status === 'Approved' && !opts.executeEarly) Object.assign(steps, await waitLock(i));
  steps.execute = await send(`${label}: execute`, [executeIx(i, msg, executor)], [executor]);
  steps.after = await readProposal(ms, i);
  steps.executedAt = steps.execute.blockTime;
  return { ...steps, executed: steps.execute.ok && steps.after?.status === 'Executed' };
}
