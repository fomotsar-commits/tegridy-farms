// Step 1 of a run: copy the mainnet accounts the local chain needs (read-only RPC calls; nothing
// is signed or sent), make the local test keys, and write the validator's account files.
//
// What differs from mainnet, and nothing else:
//   - the multisig's two member keys are local test keys, and its 172,800 s time lock is
//     LOCAL_TIME_LOCK seconds. Threshold, config authority, indexes and address are mainnet's,
//     so its vault 0 is the real vault address.
//   - BAYLA's mint authority is a local key until the suite has funded its test wallets; the
//     suite then removes it, as on mainnet. Every other byte of the mint is mainnet's.
// usage: node setup.mjs        (writes into CLMM_WORK)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey } from './lib/deps.mjs';
import { ADDR, WORK, MAINNET_RPC, LOCAL_TIME_LOCK, REPO } from './lib/config.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const rpc = async (method, params) => {
  for (let i = 0; ; i++) {
    const r = await fetch(MAINNET_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json().catch(() => null);
    if (j?.result !== undefined) return j.result;
    if (i === 4) throw new Error(`${method}: ${JSON.stringify(j?.error ?? r.status)}`);
    await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
  }
};

const LOADER_V3 = 'BPFLoaderUpgradeab1e11111111111111111111111';
const dirs = ['mainnet', 'local', 'keys'].map((d) => join(WORK, d));
dirs.forEach((d) => mkdirSync(d, { recursive: true }));
const manifest = { readFrom: MAINNET_RPC.replace(/\?.*$/, ''), readAt: new Date().toISOString(), accounts: {}, programs: {} };

async function accounts(keys) {
  const r = await rpc('getMultipleAccounts', [keys.map((k) => k.toBase58()), { encoding: 'base64', commitment: 'finalized' }]);
  return r.value.map((v, i) => {
    if (!v) throw new Error(`mainnet has no account ${keys[i].toBase58()}`);
    return { slot: r.context.slot, owner: v.owner, lamports: v.lamports, executable: v.executable, data: Buffer.from(v.data[0], 'base64') };
  });
}

/** A validator account file. rentEpoch is written as text: a JSON number would round u64::MAX. */
function accountFile(path, pubkey, a) {
  writeFileSync(path, `{"pubkey":"${pubkey}","account":{"lamports":${a.lamports},"data":["${a.data.toString('base64')}","base64"],` +
    `"owner":"${a.owner}","executable":${a.executable},"rentEpoch":18446744073709551615,"space":${a.data.length}}}\n`);
}

// Memo v3, as the crate the program compiles against names it (version from tegridy-clmm's Cargo.lock).
const lock = readFileSync(join(REPO, 'solana/tegridy-clmm/Cargo.lock'), 'utf-8');
const memoVer = /name = "spl-memo-interface"\nversion = "([^"]+)"/.exec(lock)[1];
const memoSrc = execFileSync('wsl', ['-e', 'bash', '-lc', `cat ~/.cargo/registry/src/*/spl-memo-interface-${memoVer}/src/lib.rs`]).toString();
ADDR.memo = new PublicKey(/pub mod v3 \{\s*solana_pubkey::declare_id!\("(\w+)"\)/.exec(memoSrc)[1]);

// 1. Plain accounts.
const names = { multisig: ADDR.multisig, vault: ADDR.vault, bayla: ADDR.bayla, wsol: ADDR.wsol, venuePool: ADDR.venuePoolBaylaSol };
const got = await accounts(Object.values(names));
const raw = Object.fromEntries(Object.keys(names).map((k, i) => [k, got[i]]));
for (const [k, a] of Object.entries(raw)) {
  manifest.accounts[k] = { address: names[k].toBase58(), slot: a.slot, owner: a.owner, lamports: a.lamports, bytes: a.data.length, sha256: sha256(a.data) };
  accountFile(join(WORK, 'mainnet', `${k}.json`), names[k].toBase58(), a);
}

// 2. Programs: the executable bytes, from the ProgramData account for upgradeable ones.
const programIds = { squads: ADDR.squads, token2022: ADDR.token2022, token: ADDR.token, ata: ADDR.ata, memo: ADDR.memo, metaplex: ADDR.metaplex };
const progs = await accounts(Object.values(programIds));
for (const [i, [k, id]] of Object.entries(programIds).entries()) {
  const p = progs[i];
  let elf = p.data;
  let slot = null;
  if (p.owner === LOADER_V3) {
    const pd = new PublicKey(p.data.subarray(4, 36));
    const [d] = await accounts([pd]);
    slot = Number(d.data.readBigUInt64LE(4));
    elf = d.data.subarray(45);
    // An upgradeable program's account is padded past its ELF; the loader reads the ELF header only.
  }
  writeFileSync(join(WORK, 'mainnet', `${k}.so`), elf);
  manifest.programs[k] = { address: id.toBase58(), owner: p.owner, lastDeploySlot: slot, bytes: elf.length, sha256: sha256(elf) };
}

// Squads' own published interface (its Anchor IDL account), for encoding its instructions.
{
  const [base] = PublicKey.findProgramAddressSync([], ADDR.squads);
  const idlAddr = await PublicKey.createWithSeed(base, 'anchor:idl', ADDR.squads);
  const [a] = await accounts([idlAddr]);
  const { inflateSync } = await import('node:zlib');
  const json = inflateSync(a.data.subarray(44, 44 + a.data.readUInt32LE(40))).toString();
  writeFileSync(join(WORK, 'mainnet', 'squads.idl.json'), json);
  manifest.accounts.squadsIdl = { address: idlAddr.toBase58(), slot: a.slot, sha256: sha256(Buffer.from(json)) };
}

// 3. The vault really is vault 0 of the multisig, and the multisig is what the registry says.
const ms = raw.multisig.data;
const [vault0] = PublicKey.findProgramAddressSync([Buffer.from('multisig'), ADDR.multisig.toBuffer(), Buffer.from('vault'), Buffer.from([0])], ADDR.squads);
if (!vault0.equals(ADDR.vault)) throw new Error('vault 0 of the registry multisig is not the registry vault');
if (raw.multisig.owner !== ADDR.squads.toBase58()) throw new Error('multisig is not owned by Squads');
if (raw.bayla.owner !== ADDR.token2022.toBase58()) throw new Error('BAYLA is not a Token-2022 mint');
const multisig = {
  threshold: ms.readUInt16LE(72), timeLock: ms.readUInt32LE(74),
  transactionIndex: Number(ms.readBigUInt64LE(78)), staleIndex: Number(ms.readBigUInt64LE(86)),
  configAuthority: new PublicKey(ms.subarray(40, 72)).toBase58(),
};
const rcTag = ms[94];
const membersAt = 94 + (rcTag ? 33 : 1) + 1;
multisig.members = ms.readUInt32LE(membersAt);
manifest.multisigOnMainnet = multisig;

// 4. Local keys: the two members, BAYLA's temporary mint authority, and the test wallets.
const keys = {};
for (const k of ['memberA', 'memberB', 'outsider', 'baylaMintAuthority', 'alice', 'bob', 'carol', 'dave', 'erin', 'mallory', 'rewardMintAuthority', 'usdMintAuthority', 'workshopStandIn']) {
  const kp = Keypair.generate();
  keys[k] = kp.publicKey.toBase58();
  writeFileSync(join(WORK, 'keys', `${k}.json`), JSON.stringify([...kp.secretKey]));
}

// 5. The local multisig: mainnet's bytes, members swapped (sorted, as Squads stores them), lock shortened.
{
  const local = Buffer.from(ms);
  const members = [keys.memberA, keys.memberB].map((k) => new PublicKey(k).toBuffer()).sort(Buffer.compare);
  if (multisig.members !== 2) throw new Error('mainnet multisig has ' + multisig.members + ' members; this harness swaps exactly two');
  members.forEach((m, i) => {
    const at = membersAt + 4 + i * 33;
    m.copy(local, at);
    local[at + 32] = ms[at + 32]; // keep each member's permission mask as on mainnet
  });
  local.writeUInt32LE(LOCAL_TIME_LOCK, 74);
  // A mutant run may lower the threshold (CLMM_THRESHOLD=1) to prove the two-approval check can fail.
  if (process.env.CLMM_THRESHOLD) local.writeUInt16LE(Number(process.env.CLMM_THRESHOLD), 72);
  accountFile(join(WORK, 'local', 'multisig.json'), ADDR.multisig.toBase58(), { ...raw.multisig, data: local });
  // The same copy with mainnet's own lock, for the check that a real lock refuses an early execute.
  const real = Buffer.from(local); real.writeUInt32LE(multisig.timeLock, 74);
  accountFile(join(WORK, 'local', 'multisig-real-lock.json'), ADDR.multisig.toBase58(), { ...raw.multisig, data: real });
}

// 6. BAYLA: mainnet's mint with a local mint authority (COption: u32 tag 1, then the key).
{
  const local = Buffer.from(raw.bayla.data);
  manifest.baylaOnMainnet = { mintAuthorityTag: local.readUInt32LE(0), freezeAuthorityTag: local.readUInt32LE(46), decimals: local[44], supply: local.readBigUInt64LE(36).toString() };
  local.writeUInt32LE(1, 0);
  new PublicKey(keys.baylaMintAuthority).toBuffer().copy(local, 4);
  accountFile(join(WORK, 'local', 'bayla.json'), ADDR.bayla.toBase58(), { ...raw.bayla, data: local });
}

// 7. Today's BAYLA price from the venue's cp-swap BAYLA/SOL pool (vault and mint fields of its
//    PoolState), only to open the local range pool at a realistic price.
{
  const d = raw.venuePool.data;
  const at = (o) => new PublicKey(d.subarray(o, o + 32));
  const [v0, v1, m0] = [at(72), at(104), at(168)];
  const bal = async (k) => BigInt((await rpc('getTokenAccountBalance', [k.toBase58(), { commitment: 'finalized' }])).value.amount);
  const [b0, b1] = [await bal(v0), await bal(v1)];
  const [bayla, sol] = m0.equals(ADDR.bayla) ? [b0, b1] : [b1, b0];
  manifest.venuePrice = { pool: ADDR.venuePoolBaylaSol.toBase58(), baylaBase: bayla.toString(), lamports: sol.toString(), solPerBayla: (Number(sol) / 1e9) / (Number(bayla) / 1e6) };
}

// 8. Mainnet's rent today: the cost of an empty account and of 1,000 bytes more.
{
  const r0 = await rpc('getMinimumBalanceForRentExemption', [0]);
  const r1 = await rpc('getMinimumBalanceForRentExemption', [1000]);
  manifest.mainnetRent = { emptyAccount: r0, perByte: (r1 - r0) / 1000, overheadBytes: r0 / ((r1 - r0) / 1000) };
}

manifest.localKeys = keys;
manifest.addresses = Object.fromEntries(Object.entries(ADDR).map(([k, v]) => [k, v.toBase58()]));
manifest.localTimeLock = LOCAL_TIME_LOCK;
writeFileSync(join(WORK, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`setup: mainnet slot ${manifest.accounts.multisig.slot}, BAYLA ${manifest.venuePrice.solPerBayla.toExponential(4)} SOL, lock ${LOCAL_TIME_LOCK} s, rent ${manifest.mainnetRent.perByte}/byte on mainnet`);
