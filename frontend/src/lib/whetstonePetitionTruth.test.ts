// OUTBOUND-PETITION TRUTH GUARD.
//
// Third sibling to `docsClaimHonesty.test.ts` (what the docs may not SAY about revenue)
// and `docsReconciliation.test.ts` (what they may not say about STATUS). This one guards
// the narrower and more dangerous case: a document written to be **handed to somebody
// outside this repository**, whose factual claims are about Solidity in this repository.
//
// The failure it exists to prevent already happened once and was caught before the send.
// `docs/WHETSTONE_MIGRATOR_PETITION.md` cited an on-chain 5%-protocol-owner floor as
// implemented, told the reader to go read it on a named branch, and that branch's tip did
// not contain `PROTOCOL_OWNER_MIN_SHARES`. The same document simultaneously listed the
// floor as "not started" in its own open-items section. Three defect classes in one file:
//
//   1. A CLAIM ABOUT SOURCE that the source does not support. The reader can check this in
//      one grep, so being wrong costs the whole document's credibility, not just the line.
//   2. A POINTER TO A TREE. A branch name is mutable and a commit hash is unverifiable by
//      the recipient without our cooperation. Neither belongs in an outbound document;
//      a file path plus a reproducible grep does the same job and cannot rot.
//   3. TWO SECTIONS DISAGREEING. A reader resolves an internal contradiction against the
//      author, always.
//
// So the assertions below are of exactly two kinds, and deliberately no others:
//
//   • RECONCILIATION — every quantity, identifier and count the petition states about our
//     Solidity is re-derived from `contracts/` here. If the code changes and the document
//     does not, this fails. That is the point: the document is only allowed to be right.
//   • SHAPE BANS — no branch/commit pointer; no "already deployed" or "already whitelisted"
//     reading of an ask that is explicitly a request to whitelist ON DEPLOY; no claim that
//     the LP is burned or irreversible, because it is time-locked in a locker we wrote.
//
// The decision record (`docs/GRADUATION_VENUE_DECISION.md`) is held to the same
// reconciliation, because its whole argument for the chosen venue is "already written and
// tested" — a claim made of counts, which decay.
//
// Nothing here asserts anything about chain state. The petition's on-chain reads date to
// 2026-07-31 and cannot be re-read offline; what IS asserted is that the document still
// tells its own operator to re-run them before sending.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, 'README.md')) && existsSync(join(d, 'docs'))) return d;
    d = dirname(d);
  }
  throw new Error('could not locate the repo root from ' + import.meta.url);
}

const ROOT = repoRoot();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const PETITION_REL = 'docs/WHETSTONE_MIGRATOR_PETITION.md';
const DECISION_REL = 'docs/GRADUATION_VENUE_DECISION.md';

const PETITION = read('docs', 'WHETSTONE_MIGRATOR_PETITION.md');
const DECISION = read('docs', 'GRADUATION_VENUE_DECISION.md');
const HANDOFF = read('contracts', 'V4_AUDIT_HANDOFF.md');

const MIGRATOR_SRC = read('contracts', 'src', 'v4', 'TegridyLiquidityMigrator.sol');
const MIGRATOR_TEST = read('contracts', 'test', 'v4', 'TegridyLiquidityMigrator.t.sol');
const LOCKER_TEST = read('contracts', 'test', 'v4', 'TegridyFeeLocker.t.sol');
const HOOK_TEST = read('contracts', 'test', 'v4', 'TegridyV4Hook.t.sol');
const DEPLOY_SCRIPT = read('contracts', 'script', 'DeployV4.s.sol');
const HOOK_ADMIN_SRC = read('contracts', 'src', 'v4', 'TegridyV4HookAdmin.sol');
const LAUNCHER_CONSTANTS = read('frontend', 'src', 'lib', 'launcher', 'constants.ts');

/** Foundry test functions in a `.t.sol`, counted the way the docs claim to count them. */
function forgeTestCount(src: string): number {
  return (src.match(/^ {4}function test/gm) ?? []).length;
}

/** Reads `uintNN internal|public constant NAME = 1_234;` out of a Solidity source. */
function solConstant(src: string, name: string): number {
  const m = src.match(new RegExp(`constant\\s+${name}\\s*=\\s*([0-9_]+)`));
  if (!m) throw new Error(`no constant ${name}`);
  return Number(m[1].replace(/_/g, ''));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The claim the whole petition rests on
// ─────────────────────────────────────────────────────────────────────────────

describe('the petition never claims a fix the source does not contain', () => {
  // If this pair ever disagrees, the petition is the thing that is wrong. The migrator
  // has no setter for the floor, so the only honest way to change the number is a new
  // deploy — and a new deploy means a new whitelist request.
  it('the 5% floor is really implemented, with the constant the petition names', () => {
    expect(
      MIGRATOR_SRC,
      'PROTOCOL_OWNER_MIN_SHARES is gone from the migrator — the petition claims it is there',
    ).toMatch(/uint96\s+public\s+constant\s+PROTOCOL_OWNER_MIN_SHARES\s*=\s*5e16\s*;/);
    expect(PETITION).toContain('PROTOCOL_OWNER_MIN_SHARES');
    expect(PETITION, 'the petition must state the floor value it enforces').toContain('5e16');
  });

  it('both error selectors the petition promises are parity with Doppler still exist', () => {
    for (const sig of [
      'error InvalidProtocolOwnerBeneficiary();',
      'error InvalidProtocolOwnerShares(uint96 expected, uint96 actual);',
    ]) {
      expect(MIGRATOR_SRC, `${sig} is gone`).toContain(sig);
    }
    expect(PETITION).toContain('InvalidProtocolOwnerBeneficiary');
    expect(PETITION).toContain('InvalidProtocolOwnerShares');
  });

  it('the owner is still read LIVE, which is the property the petition argues from', () => {
    // A pinned copy would turn a Safe rotation into a revert on every graduation. The
    // petition tells Whetstone we read live; a refactor to an immutable would make that
    // sentence false without touching the constant above.
    expect(MIGRATOR_SRC, 'the live Airlock.owner() read is gone').toMatch(
      /IAirlockOwner\(airlock\)\.owner\(\)/,
    );
    expect(PETITION).toMatch(/read\s+(?:it\s+)?live|reads?\s+`?Airlock\.owner\(\)`?\s+\*{0,2}live/i);
  });

  it('duplicate beneficiary entries are still summed, not first-match', () => {
    // `break` on first match would under-count the owner's real take and reject a list
    // Doppler itself accepts. The petition states the summing behaviour explicitly.
    const floorBlock = MIGRATOR_SRC.slice(MIGRATOR_SRC.indexOf('PROTOCOL_OWNER_MIN_SHARES'));
    expect(floorBlock, 'shares are no longer accumulated across duplicate entries').toMatch(
      /ownerShares\s*\+=/,
    );
  });

  it('every floor test the petition names by name still exists', () => {
    const named = [
      'test_initialize_rejectsAConstitutionThatOmitsTheProtocolOwner',
      'test_initialize_rejectsAProtocolOwnerShareBelowTheFloor',
      'test_initialize_acceptsExactlyTheFloor',
      'test_initialize_sumsDuplicateProtocolOwnerEntries',
      'test_initialize_followsAnAirlockOwnerRotation',
    ];
    for (const t of named) {
      expect(PETITION, `the petition stopped naming ${t}`).toContain(t);
      expect(MIGRATOR_TEST, `${t} is named in the petition but not in the test file`).toContain(t);
    }
    // The below-floor test is the one that proves the revert ARGS, not just the selector.
    expect(MIGRATOR_TEST).toMatch(/uint96\(5e16\),\s*uint96\(4e16\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Counts. The decision record's entire argument is made of these.
// ─────────────────────────────────────────────────────────────────────────────

describe('the test counts quoted to outsiders are the real ones', () => {
  const counts = {
    migrator: forgeTestCount(MIGRATOR_TEST),
    locker: forgeTestCount(LOCKER_TEST),
    hook: forgeTestCount(HOOK_TEST),
  };

  it('the counter itself finds tests — a zero would satisfy nothing below honestly', () => {
    expect(counts.migrator).toBeGreaterThan(10);
    expect(counts.locker).toBeGreaterThan(10);
    expect(counts.hook).toBeGreaterThan(10);
  });

  // ANCHORED, not `\b<n>\b` anywhere in the file. A bare-number search is satisfied by any
  // incidental occurrence — a heading, a block number, a line reference — so it passes a
  // mutation that changes the sentence actually making the claim. Each assertion below
  // pins the number to the phrase that asserts it about that specific file.
  it('the petition\'s coverage table states each real count against its own file', () => {
    for (const [file, n] of [
      ['TegridyLiquidityMigrator', counts.migrator],
      ['TegridyFeeLocker', counts.locker],
      ['TegridyV4Hook', counts.hook],
    ] as const) {
      expect(
        PETITION,
        `${PETITION_REL} does not state ${n} against ${file}.t.sol; a stale count is how ` +
          '"already tested" becomes an unbacked claim',
      ).toMatch(new RegExp(String.raw`${file}\.t\.sol\`?\s*\|\s*\*\*${n}\*\*`));
    }
  });

  it('the decision record states the total AND its own breakdown in one clause', () => {
    const total = counts.migrator + counts.locker + counts.hook;
    expect(
      DECISION,
      `${DECISION_REL} must state ${total} with the ${counts.migrator}/${counts.locker}/` +
        `${counts.hook} breakdown in the same clause — the "already tested" argument is ` +
        'made entirely of these numbers',
    ).toMatch(
      new RegExp(
        String.raw`\*\*${total}\*\*[^|\n]*${counts.migrator} migrator, ${counts.locker} locker, ${counts.hook} hook`,
      ),
    );
  });

  it('the audit handoff states each count in BOTH places it states one', () => {
    // The handoff quotes every count twice — once as the `forge test` command an auditor
    // runs, once in the coverage section. An alternation would let one drift while the
    // other stayed right, which is the worse failure: the auditor runs the command and
    // sees a different number from the document that sent them.
    for (const [contract, n] of [
      ['TegridyLiquidityMigrator', counts.migrator],
      ['TegridyFeeLocker', counts.locker],
      ['TegridyV4Hook', counts.hook],
    ] as const) {
      expect(
        HANDOFF,
        `the runnable command for ${contract} does not say ${n} tests`,
      ).toMatch(new RegExp(String.raw`--match-contract ${contract}\w*\s*#\s*${n} tests`));
      expect(
        HANDOFF,
        `§8 does not state ${n} tests for ${contract}`,
      ).toMatch(
        new RegExp(String.raw`\*\*${n} tests\*\*\s*\(\`test/v4/${contract}\.t\.sol\`\)`),
      );
    }
  });

  it('exactly one ILiquidityMigrator implementation exists, as the decision record claims', () => {
    // The decision's comparison table says Shape B has ZERO implementations. A second
    // migrator appearing means Shape B stopped being hypothetical and the decision needs
    // re-running, not re-reading — which is what the record itself says.
    const impls = ['TegridyLiquidityMigrator.sol'];
    for (const f of impls) {
      expect(existsSync(join(ROOT, 'contracts', 'src', 'v4', f))).toBe(true);
    }
    expect(DECISION).toContain('ILiquidityMigrator');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Deploy-time economics the petition discloses unprompted
// ─────────────────────────────────────────────────────────────────────────────

describe('the POL and fee parameters disclosed to Whetstone match the deploy script', () => {
  // Cited by CONSTANT NAME in the petition on purpose: an earlier draft cited
  // `DeployV4.s.sol:52-56` and line numbers drift on every edit above them.
  const params = {
    POL_BPS: 100,
    MAX_POL_BPS: 1_000,
    MIN_FEE: 500,
    MAX_FEE: 30_000,
    BASE_FEE: 3_000,
  } as const;

  for (const [name, expected] of Object.entries(params)) {
    it(`${name} is still ${expected} in DeployV4.s.sol`, () => {
      expect(solConstant(DEPLOY_SCRIPT, name)).toBe(expected);
    });

    it(`the petition names ${name} rather than a line number`, () => {
      expect(PETITION, `the petition no longer cites ${name}`).toContain(name);
    });
  }

  it('the skim ceiling really is immutable, as the petition tells them', () => {
    expect(read('contracts', 'src', 'v4', 'TegridyV4Hook.sol')).toMatch(
      /uint16\s+public\s+immutable\s+maxPolSkimBps/,
    );
  });

  it('the initializer-allowance delay the petition quotes is the coded one', () => {
    const delay = HOOK_ADMIN_SRC.match(
      /INITIALIZER_ALLOW_DELAY\s*=\s*(\d+)\s*hours/,
    );
    expect(delay, 'INITIALIZER_ALLOW_DELAY is gone from the hook admin').not.toBeNull();
    expect(Number(delay![1])).toBe(48);
    expect(PETITION, 'the petition must quote the real delay').toMatch(/\b48h?\b/);
    expect(PETITION).toContain('INITIALIZER_ALLOW_DELAY');
  });

  it('paramAdmin is described as the admin contract, not as a Safe', () => {
    // The correction: `paramAdmin` is TegridyV4HookAdmin and immutable on the hook. A
    // reviewer who checked hook.paramAdmin() against a Safe address and found a contract
    // would read the mismatch as a lie, so the petition must not promise a Safe there.
    expect(DEPLOY_SCRIPT, 'the deploy script no longer passes the admin as paramAdmin').toMatch(
      /new TegridyV4Hook\{salt: salt\}\(\s*IPoolManager\(poolManager\), BLOCK_OFFSET, address\(admin\)/,
    );
    expect(PETITION).toContain('TegridyV4HookAdmin');
    expect(
      PETITION,
      'the petition still tells a reader that paramAdmin points at a Safe',
    ).not.toMatch(/paramAdmin\b[^.\n]{0,60}\b(?:point|points|pointed)\s+at\s+(?:that\s+)?Safe/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Shape bans — the three ways this document lies without any count being wrong
// ─────────────────────────────────────────────────────────────────────────────

const OUTBOUND: ReadonlyArray<readonly [string, string]> = [
  [PETITION_REL, PETITION],
  [DECISION_REL, DECISION],
];

type Shape = { id: string; re: RegExp; why: string; sample: string };

/**
 * Paragraph-aware units of prose, with the source line each starts on.
 *
 * Scanning raw lines makes the guard depend on where a hard wrap happens to fall, and it
 * fails in BOTH directions: a claim split across a wrap escapes every shape, and a
 * conditional whose "only" sits on the previous line reads as an assertion of present
 * fact. Hard wrapping is a formatting artifact; the claim is the sentence. Table rows are
 * single lines, so cells survive intact.
 */
function prose(body: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let start = 0;
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    // Keep `.` as the sentence break, because the shapes' own `[^.\n]` gaps assume it.
    for (const s of buf.join(' ').split(/(?<=[.!?])\s+/)) {
      if (s.trim()) out.push({ line: start + 1, text: s });
    }
    buf = [];
  };
  body.split('\n').forEach((l, i) => {
    // A table row or a heading is its own unit; a fence line carries no claim.
    if (/^\s*[|#]/.test(l) || /^\s*```/.test(l)) {
      flush();
      if (l.trim() !== '') out.push({ line: i + 1, text: l });
      return;
    }
    if (l.trim() === '') {
      flush();
      return;
    }
    // A new list item ends the previous unit but starts one of its own, so its own
    // wrapped continuation lines still join to it.
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(l)) flush();
    if (!buf.length) start = i;
    buf.push(l.trim());
  });
  flush();
  return out;
}

/**
 * Refuses to anchor a status claim on a subject that a conditional already governs.
 *
 * The tempered gaps below run FORWARD from the subject, so they cannot see a qualifier
 * sitting in front of it. "only after the module is whitelisted" and "Until you say yes
 * and the module is whitelisted, our launches keep using yours" are the sentences these
 * documents are supposed to contain — they are the gating language, not the offence. The
 * lookbehind is variable-length on purpose: the conditional that governs the clause is
 * usually several words back, not immediately adjacent.
 */
const COND = String.raw`(?<!\b(?:after|until|unless|once|when|whether|if|before)\b(?:[^.\n]{0,60}))`;

const BANNED: Shape[] = [
  {
    id: 'BRANCH_POINTER',
    re: /\bon\s+branch\s+`?[\w./-]+`?/i,
    why: 'a branch name is mutable and unverifiable by the recipient; the last one pointed at a tree missing the fix the document claimed',
    sample: 'our migrator, locker and hook are at contracts/src/v4/ on branch claude/launcher-own-venue',
  },
  {
    id: 'COMMIT_POINTER',
    re: /\b(?:tip|commit|at)\s+`?\b[0-9a-f]{7,40}\b`?/i,
    why: 'we cannot prove to a third party what a hash contains; §13 hands them a grep instead',
    sample: 'read it at commit 3285bf02 in the launcher tree',
  },
  {
    id: 'MIGRATOR_PRESENTED_AS_DEPLOYED',
    re: new RegExp(
      COND +
        String.raw`\b(?:migrator|TegridyLiquidityMigrator|TegridyFeeLocker)\b(?:(?!\bnot\b|\bno\b|\bnever\b|\buntil\b)[^.\n]){0,60}\bis\s+(?:live|deployed)\b`,
      'i',
    ),
    why: 'the ask is a whitelist ON DEPLOY; nothing is deployed and the addresses in §14 do not exist',
    sample: 'the migrator is deployed and verified on Etherscan',
  },
  {
    id: 'ALREADY_WHITELISTED',
    re: new RegExp(
      COND +
        String.raw`\b(?:module|migrator)\b(?:(?!\bnot\b|\bno\b|\bnever\b|\buntil\b)[^.\n]){0,40}\b(?:is|has\s+been)\s+whitelisted\b`,
      'i',
    ),
    why: 'the whitelist is the ask; claiming it as done inverts the entire document',
    sample: 'our module has been whitelisted on the Airlock',
  },
  {
    id: 'LP_CALLED_BURNED',
    re: /\bLP\b(?:(?!\bnot\b|\bno\b|\bnever\b)[^.\n]){0,50}\b(?:is|are|gets?|ends?\s+up)\s+burned\b/i,
    why: 'the position is time-locked in a locker we wrote and the recipient may withdraw after unlockDate; only unlockDate == 0 is permanent',
    sample: 'at graduation the LP is burned, so nobody can pull it',
  },
  {
    id: 'LOCK_CALLED_IRREVERSIBLE',
    // Adverb included: "locked irreversibly" is the same false claim as "irreversible
    // lock", and an adjective-only shape is escaped by a one-character edit.
    re: /\b(?:lock|locked|escrow)\w*\b(?:(?!\bnot\b|\bno\b|\bnever\b|\bunless\b)[^.\n]){0,40}\birreversibl[ey]\b/i,
    why: 'a timed lock expires; calling it irreversible is the overstatement the decision record accepts risk 2 on condition of avoiding',
    sample: 'the position is locked irreversibly by the fee locker',
  },
  {
    id: 'CLAIMS_AUDITED',
    // The tempered gap runs FORWARD from the subject, so in "neither the migrator nor the
    // locker nor the hook has been audited" it happily anchors on the last subject with no
    // negator ahead of it. The lookbehind is what makes an enumerated denial legal; a
    // guard that rejects the honest sentence only forces a worse one.
    re: /(?<!\b(?:nor|neither)\s(?:the\s)?)\b(?:migrator|locker|hook)\b(?:(?!\bnot\b|\bun)[^.\n]){0,40}\b(?:has\s+been|was|is)\s+audited\b/i,
    why: 'none of the three has been audited by anyone and no report exists',
    sample: 'the migrator has been audited by an external firm',
  },
];

describe('the outbound documents carry no banned claim shape', () => {
  it('every shape still fires on the wording it was written for', () => {
    // A regex matching nothing is indistinguishable from a clean document. Samples are
    // the shape reworded, not quotes, so the shape is what is pinned.
    for (const s of BANNED) {
      expect(s.re.test(s.sample), `${s.id} no longer fires on its own shape`).toBe(true);
    }
  });

  it('the honest wordings these documents actually use survive', () => {
    // A guard that forces a new lie is worse than no guard.
    const legal = [
      'It is not deployed yet, so this is a request to whitelist on deploy.',
      'Nothing is deployed to mainnet. The addresses in §14 are blank because they do not exist.',
      'the module is unusable until the Airlock owner whitelists it',
      'set it only after the module is whitelisted and the initializer allowance is live',
      'until the migrator is deployed, launches keep using Doppler’s own module',
      'that is a time-locked position in a locker we wrote, which is a weaker guarantee than a burned one',
      'unlockDate == 0 means permanent, but a timed lock does expire',
      'Neither the migrator nor the locker nor the hook has been audited by anyone.',
      'Source: contracts/src/v4/TegridyLiquidityMigrator.sol',
    ];
    for (const line of legal) {
      const hit = BANNED.find((s) => s.re.test(line));
      expect(hit?.id, `honest wording rejected by ${hit?.id}: ${line}`).toBeUndefined();
    }
  });

  for (const [rel, body] of OUTBOUND) {
    it(`${rel} carries none of them`, () => {
      const offenders: string[] = [];
      for (const { line, text } of prose(body)) {
        for (const s of BANNED) {
          if (s.re.test(text)) {
            offenders.push(`${rel}:${line} [${s.id}] ${s.why}\n    ${text.trim().slice(0, 150)}`);
          }
        }
      }
      expect(offenders, `banned claim shapes:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The self-gating the documents must keep, or an outage reads as a green light
// ─────────────────────────────────────────────────────────────────────────────

describe('the petition gates itself on reads it cannot perform', () => {
  it('separates what was re-verified from what is only as fresh as its last read', () => {
    // The single structural fix. The old draft presented source claims and month-old
    // on-chain reads in one voice, so a stale figure was indistinguishable from a fresh one.
    expect(PETITION, 'the provenance section is gone').toMatch(/##\s*0\.\s*Provenance/i);
    expect(PETITION).toContain('2026-07-31');
    expect(PETITION, 'the document no longer says the on-chain reads are un-refreshed').toMatch(
      /not\s+re-?(?:read|verified|checked)\s+since/i,
    );
  });

  it('makes re-running the on-chain reads a precondition of sending', () => {
    expect(PETITION).toMatch(/re-?run\s+every\s+command/i);
    expect(PETITION, 'the fail-closed instruction is gone').toMatch(
      /do\s+not\s+send/i,
    );
  });

  it('logs the drifts it corrected instead of quietly rewriting them', () => {
    expect(PETITION).toMatch(/##\s*0\.1\s*Corrections/i);
  });

  it('hands the reader a reproducible check instead of a tree pointer', () => {
    expect(PETITION, 'the in-tree verification block is gone').toMatch(
      /grep[^\n]*PROTOCOL_OWNER_MIN_SHARES/,
    );
  });

  it('carries the second ask, so both questions travel together', () => {
    expect(PETITION).toMatch(/Additional Use Grant/);
    expect(PETITION).toContain('doppler-license-grants.whetstoneresearch.eth');
    // The grant status is an off-chain read we cannot perform either; it must be dated
    // and re-checked, never asserted as current.
    expect(PETITION, 'the BUSL claim is asserted without a re-check instruction').toMatch(
      /re-?check\s+the\s+BUSL/i,
    );
  });

  it('states the ask precisely enough for the recipient to execute it', () => {
    expect(PETITION).toContain('setModuleState');
    expect(PETITION, 'the deployed signature takes arrays; a scalar form does not exist').toMatch(
      /address\[\]\s*calldata\s*modules/,
    );
    expect(PETITION, 'ModuleState.LiquidityMigrator is state 4').toMatch(
      /ModuleState\.LiquidityMigrator/,
    );
    expect(PETITION, 'only the Airlock owner can execute it').toMatch(/onlyOwner/);
  });
});

describe('the frontend is still gated off, which is what makes the ask safe to make', () => {
  it('TEGRIDY_V4_MIGRATOR_ADDRESS is the zero address', () => {
    // Both outbound documents undertake this to Whetstone in writing. If the constant is
    // ever set, they become false at the moment of the commit, not at the moment of a
    // launch — so this assertion belongs with them rather than only with the venue module.
    expect(LAUNCHER_CONSTANTS).toMatch(
      /export const TEGRIDY_V4_MIGRATOR_ADDRESS\s*=\s*\n?\s*'0x0{40}'/,
    );
  });

  it('both documents say so, rather than leaving the reader to assume', () => {
    for (const [rel, body] of OUTBOUND) {
      expect(body, `${rel} does not name the gate constant`).toContain(
        'TEGRIDY_V4_MIGRATOR_ADDRESS',
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The decision record must record an alternative, or it gets re-litigated
// ─────────────────────────────────────────────────────────────────────────────

describe('the venue decision records what it rejected and what happens on a no', () => {
  it('names both candidate shapes, not just the chosen one', () => {
    expect(DECISION).toMatch(/Shape A/);
    expect(DECISION).toMatch(/Shape B/);
    expect(DECISION, 'the rejected shape is not marked rejected').toMatch(/REJECTED/);
    expect(DECISION, 'the chosen shape is not marked chosen').toMatch(/CHOSEN/);
  });

  it('records the accepted risks by name', () => {
    for (const risk of [/decline/i, /time-?locked/i, /unaudited/i, /POL skim/i]) {
      expect(DECISION, `an accepted risk matching ${risk} is missing`).toMatch(risk);
    }
  });

  it('records a fallback that does not require the external yes', () => {
    expect(DECISION).toMatch(/##\s*Fallback/i);
    expect(DECISION, 'the fallback must name the stock module it falls back to').toMatch(
      /uniswapV4Migrator|UniswapV4Migrator/,
    );
  });

  it('refuses the two pivots a refusal would tempt', () => {
    // Shape B needs the SAME whitelist, and self-hosting an Airlock is the BUSL fork the
    // licence bars. Both are recorded as refused in advance so a frustrated later session
    // does not discover them as fresh ideas.
    // Tolerates the interposed party name and markdown emphasis; the substance asserted
    // is that the record says the rejected shape needs the identical permission.
    expect(DECISION).toMatch(/same\s+(?:\W*\w+\W*\s+)?whitelist/i);
    expect(DECISION).toMatch(/BUSL/);
  });

  it('the petition and the decision record point at each other', () => {
    expect(PETITION, 'the petition does not cite the decision behind it').toContain(
      'GRADUATION_VENUE_DECISION.md',
    );
    expect(DECISION, 'the decision record does not cite the petition it produced').toContain(
      'WHETSTONE_MIGRATOR_PETITION.md',
    );
  });
});
