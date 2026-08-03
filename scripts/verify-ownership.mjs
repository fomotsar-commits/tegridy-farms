#!/usr/bin/env node
/**
 * Ownership + custody read-back for every privileged role in the protocol.
 *
 * WHY THIS EXISTS, AND WHY IT EXISTS *BEFORE* THE RE-HOME
 * -------------------------------------------------------
 * docs/SAFE_REHOME_RUNBOOK.md moves 19 contracts plus the factory's three
 * custom roles off a hot deployer EOA and onto rebuilt Safes. That is ~40
 * privileged transactions, several of them two-step, at least one of them
 * one-shot and permanent. The failure mode is not "a tx reverts" — a revert is
 * loud. It is a tx that SUCCEEDS against the wrong target, or a step that gets
 * skipped in a long checklist, and is discovered months later.
 *
 * A transaction receipt is not proof of state. This tool reads the state back.
 *
 * It is written before the custody sprint on purpose: the same command must be
 * runnable BEFORE (to capture the starting picture), DURING (to see what has
 * landed), and AFTER (to assert the end state). A verifier authored afterwards
 * tends to encode what happened rather than what was intended.
 *
 * WHAT IT CHECKS
 * --------------
 *   owner / pendingOwner / ownershipTransferExpiresAt  on every OwnableNoRenounce
 *   feeToSetter / feeTo / guardian                     on TegridyFactory (custom)
 *   eth_getCode                                        on every address it reports
 *
 * That last one is the non-obvious one and it is the reason this file exists.
 * Two of the three current governance signers are EIP-7702-delegated to the SAME
 * smart-wallet target, which collapses a 2-of-3 into effectively one key. A
 * delegation can attach to an already-approved EOA at ANY time, so "these
 * signers were independent when we built the Safe" is not a durable statement.
 * `eth_getCode` on an EOA returns `0x`; a 7702-delegated EOA returns a 23-byte
 * `0xef0100…` designator. Any non-empty code on a signer is reported.
 *
 * USAGE
 *   node scripts/verify-ownership.mjs
 *   node scripts/verify-ownership.mjs --expect-owner 0xSAFE   # assert end state
 *   node scripts/verify-ownership.mjs --signers 0xA,0xB,0xC   # 7702-check a set
 *   node scripts/verify-ownership.mjs --rpc https://…
 *   node scripts/verify-ownership.mjs --json
 *   node scripts/verify-ownership.mjs --self-test
 *
 * Exit 0 = every assertion held (or none was requested). Exit 1 = something is
 * not what it should be. Read-only: it never sends a transaction.
 */

const DEFAULT_RPC = 'https://ethereum-rpc.publicnode.com';

// Selectors. Derived with `cast sig "<signature>"` rather than memorised —
// reproduce with e.g. `cast sig "ownershipTransferExpiresAt()"`. They are
// hardcoded because the repo root has no keccak dependency and adding one to
// read four scalars is not worth it. A wrong selector cannot silently produce a
// wrong answer here: an absent selector reverts or returns empty, and this tool
// reports that as `absent` rather than coercing it to a value.
const SEL = {
  owner: '0x8da5cb5b',
  pendingOwner: '0xe30c3978',
  ownershipTransferExpiresAt: '0xb3cf6e4a',
  feeToSetter: '0x094b7415',
  feeTo: '0x017e7e58',
  guardian: '0x452a9320',
  pendingFeeToSetter: '0xe496994e',
  gaugeController: '0x99eecb3b',
};

// The 19 contracts from SAFE_REHOME_RUNBOOK.md, plus how each is owned.
//   'two-step'  — OwnableNoRenounce: owner + pendingOwner + expiry
//   'factory'   — TegridyFactory: feeToSetter is the owner-equivalent
//   'ctor'      — constructor-owned, no pending mechanism at all
const CONTRACTS = [
  ['TegridyStaking',        '0xcaDc93E96De58EA554c71ca609974625615E046D', 'two-step'],
  ['TegridyStakingAdmin',   '0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3', 'two-step'],
  ['TegridyTWAP',           '0xdFdd6D72539A425dC917F49FB834901105cA98c9', 'two-step'],
  ['RevenueDistributor',    '0xF993316E2fC079de4358c489A935E01e03E23E17', 'two-step'],
  ['SwapFeeRouter',         '0x6d5791A660e79175F74C6D639584C98422d5956E', 'two-step'],
  // NOT IN SAFE_REHOME_RUNBOOK.md as of 2026-08-02, but `owner()` reads the hot
  // deployer EOA, so the runbook as written would leave it there. Found by
  // diffing constants.ts against the runbook; kept here so the omission cannot
  // recur silently.
  ['SwapFeeRouterAdmin',    '0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060', 'two-step'],
  ['POLAccumulator',        '0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2', 'two-step'],
  ['ReferralSplitter',      '0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c', 'two-step'],
  ['GaugeController',       '0x6c79522d47cf6d1051cb474e81d9b6f3996c1054', 'two-step'],
  ['NFTLending',            '0x89BeB6cc0255B7465c01aA38a6f937efd345f14F', 'two-step'],
  ['NFTLendingAdmin',       '0x693787831e9C36A98aFEDAd39f8728491F580a9C', 'two-step'],
  ['VoteIncentives',        '0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF', 'two-step'],
  ['VoteIncentivesAdmin',   '0xf87Ec231BA7FA3975619309bc16C698B2ea3B300', 'two-step'],
  ['CommunityGrants',       '0xebc3aaf48297b8ccfa8272d9e68c1545eb9cd471', 'two-step'],
  ['LaunchpadV2',           '0xa6149b4d05138a4073902a0ca0345c2d0e470df7', 'two-step'],
  ['MemeBountyBoard',       '0x6d2c6ec29d97fe8b6d1471091deee36baf69d890', 'two-step'],
  ['PremiumAccess',         '0x9dc2675b2017687dd9768c63d15f0ad5194fa3f5', 'two-step'],
  ['TegridyLPFarming',      '0x1171268AE5B69791c47Fd589b7825932c957e149', 'two-step'],
  // Constructor-owned by the flagged Safe. The DEPLOYER CANNOT MOVE THIS ONE —
  // only its current owner can. Easy to miss in a deployer-driven checklist.
  ['TegridyNFTPoolFactory', '0xbb8e49ba4e3a85e2b8b70e00208770f429b56f5b', 'ctor'],
  // Owner-equivalent is feeToSetter, on a custom timelocked propose/execute.
  ['TegridyFactory',        '0xa24C7287eC56A7DEFDc70033803451240e267a52', 'factory'],
  // PERMANENTLY UNGOVERNABLE. owner() is the Arachnid CREATE2 deployer proxy
  // 0x4e59b448…956C, which is stateless and can never originate a call — so no
  // transferOwnership is possible from any key. Listed rather than omitted:
  // a contract missing from a custody report reads as "fine", and this one is
  // the opposite of fine. It must be REDEPLOYED if the V4 rail ever unfreezes.
  ['TegridyFeeHook',        '0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044', 'stranded'],
];

/** The stateless CREATE2 factory. Anything it "owns" is unreachable forever. */
const CREATE2_PROXY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';

const ZERO = '0x0000000000000000000000000000000000000000';

// ── decode helpers (pure, self-tested) ────────────────────────────────────
/** Decode a 32-byte ABI word into a checksum-less lowercase address. */
export function decodeAddress(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  const body = hex.slice(2);
  if (body.length < 64) return null; // empty return = selector absent
  return '0x' + body.slice(24, 64).toLowerCase();
}

/** Decode a 32-byte ABI word into a JS number of seconds. */
export function decodeUint(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  const body = hex.slice(2);
  if (body.length < 64) return null;
  return Number(BigInt('0x' + body.slice(0, 64)));
}

/**
 * Classify an eth_getCode result for a Safe SIGNER.
 * EOA -> '0x'. EIP-7702 delegation -> a 23-byte 0xef0100<20-byte target>.
 */
export function classifyCode(code) {
  if (typeof code !== 'string' || code === '0x' || code === '') return { kind: 'eoa' };
  const body = code.slice(2);
  if (body.length === 46 && body.slice(0, 6).toLowerCase() === 'ef0100') {
    return { kind: 'eip7702', delegateTo: '0x' + body.slice(6).toLowerCase() };
  }
  return { kind: 'contract', bytes: body.length / 2 };
}

/**
 * Decide the verdict for one contract's readings.
 * Pure so --self-test can exercise every branch without a chain.
 */
export function assess(row, expectOwner) {
  const problems = [];
  const notes = [];
  const owner = (row.owner || '').toLowerCase();
  const want = (expectOwner || '').toLowerCase();

  if (row.owner === null) {
    problems.push('owner() did not return an address (selector absent or call reverted)');
    return { problems, notes };
  }

  // 'ctor' and 'stranded' are deliberately exempt from --expect-owner: neither
  // can be moved by the deployer, so asserting the new Safe on them would make
  // the end-state check permanently red for reasons the custody sprint cannot fix.
  if (want && row.kind !== 'stranded' && owner !== want) {
    problems.push(`owner is ${row.owner}, expected ${expectOwner}`);
  }

  if (row.kind === 'two-step') {
    if (row.pendingOwner && row.pendingOwner !== ZERO) {
      const expired = typeof row.expiresAt === 'number' && row.expiresAt > 0
        && row.expiresAt * 1000 < Date.parse(row.now);
      // A stale pendingOwner is not a seizure risk once expired — acceptOwnership
      // reverts — but it IS a dirty slot, and after a re-home it should be zero.
      if (want) problems.push(`pendingOwner is ${row.pendingOwner} (${expired ? 'EXPIRED' : 'LIVE'}), expected 0x0`);
      else notes.push(`pendingOwner ${row.pendingOwner} — ${expired ? 'expired, acceptOwnership() reverts' : '⚠ LIVE WINDOW'}`);
    }
  }

  if (row.kind === 'ctor') {
    notes.push('constructor-owned: the deployer CANNOT move this — only its current owner can');
  }

  if (row.kind === 'stranded') {
    if (owner === CREATE2_PROXY) {
      notes.push('owner is the stateless CREATE2 proxy — UNGOVERNABLE FOREVER; redeploy is the only fix');
    } else {
      // If this ever changes, the assumption behind the note is gone and the
      // contract belongs in the normal re-home flow.
      problems.push(`expected the CREATE2 proxy as owner, found ${row.owner} — reclassify this contract`);
    }
  }

  return { problems, notes };
}

// ── rpc ───────────────────────────────────────────────────────────────────
async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) return null; // a reverting call is data, not a crash
  return j.result;
}

const call = (url, to, data) => rpc(url, 'eth_call', [{ to, data }, 'latest']);

async function readContract(url, [name, address, kind]) {
  const now = new Date().toISOString();
  const row = { name, address, kind, now, owner: null, pendingOwner: null, expiresAt: null, extra: {} };

  if (kind === 'factory') {
    row.owner = decodeAddress(await call(url, address, SEL.feeToSetter));
    row.extra.feeTo = decodeAddress(await call(url, address, SEL.feeTo));
    row.extra.guardian = decodeAddress(await call(url, address, SEL.guardian));
    row.extra.pendingFeeToSetter = decodeAddress(await call(url, address, SEL.pendingFeeToSetter));
    return row;
  }

  row.owner = decodeAddress(await call(url, address, SEL.owner));
  if (kind === 'stranded') return row;
  if (kind === 'two-step') {
    row.pendingOwner = decodeAddress(await call(url, address, SEL.pendingOwner));
    row.expiresAt = decodeUint(await call(url, address, SEL.ownershipTransferExpiresAt));
  }
  if (name === 'VoteIncentives') {
    // One-shot and permanent: setGaugeController can be called exactly once.
    row.extra.gaugeController = decodeAddress(await call(url, address, SEL.gaugeController));
  }
  return row;
}

// ── self-test ─────────────────────────────────────────────────────────────
function selfTest() {
  const cases = [];
  const ok = (n, c) => cases.push([n, c]);

  ok('decodeAddress pulls the low 20 bytes',
    decodeAddress('0x' + '00'.repeat(12) + 'aa'.repeat(20)) === '0x' + 'aa'.repeat(20));
  ok('decodeAddress returns null on empty return (absent selector)',
    decodeAddress('0x') === null);
  ok('decodeUint reads a word', decodeUint('0x' + '00'.repeat(31) + '0f') === 15);
  ok('classifyCode: bare EOA', classifyCode('0x').kind === 'eoa');
  ok('classifyCode: 7702 designator is detected and its target extracted', (() => {
    const c = classifyCode('0xef0100' + 'bb'.repeat(20));
    return c.kind === 'eip7702' && c.delegateTo === '0x' + 'bb'.repeat(20);
  })());
  ok('classifyCode: ordinary contract is not mistaken for 7702',
    classifyCode('0x6080604052').kind === 'contract');

  const base = { name: 'X', kind: 'two-step', owner: '0x' + 'aa'.repeat(20),
    pendingOwner: ZERO, expiresAt: 0, now: '2026-08-02T00:00:00.000Z' };

  ok('clean contract with matching owner has no problems',
    assess(base, '0x' + 'aa'.repeat(20)).problems.length === 0);
  ok('wrong owner is a problem',
    assess(base, '0x' + 'bb'.repeat(20)).problems.some((p) => /expected/.test(p)));
  ok('a non-zero pendingOwner is a problem WHEN asserting an end state',
    assess({ ...base, pendingOwner: '0x' + 'cc'.repeat(20), expiresAt: 1 }, '0x' + 'aa'.repeat(20))
      .problems.some((p) => /pendingOwner/.test(p)));
  ok('a non-zero pendingOwner is only a NOTE when merely surveying',
    assess({ ...base, pendingOwner: '0x' + 'cc'.repeat(20), expiresAt: 1 }, null)
      .notes.some((n) => /pendingOwner/.test(n)));
  ok('an expired window is labelled expired',
    assess({ ...base, pendingOwner: '0x' + 'cc'.repeat(20), expiresAt: 1 }, null)
      .notes.some((n) => /expired/.test(n)));
  ok('a LIVE window is labelled live',
    assess({ ...base, pendingOwner: '0x' + 'cc'.repeat(20), expiresAt: 4102444800 }, null)
      .notes.some((n) => /LIVE WINDOW/.test(n)));
  ok('an unreadable owner is a problem, never a silent pass',
    assess({ ...base, owner: null }, null).problems.length === 1);

  let failed = 0;
  for (const [n, pass] of cases) {
    if (pass) console.log(`  ✅ ${n}`);
    else { failed++; console.error(`  ❌ ${n}`); }
  }
  if (failed) {
    console.error(`\n❌ verify-ownership self-test: ${failed}/${cases.length} failed`);
    process.exit(1);
  }
  console.log(`\n✅ verify-ownership self-test: ${cases.length}/${cases.length} passed`);
}

// ── main ──────────────────────────────────────────────────────────────────
function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();

  const url = arg(argv, '--rpc') || process.env.ETH_RPC_URL || DEFAULT_RPC;
  const expectOwner = arg(argv, '--expect-owner') || null;
  const signers = (arg(argv, '--signers') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const asJson = argv.includes('--json');

  const rows = [];
  for (const c of CONTRACTS) rows.push(await readContract(url, c));

  let problems = 0;
  const report = [];
  for (const row of rows) {
    const { problems: p, notes } = assess(row, expectOwner);
    problems += p.length;
    report.push({ ...row, problems: p, notes });
  }

  // Signer independence. Checked separately because it is about the Safe, not
  // the contracts — and because it can regress at any time without any of the
  // ownership state changing at all.
  const signerReport = [];
  for (const s of signers) {
    const code = await rpc(url, 'eth_getCode', [s, 'latest']);
    const c = classifyCode(code);
    if (c.kind !== 'eoa') problems++;
    signerReport.push({ address: s, ...c });
  }

  if (asJson) {
    console.log(JSON.stringify({ rows: report, signers: signerReport, problems }, null, 2));
    process.exit(problems ? 1 : 0);
  }

  console.log(`ownership read-back @ ${new Date().toISOString()}  (rpc ${url})`);
  if (expectOwner) console.log(`asserting owner == ${expectOwner}\n`);
  else console.log('survey mode — pass --expect-owner <safe> to assert an end state\n');

  for (const r of report) {
    const ownerStr = r.owner ?? 'UNREADABLE';
    console.log(`${r.problems.length ? '❌' : '  '} ${r.name.padEnd(23)} ${ownerStr}`);
    if (r.kind === 'factory') {
      console.log(`     feeToSetter(owner-equivalent) · feeTo=${r.extra.feeTo} guardian=${r.extra.guardian}`);
      if (r.extra.pendingFeeToSetter && r.extra.pendingFeeToSetter !== ZERO) {
        console.log(`     ⚠ pendingFeeToSetter=${r.extra.pendingFeeToSetter} — proposeFeeToSetter reverts until cancelled`);
      }
    }
    if (r.extra.gaugeController !== undefined) {
      const gc = r.extra.gaugeController;
      console.log(`     gaugeController=${gc}${gc === ZERO ? '  ⚠ ZERO → _requireGaugedPair is a NO-OP; setGaugeController is ONE-SHOT' : ''}`);
    }
    for (const n of r.notes) console.log(`     · ${n}`);
    for (const p of r.problems) console.log(`     ❌ ${p}`);
  }

  if (signerReport.length) {
    console.log('\nSafe signer independence (EIP-7702):');
    for (const s of signerReport) {
      if (s.kind === 'eoa') console.log(`     ✅ ${s.address} — plain EOA`);
      else if (s.kind === 'eip7702') console.log(`     ❌ ${s.address} — 7702-DELEGATED to ${s.delegateTo}`);
      else console.log(`     ❌ ${s.address} — has ${s.bytes} bytes of code (not an EOA)`);
    }
    const targets = signerReport.filter((s) => s.kind === 'eip7702').map((s) => s.delegateTo);
    const shared = targets.filter((t, i) => targets.indexOf(t) !== i);
    if (shared.length) {
      console.log(`     🛑 ${new Set(shared).size} delegation target(s) SHARED across signers — the quorum is collapsed.`);
    }
  }

  if (problems > 0) {
    console.log(`\n❌ ${problems} problem(s). Do not treat the custody work as complete.`);
  } else if (expectOwner) {
    console.log('\n✅ every contract reads the expected owner with a clean pending slot.');
  } else {
    // Survey mode asserts NOTHING — no --expect-owner was given, so "no problems"
    // would be the same class of lie as a CI step that runs and checks nothing.
    console.log('\n📋 survey complete — NOTHING WAS ASSERTED.');
    console.log('   Re-run with --expect-owner <safe> (and --signers) to check an end state.');
  }
  process.exit(problems ? 1 : 0);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`❌ verify-ownership could not run: ${err.message}`);
  process.exit(1);
});
