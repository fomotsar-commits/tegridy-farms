// The fee-tier proposal: one vault proposal that makes both tiers with the island split and points
// each tier's fund share at the island's Workshop; or, in a fee-change folder (cfg.change), one that
// sets an existing tier's fee (tierFee.mjs decides that one). Used by the page (bundled for the
// browser), by the scripts and by the rehearsal, so all three build and check the very same bytes.
//
// It never trusts a proposal it did not build: approve and execute are offered only for a
// proposal whose stored message is, byte for byte, the one this module compiles from config.json.
// No hashing happens here: every discriminator is pinned in config.json by stage.mjs.
import { Buffer } from 'buffer';

export function makeCore({ web3, cfg }) {
  const { PublicKey, TransactionInstruction, SystemProgram, TransactionMessage, VersionedTransaction } = web3;
  const P = (s) => (s instanceof PublicKey ? s : new PublicKey(s));
  const hex = (h) => Buffer.from(h, 'hex');
  const u8 = (n) => Buffer.from([n]);
  const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u16be = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const A = cfg.addr;
  const PROGRAM = P(cfg.programId);
  const SQUADS = P(A.squads);
  const MULTISIG = P(A.multisig);
  const VAULT = P(A.vault);
  const D = cfg.disc;

  const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
  const ammConfig = (index) => pda([Buffer.from('amm_config'), u16be(index)], PROGRAM);
  const vaultPda = () => pda([Buffer.from('multisig'), MULTISIG.toBuffer(), Buffer.from('vault'), u8(0)], SQUADS);
  const txPda = (i) => pda([Buffer.from('multisig'), MULTISIG.toBuffer(), Buffer.from('transaction'), u64(i)], SQUADS);
  const proposalPda = (i) => pda([Buffer.from('multisig'), MULTISIG.toBuffer(), Buffer.from('transaction'), u64(i), Buffer.from('proposal')], SQUADS);
  if (!vaultPda().equals(VAULT)) throw new Error(`vault 0 of ${A.multisig} is not ${A.vault}`);

  // ---- the tier instructions, as the program's Accounts structs order them -----------------
  function tierIxs() {
    const out = [];
    for (const t of cfg.tiers) {
      const cfgAcc = ammConfig(t.index);
      out.push(new TransactionInstruction({
        programId: PROGRAM,
        keys: [{ pubkey: VAULT, isSigner: true, isWritable: true }, { pubkey: cfgAcc, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
        data: Buffer.concat([hex(D.create_amm_config), u16le(t.index), u16le(t.tickSpacing), u32(t.tradeFeeRate), u32(t.protocolFeeRate), u32(t.fundFeeRate)]),
      }));
      // update_amm_config param 4: the fund owner is the one remaining account.
      out.push(new TransactionInstruction({
        programId: PROGRAM,
        keys: [{ pubkey: VAULT, isSigner: true, isWritable: false }, { pubkey: cfgAcc, isSigner: false, isWritable: true }, { pubkey: P(A.workshop), isSigner: false, isWritable: false }],
        data: Buffer.concat([hex(D.update_amm_config), u8(4), u32(0)]),
      }));
    }
    return out;
  }

  // ---- a fee-change folder (cfg.change): one update_amm_config on one tier that already exists ----
  // param 0 sets the tier's trade fee rate; the vault, the program's admin, signs. Owner, 2026-10-27:
  // "build the vault proposal that raises Range tier 1 from 0.25% to 1%".
  function feeIxs() {
    const c = cfg.change;
    return [new TransactionInstruction({
      programId: PROGRAM,
      keys: [{ pubkey: VAULT, isSigner: true, isWritable: false }, { pubkey: ammConfig(c.index), isSigner: false, isWritable: true }],
      data: Buffer.concat([hex(D.update_amm_config), u8(0), u32(c.to)]),
    })];
  }

  /** Squads' TransactionMessage: one-byte counts and lengths (the data length is two bytes). */
  function compile(ixs) {
    const metas = new Map();
    const touch = (k, signer, writable) => { const s = k.toBase58(); const m = metas.get(s) || { key: k, signer: false, writable: false }; m.signer ||= signer; m.writable ||= writable; metas.set(s, m); };
    touch(VAULT, true, true);
    for (const ix of ixs) { for (const a of ix.keys) touch(a.pubkey, a.isSigner, a.isWritable); touch(ix.programId, false, false); }
    const all = [...metas.values()];
    const rank = (m) => (m.signer ? 0 : 2) + (m.writable ? 0 : 1);
    all.sort((a, b) => rank(a) - rank(b) || (a.key.equals(VAULT) ? -1 : b.key.equals(VAULT) ? 1 : 0));
    const at = new Map(all.map((m, i) => [m.key.toBase58(), i]));
    const message = {
      numSigners: all.filter((m) => m.signer).length,
      numWritableSigners: all.filter((m) => m.signer && m.writable).length,
      numWritableNonSigners: all.filter((m) => !m.signer && m.writable).length,
      accountKeys: all.map((m) => m.key.toBase58()),
      instructions: ixs.map((ix) => ({ programIdIndex: at.get(ix.programId.toBase58()), accountIndexes: ix.keys.map((k) => at.get(k.pubkey.toBase58())), data: Buffer.from(ix.data).toString('hex') })),
    };
    const bytes = Buffer.concat([
      u8(message.numSigners), u8(message.numWritableSigners), u8(message.numWritableNonSigners),
      u8(all.length), ...all.map((m) => m.key.toBuffer()),
      u8(ixs.length), ...message.instructions.flatMap((ix) => [u8(ix.programIdIndex), u8(ix.accountIndexes.length), Buffer.from(ix.accountIndexes), u16le(ix.data.length / 2), hex(ix.data)]),
      u8(0),
    ]);
    return { bytes, message, accounts: all };
  }
  const EXPECTED = compile(cfg.change ? feeIxs() : tierIxs());

  // ---- decoding Squads' accounts ------------------------------------------------------------
  function reader(data) {
    const b = Buffer.from(data); let o = 0;
    return {
      u8: () => b[o++], u16: () => { const v = b.readUInt16LE(o); o += 2; return v; }, u32: () => { const v = b.readUInt32LE(o); o += 4; return v; },
      u64: () => { const v = b.readBigUInt64LE(o); o += 8; return v; }, i64: () => { const v = b.readBigInt64LE(o); o += 8; return v; },
      key: () => { const k = new PublicKey(b.subarray(o, o + 32)).toBase58(); o += 32; return k; },
      bytes: () => { const n = b.readUInt32LE(o); o += 4; const v = b.subarray(o, o + n); o += n; return Buffer.from(v); },
      disc: () => { const v = b.subarray(0, 8).toString('hex'); o = 8; return v; }, get o() { return o; }, len: b.length,
    };
  }
  function decodeVaultTransaction(data) {
    const r = reader(data);
    if (r.disc() !== D.VaultTransaction) return null;
    const v = { multisig: r.key(), creator: r.key(), index: Number(r.u64()), bump: r.u8(), vaultIndex: r.u8(), vaultBump: r.u8(), ephemeral: r.bytes().length };
    const m = { numSigners: r.u8(), numWritableSigners: r.u8(), numWritableNonSigners: r.u8(), accountKeys: [], instructions: [] };
    const nk = r.u32(); for (let i = 0; i < nk; i++) m.accountKeys.push(r.key());
    const ni = r.u32(); for (let i = 0; i < ni; i++) m.instructions.push({ programIdIndex: r.u8(), accountIndexes: [...r.bytes()], data: r.bytes().toString('hex') });
    m.lookups = r.u32();
    return { ...v, message: m };
  }
  const STATUS = ['Draft', 'Active', 'Rejected', 'Approved', 'Executing', 'Executed', 'Cancelled'];
  function decodeProposal(data) {
    const r = reader(data);
    if (r.disc() !== D.Proposal) return null;
    const p = { multisig: r.key(), index: Number(r.u64()) };
    const s = r.u8(); p.status = STATUS[s]; p.timestamp = s === 4 ? null : Number(r.i64());
    r.u8();
    for (const k of ['approved', 'rejected', 'cancelled']) { const n = r.u32(); p[k] = []; for (let i = 0; i < n; i++) p[k].push(r.key()); }
    return p;
  }
  /** Exactly ours: the same header, the same keys in the same order, the same instructions. */
  function isOurs(vt) {
    if (!vt || vt.multisig !== A.multisig || vt.vaultIndex !== 0 || vt.ephemeral !== 0 || vt.message.lookups !== 0) return false;
    const a = vt.message; const e = EXPECTED.message;
    return a.numSigners === e.numSigners && a.numWritableSigners === e.numWritableSigners && a.numWritableNonSigners === e.numWritableNonSigners
      && JSON.stringify(a.accountKeys) === JSON.stringify(e.accountKeys) && JSON.stringify(a.instructions) === JSON.stringify(e.instructions);
  }
  // Touching the range program: calling it, or naming it, its data account or a tier anywhere (a
  // loader upgrade names the program as an account). A lookup table could hide a key: that counts.
  const PROGRAM_DATA = pda([PROGRAM.toBuffer()], P(A.loader));
  const NAMED = new Set([cfg.programId, PROGRAM_DATA.toBase58(), ...cfg.tiers.map((t) => ammConfig(t.index).toBase58())]);
  const touchesProgram = (vt) => !!vt && (vt.message.lookups !== 0 || vt.message.accountKeys.some((k) => NAMED.has(k)));

  // ---- the AmmConfig account: 117 bytes ------------------------------------------------------
  function decodeTier(data) {
    const r = reader(data);
    if (r.disc() !== D.AmmConfig || r.len !== 117) return null;
    return { bump: r.u8(), index: r.u16(), owner: r.key(), protocolFeeRate: r.u32(), tradeFeeRate: r.u32(), tickSpacing: r.u16(), fundFeeRate: r.u32(), padding: r.u32(), fundOwner: r.key() };
  }
  const tierExact = (t, want) => t && t.index === want.index && t.tickSpacing === want.tickSpacing && t.tradeFeeRate === want.tradeFeeRate && t.protocolFeeRate === want.protocolFeeRate
    && t.fundFeeRate === want.fundFeeRate && t.owner === A.vault && t.fundOwner === A.workshop;

  // ---- the Squads instructions ---------------------------------------------------------------
  const sq = (name, keys, data) => new TransactionInstruction({ programId: SQUADS, keys, data: Buffer.concat([hex(D[name]), data]) });
  const m = (k, w = false, s = false) => ({ pubkey: P(k), isSigner: s, isWritable: w });
  /** Create, propose and approve: the expected message, or (the rehearsal's refusals) another. */
  const proposeIxs = (member, i, msg = EXPECTED) => [
    sq('vault_transaction_create', [m(MULTISIG, true), m(txPda(i), true), m(member, false, true), m(member, true, true), m(SystemProgram.programId)],
      Buffer.concat([u8(0), u8(0), u32(msg.bytes.length), msg.bytes, u8(0)])),
    sq('proposal_create', [m(MULTISIG), m(proposalPda(i), true), m(member, false, true), m(member, true, true), m(SystemProgram.programId)], Buffer.concat([u64(i), u8(0)])),
    approveIx(member, i),
  ];
  function approveIx(member, i) { return sq('proposal_approve', [m(MULTISIG), m(member, true, true), m(proposalPda(i), true)], u8(0)); }
  const executeIx = (member, i) => sq('vault_transaction_execute', [m(MULTISIG), m(proposalPda(i), true), m(txPda(i)), m(member, false, true),
    // The vault signs inside Squads (invoke_signed): no account here is a signer.
    ...EXPECTED.accounts.map((a) => m(a.key, a.writable))], Buffer.alloc(0));

  /** An unsigned transaction for the member's wallet: sign it, or simulate it first (sigVerify off). */
  async function txFor(conn, member, ixs) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const fee = web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.cuPrice });
    const msg = new TransactionMessage({ payerKey: P(member), recentBlockhash: blockhash, instructions: [fee, ...ixs] }).compileToLegacyMessage();
    return { vtx: new VersionedTransaction(msg), lastValidBlockHeight };
  }
  async function simulate(conn, member, ixs) {
    const { vtx } = await txFor(conn, member, ixs);
    const r = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    return { ok: !r.value.err, err: r.value.err, logs: r.value.logs ?? [] };
  }

  // ---- reading everything the page decides on --------------------------------------------------
  async function readMultisig(conn) {
    const a = await conn.getAccountInfo(MULTISIG, 'confirmed');
    if (!a || !a.owner.equals(SQUADS)) return null;
    const d = Buffer.from(a.data);
    if (d.subarray(0, 8).toString('hex') !== D.Multisig) return null;
    let o = 94 + (d[94] ? 33 : 1) + 1;
    const n = d.readUInt32LE(o); o += 4;
    const members = [];
    for (let i = 0; i < n; i++) { members.push({ key: new PublicKey(d.subarray(o, o + 32)).toBase58(), mask: d[o + 32] }); o += 33; }
    return { configAuthority: new PublicKey(d.subarray(40, 72)).toBase58(), threshold: d.readUInt16LE(72), timeLock: d.readUInt32LE(74), transactionIndex: Number(d.readBigUInt64LE(78)), staleIndex: Number(d.readBigUInt64LE(86)), members };
  }
  /** Every proposal there is. `live`: it could still execute. Squads executes an Approved vault
   *  transaction or batch even below the stale mark; a stale config transaction never; a stale
   *  Draft or Active one can no longer be approved. A batch is not read inside: `kind` says so. */
  async function scan(conn, ms) {
    const keys = [];
    for (let i = 1; i <= ms.transactionIndex; i++) keys.push(txPda(i), proposalPda(i));
    const infos = [];
    for (let k = 0; k < keys.length; k += 100) infos.push(...(await conn.getMultipleAccountsInfo(keys.slice(k, k + 100), 'confirmed')));
    const out = [];
    for (let i = 1; i <= ms.transactionIndex; i++) {
      const ta = infos[2 * (i - 1)]; const pa = infos[2 * (i - 1) + 1];
      const d = ta ? Buffer.from(ta.data).subarray(0, 8).toString('hex') : null;
      const kind = !ta ? 'none' : d === D.VaultTransaction ? 'vault' : d === D.ConfigTransaction ? 'config' : d === D.Batch ? 'batch' : 'unknown';
      const vt = kind === 'vault' ? decodeVaultTransaction(ta.data) : null;
      const p = pa ? decodeProposal(pa.data) : null;
      const stale = i <= ms.staleIndex;
      const live = !!p && (p.status === 'Approved' || p.status === 'Executing' ? kind !== 'config' || !stale : ['Draft', 'Active'].includes(p.status) && !stale);
      out.push({ index: i, proposal: p, kind, live, stale, ours: isOurs(vt), touches: kind === 'vault' ? touchesProgram(vt) : kind !== 'config' && kind !== 'none' });
    }
    return out;
  }
  async function tiers(conn) {
    const infos = await conn.getMultipleAccountsInfo(cfg.tiers.map((t) => ammConfig(t.index)), 'confirmed');
    return cfg.tiers.map((want, i) => {
      const a = infos[i];
      // Anyone may send SOL to a tier's address; the program's create still takes such an account.
      if (!a || (a.owner.equals(SystemProgram.programId) && a.data.length === 0)) return { want, state: 'absent', lamportsOnly: !!a };
      const t = a.owner.equals(PROGRAM) ? decodeTier(a.data) : null;
      return { want, state: tierExact(t, want) ? 'exact' : 'wrong', got: t };
    });
  }
  async function clock(conn) {
    const a = await conn.getAccountInfo(P('SysvarC1ock11111111111111111111111111111111'), 'confirmed');
    return Number(Buffer.from(a.data).readBigInt64LE(32));
  }
  /** The program as the loader holds it. `sha256hex(bytes)` is async (the browser's or Node's). */
  async function programState(conn, sha256hex) {
    const p = await conn.getAccountInfo(PROGRAM, 'confirmed');
    if (!p) return { exists: false };
    const pd = Buffer.from(p.data);
    if (!p.owner.equals(P(A.loader)) || pd.length !== 36 || pd.readUInt32LE(0) !== 2) return { exists: true, sameBuild: false, why: 'it is not a program of the upgradeable loader' };
    const d = await conn.getAccountInfo(new PublicKey(pd.subarray(4, 36)), 'confirmed');
    if (!d) return { exists: true, sameBuild: false, why: 'its data account is missing' };
    const b = Buffer.from(d.data);
    const authority = b[12] === 1 ? new PublicKey(b.subarray(13, 45)).toBase58() : null;
    const body = b.subarray(45);
    const code = body.subarray(0, cfg.binary.bytes);
    const h = code.length === cfg.binary.bytes ? await sha256hex(code) : null;
    const tailZero = body.subarray(cfg.binary.bytes).every((x) => x === 0);
    const sameBuild = h === cfg.binary.sha256 && tailZero;
    return { exists: true, authority, sameBuild, why: sameBuild ? 'byte for byte the build' : `its code hashes to ${h ?? 'a shorter file'}${tailZero ? '' : ', with bytes after it'}` };
  }

  /** Everything `decide` needs, read now. `notice` is { seenAt, live } from the recorded notice. */
  async function readState(conn, { sha256hex, member = null, notice = null, positionLink = null }) {
    const ms = await readMultisig(conn);
    return {
      ms, member, notice, positionLink,
      program: await programState(conn, sha256hex),
      proposals: ms ? await scan(conn, ms) : [],
      tiers: await tiers(conn),
      clock: await clock(conn),
    };
  }

  return {
    EXPECTED, PROGRAM_DATA, ammConfig, txPda, proposalPda, tierIxs, feeIxs, compile, decodeVaultTransaction, decodeProposal, decodeTier, isOurs, tierExact,
    proposeIxs, approveIx, executeIx, txFor, simulate, readMultisig, scan, tiers, clock, programState, readState,
  };
}

/**
 * The decision the page shows: one action at most, and every reason. `s` is what was read:
 * { ms, program (from programState), proposals (scan), tiers, clock, notice (the record of 5-record-notice.mjs),
 * positionLink: { ok, why } (serve.mjs asks the website), member }.
 */
export function decide(cfg, s) {
  const lines = [];
  const ok = (w) => lines.push({ ok: true, w });
  const stop = (w) => { lines.push({ ok: false, w }); return false; };
  const lockWanted = cfg.timeLock;
  let fine = true;
  if (!s.ms) fine = stop('the multisig could not be read as a Squads multisig');
  else {
    fine = (s.ms.threshold === 2 && s.ms.members.length === 2 ? ok(`2 approvals of 2 members (${s.ms.members.map((m) => m.key).join(', ')})`) : stop(`the multisig wants ${s.ms.threshold} of ${s.ms.members.length}, not 2 of 2`)) && fine;
    fine = (s.ms.timeLock === lockWanted ? ok(`the time lock is ${lockWanted.toLocaleString('en-US')} seconds (${lockWanted / 3600} hours)`) : stop(`the time lock is ${s.ms.timeLock} seconds, not ${lockWanted}: a change to the multisig itself has executed. Stop and ask`)) && fine;
    fine = (s.ms.configAuthority === '11111111111111111111111111111111' ? ok('nobody can change the multisig alone (no config authority)') : stop(`the multisig has a config authority, ${s.ms.configAuthority}`)) && fine;
  }
  const p = s.program;
  if (!p?.exists) fine = stop('the range program is not deployed yet: deploy it first (the deploy steps)');
  else {
    fine = (p.sameBuild ? ok(`the program on chain is byte for byte the reviewed build (${cfg.binary.sha256})`) : stop(`the program on chain is NOT the reviewed build: ${p.why}`)) && fine;
    fine = (p.authority === cfg.addr.vault ? ok('its upgrade authority is the vault') : stop(`its upgrade authority is ${p.authority ?? 'NONE'}, not the vault: hand it over first`)) && fine;
  }
  const exact = s.tiers?.filter((t) => t.state === 'exact').length ?? 0;
  const wrong = s.tiers?.filter((t) => t.state === 'wrong') ?? [];
  if (wrong.length) fine = stop(`a fee tier exists with other values (index ${wrong.map((t) => t.want.index).join(', ')}): someone made it outside this page. Stop and ask`);
  if (s.tiers && exact === s.tiers.length) return { action: 'done', lines: [...lines, { ok: true, w: 'ALREADY DONE: both fee tiers exist with the island split, owned by the vault, fund share to the Workshop' }] };
  if (exact > 0) fine = stop('only one of the two tiers exists: a proposal made outside this page did it. Stop and ask');
  const foreign = s.proposals?.filter((x) => x.live && x.touches && !x.ours) ?? [];
  for (const x of foreign) fine = stop(x.kind === 'vault'
    ? `proposal #${x.index} (${x.proposal.status}) touches the range program but is NOT this page's: never approve or execute it. ${x.proposal.status === 'Approved' ? 'Both members cancel it' : 'A member rejects it'} in the Squads app; then check again`
    : `proposal #${x.index} (${x.proposal.status}) is a ${x.kind === 'batch' ? 'batch' : 'kind of transaction'} this page cannot read inside: it could touch the range program. Stop and ask`);
  const mine = (s.proposals ?? []).filter((x) => x.ours && x.live);
  if (mine.length > 1) fine = stop(`two open tier proposals (#${mine.map((x) => x.index).join(', #')}): only one may ever execute. Stop and ask`);
  const member = s.member && s.ms?.members.find((m) => m.key === s.member);
  if (!s.member) return { action: null, lines: [...lines, { ok: false, w: 'connect a member wallet' }] };
  if (!member) return { action: null, lines: [...lines, { ok: false, w: `${s.member} is not a member of the multisig` }] };
  if (!fine) return { action: null, lines };
  const open = mine[0];
  if (!open) {
    if (!(member.mask & 1)) return { action: null, lines: [...lines, { ok: false, w: 'this member may not propose' }] };
    return { action: 'propose', lines: [...lines, { ok: true, w: `no tier proposal yet: #${s.ms.transactionIndex + 1} will be created, with your approval` }] };
  }
  const pr = open.proposal;
  const at = (t) => new Date(t * 1000).toISOString().replace('.000', '');
  const named = cfg.notice.notBefore != null;
  if (named && !noticeEnds(cfg, { start: 0 }).ok) return { action: null, lines: [...lines, { ok: false, w: noticeEnds(cfg, { start: 0 }).why }] };
  const whenFor = (n) => (!named ? `${cfg.notice.days} days after the notice`
    : noticeEnds(cfg, n).at > Date.parse(cfg.notice.notBefore) / 1000 ? 'when the notice went public, after the date it names' : 'the date the notice names');
  if (pr.status === 'Active') {
    if (pr.approved.includes(s.member)) return { action: null, lines: [...lines, { ok: true, w: `#${open.index} has your approval; the other member approves next` }] };
    if (!(member.mask & 2)) return { action: null, lines: [...lines, { ok: false, w: 'this member may not approve' }] };
    // The approval that starts the lock waits until the lock would end no sooner than the notice's
    // end: then the chain itself holds the execute until then, whatever tool is used.
    const n = noticeState(cfg, s.notice, s.clock);
    if (!n.ok) return { action: null, lines: [...lines, { ok: false, w: n.why }] };
    ok(n.words);
    if (!s.positionLink?.ok) return { action: null, lines: [...lines, { ok: false, w: s.positionLink?.why ?? 'the position link was not asked' }] };
    ok(s.positionLink.why);
    const ends = noticeEnds(cfg, n).at;
    const from = ends - s.ms.timeLock;
    if (s.clock < from) return { action: null, lines: [...lines, { ok: true, w: `#${open.index} waits for your approval from ${at(from)} by the network's clock, so that its ${lockWanted / 3600}-hour lock ends no sooner than ${whenFor(n)} (${at(ends)})` }] };
    return { action: 'approve', index: open.index, lines: [...lines, { ok: true, w: `#${open.index} is this page's proposal, waiting for your approval. Yours is the last one needed: it starts the ${lockWanted / 3600}-hour time lock` }] };
  }
  // Approved: the lock (the chain holds it), then the notice's end (this page holds it).
  if (pr.status !== 'Approved' || !Number.isFinite(pr.timestamp)) return { action: null, lines: [...lines, { ok: false, w: `#${open.index} is ${pr.status}, not Approved with an approval time: stop and ask` }] };
  const lockEnds = pr.timestamp + s.ms.timeLock;
  if (s.clock < lockEnds) return { action: null, lines: [...lines, { ok: true, w: `#${open.index} has both approvals. The time lock holds it until ${at(lockEnds)} by the network's clock` }] };
  ok(`approved at ${at(pr.timestamp)}; the time lock was over at ${at(lockEnds)}`);
  const n = noticeState(cfg, s.notice, s.clock);
  if (!n.ok) return { action: null, lines: [...lines, { ok: false, w: n.why }] };
  ok(n.words);
  if (!s.positionLink?.ok) return { action: null, lines: [...lines, { ok: false, w: s.positionLink?.why ?? 'the position link was not asked' }] };
  ok(s.positionLink.why);
  const ends = noticeEnds(cfg, n).at;
  if (s.clock < ends) return { action: null, lines: [...lines, { ok: true, w: `the tiers may execute from ${at(ends)} (${whenFor(n)}), by the network's clock` }] };
  ok(named ? `the fee notice is public and ${whenFor(n)} (${at(ends)}) has passed` : `the fee notice has been public for ${cfg.notice.days} days, without a gap`);
  return { action: 'execute', index: open.index, lines };
}

/** When the notice lets the tiers execute, in unix seconds. A notice counted in days ends `days`
 *  after it went public (n.start). A notice that names its own date (cfg.notice.notBefore, an ISO
 *  time in UTC: the owner's ruling of 2026-10-22) ends at that date, or when it went public if that
 *  came later: a notice cannot end before anyone could read it. */
export function noticeEnds(cfg, n) {
  const nb = cfg.notice.notBefore;
  if (nb == null) return { ok: true, at: n.start + cfg.notice.days * 86400 };
  // Strict: UTC with a Z, whole seconds, and it must read back unchanged (no 24:00, no Feb 30).
  if (typeof nb !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(nb) || !Number.isFinite(Date.parse(nb))
    || new Date(Date.parse(nb)).toISOString().replace('.000Z', 'Z') !== nb) {
    return { ok: false, why: `the date the notice names does not read as a time (${JSON.stringify(nb)}): stop and ask` };
  }
  return { ok: true, at: Math.max(n.start, Date.parse(nb) / 1000) };
}

/** The recorded notice (5-record-notice.mjs), checked: every time parses and is in order, the check
 *  is fresh and found the line on mvp-launch with no gap. The notice starts at the later of the
 *  first time it was seen public and the merge since which every commit has carried it. */
export function noticeState(cfg, rec, clock) {
  const no = (why) => ({ ok: false, why });
  if (!rec) return no('the fee notice has not been recorded: run 5-record-notice.mjs');
  if (rec.line !== cfg.notice.line) return no('the recorded notice is not this pack\'s line: run 5-record-notice.mjs');
  if (rec.live !== true) return no('at the last check the notice line was NOT on mvp-launch: stop and ask');
  const t = (x) => (typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(x) ? Date.parse(x) / 1000 : NaN);
  const seen = t(rec.seenAt); const since = t(rec.continuousSince); const checked = t(rec.checkedAt); const staged = t(cfg.stagedAt);
  if (![seen, since, checked, staged].every(Number.isFinite)) return no('the recorded notice has a time that does not read as a time: run 5-record-notice.mjs again');
  if (!(staged <= seen && seen <= checked && since <= checked + 300)) return no('the recorded notice\'s times are out of order (before this folder was staged, or after the check): stop and ask');
  if (checked > clock + 300) return no('the notice was checked at a time after the network\'s clock: stop and ask');
  if (clock - checked > 3600) return no('the notice was last checked more than an hour ago: run 5-record-notice.mjs again, then check again');
  const start = Math.max(seen, since);
  return { ok: true, start, words: `the fee notice is public on mvp-launch since ${new Date(start * 1000).toISOString().replace('.000', '')}, without a gap (checked ${rec.checkedAt})` };
}
