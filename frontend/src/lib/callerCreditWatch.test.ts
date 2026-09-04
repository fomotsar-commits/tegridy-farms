// STRANDED-FEE VISIBILITY GUARD.
//
// What this pins, in one sentence: **a non-zero `ReferralSplitter.callerCredit`
// reaches a human, and nothing about that claim is stated more strongly than the
// arithmetic supports.**
//
// Why it needs pinning
// --------------------
// `ReferralSplitter.recordFee` parks the non-referral remainder of every ETH swap fee —
// 80% at the live `referralFeeBps` of 2000 — in `callerCredit[SwapFeeRouter]`. It leaves
// only when somebody calls the permissionless `SwapFeeRouter.recoverCallerCredit()`.
// On mainnet 2026-08-12, block 25739699:
//
//   SwapFeeRouter.totalETHFees()            3000000000000 wei
//   SwapFeeRouter.accumulatedETHFees()      0
//   ReferralSplitter.callerCredit(router)   2400000000000 wei   <- 80%, never pulled
//   RevenueDistributor.totalDistributed()   0
//
// Nothing in the repository had ever called it, and revenue-watch.yml could not see it,
// because every rail it read was a counter on the contract that earned the fee and the
// credit lives on the other side of the split. The money was invisible, not missing.
//
// So the assertions below are deliberately about CONDITIONS, not sentences:
//   - a non-zero credit is classified as stranded even when the pull is blocked
//     (visibility and actionability are different questions)
//   - an unreadable credit is UNKNOWN, never zero
//   - the amount survives into both the human report and GITHUB_OUTPUT
//   - the "does this open a distribution epoch" claim equals the arithmetic against
//     RevenueDistributor.MIN_DISTRIBUTE_AMOUNT, in both directions
//   - the workflow consumes an output key the script actually writes, via `env:`
//
// Reword any of the prose freely; these stay green. Drop the read, mis-key the output,
// classify a failed read as zero, or hardcode the epoch claim, and they go red.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADDRESSES,
  MIN_DISTRIBUTE_AMOUNT,
  classifyCallerCredit,
  encodeAddressArg,
  hexToBigInt,
  renderGithubOutput,
  renderReport,
} from '../../../scripts/lib/caller-credit.mjs';

const repoRoot = join(process.cwd(), '..');
const WORKFLOW_PATH = join(repoRoot, '.github', 'workflows', 'revenue-watch.yml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

/** The live reading, used as the realistic baseline for every fixture below. */
const LIVE = {
  creditWei: 2_400_000_000_000n,
  routerPaused: false,
  splitterSetupComplete: true,
  splitterBalanceWei: 3_000_000_000_000n,
  lastCallerCreditAt: 0n,
  cooldownSeconds: 30n,
  nowSeconds: 1_786_000_000n,
  wiredSplitter: ADDRESSES.referralSplitter,
  accumulatedETHFeesWei: 0n,
  gasEstimate: 112_956n,
  gasPriceWei: 121_695_961n,
  errors: [] as string[],
};

/**
 * What an override may say. `Partial<typeof LIVE>` was wrong: LIVE is a
 * HAPPY-PATH reading, so every field infers as non-nullable, while the module
 * documents and handles every field as `… | null` ("we tried and could not read
 * it") — and Rule 1, the thing most of this file exists to pin, is expressed by
 * passing exactly those nulls. `errors` stays non-nullable because
 * `classifyCallerCredit` spreads it unconditionally; `null` there would throw.
 */
type ReadingOverride = { [K in keyof Omit<typeof LIVE, 'errors'>]?: (typeof LIVE)[K] | null } & {
  errors?: string[];
};

const reading = (over: ReadingOverride = {}) => ({ ...LIVE, ...over });

describe('a non-zero callerCredit is surfaced, never silently ignored', () => {
  it('classifies money sitting in the mapping as stranded', () => {
    const c = classifyCallerCredit(reading());
    expect(c.state).toBe('stranded');
    expect(c.creditWei).toBe(LIVE.creditWei);
  });

  // The core of the guard. Every one of these makes the pull revert, and it would be
  // very easy to "helpfully" stop reporting a strand nobody can currently collect —
  // which is precisely when someone needs to know it is there.
  it.each([
    ['the router is paused', { routerPaused: true }],
    ['the splitter setup never completed', { splitterSetupComplete: false }],
    ['the recover cooldown is still running', { lastCallerCreditAt: 1_785_999_990n }],
    ['the splitter cannot cover what it owes', { splitterBalanceWei: 1n }],
    ['the router points at a different splitter', { wiredSplitter: '0x000000000000000000000000000000000000dEaD' }],
  ])('stays stranded, and merely un-pullable, when %s', (_why, over) => {
    const c = classifyCallerCredit(reading(over));
    expect(c.state).toBe('stranded');
    expect(c.pullable).toBe(false);
    expect(c.blockers.length).toBeGreaterThan(0);
    // Blocked or not, the amount still has to reach the reader.
    expect(renderReport(c)).toContain(String(LIVE.creditWei));
  });

  it('is pullable by anyone when no guard is in the way', () => {
    const c = classifyCallerCredit(reading());
    expect(c.pullable).toBe(true);
    expect(c.blockers).toEqual([]);
  });

  // Amounts are reported exactly. A formatter that rounded 2.4e12 wei to "0.0000 ETH"
  // would technically "surface" it and tell the reader nothing.
  //
  // ⚠ `toContain(String(creditWei))` ALONE is vacuous for small values: formatEth(1n)
  // is "0.000000000000000001 ETH", which contains "1", so the assertion passes on a
  // report that dropped the wei figure entirely. Of the four cases only 2.4e12 could
  // ever fail. So each case also asserts the exact backticked wei token the renderer
  // emits — that string cannot be produced by the ETH rendering.
  it.each([1n, 999n, 2_400_000_000_000n, 10n ** 21n])('carries the exact wei amount %s into the report', (creditWei) => {
    const report = renderReport(classifyCallerCredit(reading({ creditWei })));
    expect(report).toContain(`\`${creditWei}\` wei`);
  });

  it('reports zero as clear, so the alert means something when it fires', () => {
    const c = classifyCallerCredit(reading({ creditWei: 0n }));
    expect(c.state).toBe('clear');
    expect(c.pullable).toBe(false);
  });
});

describe('a read that failed is unknown, never zero', () => {
  it('does not coerce an unreadable credit into "nothing stranded"', () => {
    const c = classifyCallerCredit(reading({ creditWei: null, errors: ['callerCredit: HTTP 502'] }));
    expect(c.state).toBe('unknown');
    expect(c.state).not.toBe('clear');
    expect(c.pullable).toBe(false);
    expect(renderReport(c)).toContain('HTTP 502');
  });

  it('says so even when the RPC failed silently and gave no reason', () => {
    const c = classifyCallerCredit(reading({ creditWei: null, errors: [] }));
    expect(c.state).toBe('unknown');
    expect(c.unknown.length).toBeGreaterThan(0);
  });
});

describe('the claim about opening a distribution epoch equals the arithmetic', () => {
  // RevenueDistributor.MIN_DISTRIBUTE_AMOUNT is 1e18. Recovering the credit moves it to
  // SwapFeeRouter.accumulatedETHFees and nothing more; at the live numbers it is seven
  // orders of magnitude short. The table straddles the threshold in both directions so
  // that a hardcoded answer of either kind fails.
  it.each([
    [2_400_000_000_000n, 0n, false],
    [1n, MIN_DISTRIBUTE_AMOUNT - 2n, false],
    [1n, MIN_DISTRIBUTE_AMOUNT - 1n, true],
    [MIN_DISTRIBUTE_AMOUNT, 0n, true],
    [MIN_DISTRIBUTE_AMOUNT * 5n, 7n, true],
  ])('credit %s + accumulated %s -> opensEpoch %s', (creditWei, accumulatedETHFeesWei, expected) => {
    const c = classifyCallerCredit(reading({ creditWei, accumulatedETHFeesWei }));
    expect(c.distribution.opensEpoch).toBe(expected);
    expect(c.distribution.opensEpoch).toBe(creditWei + accumulatedETHFeesWei >= MIN_DISTRIBUTE_AMOUNT);
  });

  // Derived, not asserted. If the epoch line were a fixed string, these two renders
  // would be identical and this fails.
  it('renders a different epoch statement either side of the threshold', () => {
    const below = renderReport(classifyCallerCredit(reading({ creditWei: 1n, accumulatedETHFeesWei: 0n })));
    const above = renderReport(classifyCallerCredit(reading({ creditWei: MIN_DISTRIBUTE_AMOUNT, accumulatedETHFeesWei: 0n })));
    expect(below).not.toBe(above);
    expect(below).toContain(String(MIN_DISTRIBUTE_AMOUNT - 1n)); // the shortfall, stated
  });

  it('admits it does not know when accumulatedETHFees could not be read', () => {
    const c = classifyCallerCredit(reading({ accumulatedETHFeesWei: null }));
    expect(c.distribution.opensEpoch).toBeNull();
  });
});

describe('the economics are reported, because they argue against automating this', () => {
  it('flags a pull that costs more gas than it recovers', () => {
    const c = classifyCallerCredit(reading());
    expect(c.economics?.worthIt).toBe(false);
    expect(c.economics!.gasCostWei).toBeGreaterThan(c.creditWei!);
    expect(renderReport(c)).toContain(String(c.economics!.gasCostWei));
  });

  it('flips once the credit outgrows the gas', () => {
    const c = classifyCallerCredit(reading({ creditWei: 10n ** 18n }));
    expect(c.economics?.worthIt).toBe(true);
  });

  it('break-even gas price is the price at which the pull exactly pays for itself', () => {
    const c = classifyCallerCredit(reading());
    // `caller-credit.mjs` is an un-annotated .mjs, so `breakEvenGasPriceWei`
    // (`creditWei / gasEstimate` over two implicitly-`any` locals) INFERS as
    // `number` while being a bigint at run time. Assert the run-time type rather
    // than assume it — a float here would silently truncate a wei figure — then
    // convert, which is a no-op for a bigint.
    expect(c.economics!.breakEvenGasPriceWei, 'break-even gas price is not a wei bigint').toBeTypeOf('bigint');
    const atBreakEven = classifyCallerCredit(reading({ gasPriceWei: BigInt(c.economics!.breakEvenGasPriceWei) }));
    expect(atBreakEven.economics!.gasCostWei).toBeLessThanOrEqual(LIVE.creditWei);
  });
});

describe('GITHUB_OUTPUT carries the finding without letting an RPC forge it', () => {
  it('emits a stranded state and the amount', () => {
    const out = renderGithubOutput(classifyCallerCredit(reading()), { delimiter: 'DELIM' });
    expect(out).toContain('stranded_state=stranded');
    expect(out).toContain(String(LIVE.creditWei));
  });

  it('emits unknown, not clear, when the read failed', () => {
    const out = renderGithubOutput(classifyCallerCredit(reading({ creditWei: null })), { delimiter: 'DELIM' });
    expect(out).toContain('stranded_state=unknown');
  });

  // The body embeds RPC error text, i.e. a string chosen by whoever runs or MITMs a
  // public endpoint, in a job holding `issues: write`. A body line equal to the heredoc
  // delimiter closes the block early and everything after it is parsed as new
  // GITHUB_OUTPUT keys.
  //
  // The payload has to contain a NEWLINE to be dangerous: every line the renderer emits
  // itself is prefixed ("  - …"), so only an error message that carries its own line
  // break can produce a line that is exactly the delimiter. An earlier version of this
  // test injected a single-line "DELIM", which the prefix made harmless — it passed with
  // the redaction deleted, i.e. it pinned nothing.
  it('neutralises a heredoc delimiter smuggled in through an RPC error', () => {
    const hostile = classifyCallerCredit(reading({ creditWei: null, errors: ['boom'] }));
    hostile.unknown.push('callerCredit: {"message":"x\nDELIM\nevil_key=pwned"}');
    const out = renderGithubOutput(hostile, { delimiter: 'DELIM' });
    const lines = out.split('\n');
    expect(lines.filter((l) => l === 'DELIM'), 'the block can be closed exactly once').toHaveLength(1);
    // …and that one closer is the last line, so nothing smuggled follows it.
    expect(lines[lines.length - 1]).toBe('DELIM');
  });

  it('keeps the single-line output keys on one line each', () => {
    const c = classifyCallerCredit(reading({ creditWei: null }));
    c.unknown.push('multi\nline\nerror');
    const out = renderGithubOutput(c, { delimiter: 'DELIM' });
    const summary = out.split('\n').find((l) => l.startsWith('stranded_summary='));
    expect(summary).toBeDefined();
    expect(summary).not.toContain('\n');
  });
});

describe('encoding and decoding helpers', () => {
  it('ABI-encodes the router address as callerCredit’s argument', () => {
    const data = encodeAddressArg('0x27cbcbc2', ADDRESSES.swapFeeRouter);
    expect(data).toHaveLength(2 + 8 + 64);
    expect(data.startsWith('0x27cbcbc2')).toBe(true);
    expect(data.endsWith(ADDRESSES.swapFeeRouter.slice(2).toLowerCase())).toBe(true);
  });

  it('refuses anything that is not an address rather than encoding garbage', () => {
    expect(() => encodeAddressArg('0x27cbcbc2', '0xdeadbeef')).toThrow();
  });

  // `0x` is what a node returns for a call to a contract that does not implement the
  // selector. Reading it as 0 would report "nothing stranded" from a failed read.
  it.each(['0x', '', 'not hex', null, undefined])('treats %s as unreadable, not as zero', (v) => {
    expect(hexToBigInt(v as unknown as string)).toBeNull();
  });
});

// ─── The wiring. Without this, everything above could be a module nobody calls. ───

/** Minimal structural view of a workflow step: enough to check data flow. */
type Step = { id?: string; if?: string; env: string; run: string };

function parseSteps(src: string): Step[] {
  const lines = src.split(/\r?\n/);
  const steps: Step[] = [];
  let current: { id?: string; if?: string; env: string[]; run: string[] } | null = null;
  let mode: 'env' | 'run' | null = null;

  const flush = () => {
    if (current) steps.push({ id: current.id, if: current.if, env: current.env.join('\n'), run: current.run.join('\n') });
  };

  for (const line of lines) {
    if (/^ {6}- /.test(line)) {
      flush();
      current = { env: [], run: [] };
      mode = null;
    }
    if (!current) continue;

    // A key at step level ends whatever block was being collected.
    const stepKey = line.match(/^ {8}(\w+):(.*)$/);
    if (stepKey) {
      mode = null;
      const [, key, rest] = stepKey;
      if (key === 'id') current.id = rest.trim();
      else if (key === 'if') current.if = rest.trim();
      else if (key === 'env') mode = 'env';
      else if (key === 'run') {
        mode = 'run';
        if (rest.trim() && rest.trim() !== '|' && rest.trim() !== '>') current.run.push(rest.trim());
      }
      continue;
    }
    if (mode === 'env') current.env.push(line);
    if (mode === 'run') current.run.push(line);
  }
  flush();
  return steps;
}

describe('revenue-watch.yml actually consumes the detection', () => {
  const steps = parseSteps(workflow);
  const probe = steps.find((s) => /pull-caller-credit\.mjs/.test(s.run));

  // Every check below is about what happens to the probe's output, so each one asserts
  // the probe exists before dereferencing it — a missing step should read as "the
  // detection is gone", not as a TypeError from four unrelated tests.
  const probeId = () => {
    expect(probe?.id, 'no step invokes scripts/pull-caller-credit.mjs with an id').toBeTruthy();
    return probe!.id!;
  };

  it('runs the caller-credit probe, and the script it names exists', () => {
    expect(probe, 'no step invokes scripts/pull-caller-credit.mjs').toBeDefined();
    expect(probe!.run).toMatch(/--probe/);
    expect(existsSync(join(repoRoot, 'scripts', 'pull-caller-credit.mjs'))).toBe(true);
  });

  it('gives the probe step an id, so its output can be referred to at all', () => {
    expect(probe!.id).toBeTruthy();
  });

  it('gates a reporting step on a stranded result', () => {
    const id = probeId();
    const gated = steps.filter((s) => s.if?.includes(`steps.${id}.outputs.stranded_state`));
    expect(gated.length, 'nothing branches on the stranded state').toBeGreaterThan(0);
    expect(gated.some((s) => s.if!.includes("'stranded'")), 'a stranded read must trigger a report').toBe(true);
    // An unreadable credit is the same blindness the rest of this workflow already
    // fails on; treating it as "fine" is the bug this whole file exists to prevent.
    expect(gated.some((s) => s.if!.includes("'unknown'")), 'an unreadable credit must be escalated too').toBe(true);
  });

  it('puts the finding into the body a human reads', () => {
    const id = probeId();
    const consumers = steps.filter((s) => new RegExp(`steps\\.${id}\\.outputs\\.stranded\\b`).test(s.env));
    expect(consumers.length, 'the stranded report is never bound into a step that publishes it').toBeGreaterThan(0);
    expect(consumers.some((s) => /gh issue (comment|create)/.test(s.run))).toBe(true);
  });

  // The recorded trap in this repo: `${{ }}` inside a `run:` is pasted into the script
  // TEXT before bash parses it, and this value is built from a public RPC's response in
  // a job holding `issues: write`.
  it('never splices the probe output into a run: block', () => {
    const id = probeId();
    for (const step of steps) {
      expect(step.run, 'probe output spliced into a run: block instead of bound via env:')
        .not.toMatch(new RegExp(`\\$\\{\\{[^}]*steps\\.${id}\\.outputs`));
    }
  });

  // Drift guard: the workflow can only read keys the script writes. A rename on either
  // side turns the alert into a silently empty string, which reads exactly like "clear".
  it('only reads output keys the probe actually writes', () => {
    const id = probeId();
    const emitted = new Set(
      renderGithubOutput(classifyCallerCredit(reading()), { delimiter: 'DELIM' })
        .split('\n')
        .map((l) => l.match(/^(\w+)(?:=|<<)/)?.[1])
        .filter(Boolean) as string[],
    );
    const referenced = [...workflow.matchAll(new RegExp(`steps\\.${id}\\.outputs\\.(\\w+)`, 'g'))].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const key of referenced) expect(emitted, `workflow reads ${key}, which the probe never writes`).toContain(key);
  });
});

// RULE 1 APPLIED TO THE GUARDS, not just to the credit.
//
// Each blocker fires on a DEFINITE reading. A guard that could not be read pushed
// nothing, so `blockers` came back empty and `pullable` came back TRUE — and the report
// told the reader "the pull is available to anyone" while blind to the one guard that
// would have reverted it. The module's own Rule 1 forbids exactly that coercion; it was
// enforced for the credit read and skipped for the guards.
describe('an unread guard is not an absent guard', () => {
  it.each([
    ['routerPaused', { routerPaused: null }],
    ['splitterSetupComplete', { splitterSetupComplete: null }],
    ['splitterBalanceWei', { splitterBalanceWei: null }],
    ['wiredSplitter', { wiredSplitter: null }],
  ])('refuses to call the pull available when %s could not be read', (_name, override) => {
    const c = classifyCallerCredit(reading(override));
    // Still stranded — Rule 2: the money exists regardless of what we could read.
    expect(c.state).toBe('stranded');
    // But we have NOT established that anyone can pull it.
    expect(c.pullable).toBe(false);
    expect(c.unreadableGuards.length).toBeGreaterThan(0);

    const report = renderReport(c);
    expect(report).toMatch(/UNKNOWN this run/i);
    expect(report, 'must not claim availability it did not establish')
      .not.toMatch(/The pull is available to anyone/);
  });

  it('still says "available to anyone" when every guard WAS read and none bit', () => {
    // The guard above must not be so broad that it never lets the true case through.
    const c = classifyCallerCredit(reading());
    expect(c.unreadableGuards).toEqual([]);
    expect(c.pullable).toBe(true);
    expect(renderReport(c)).toContain('The pull is available to anyone');
  });

  it('treats a reverting simulation as evidence AGAINST availability, not as silence', () => {
    // eth_estimateGas returning nothing is what a revert looks like here. Previously
    // this only suppressed the economics block: the body still asserted anyone could
    // pull, having dropped the strongest available evidence that they could not.
    const c = classifyCallerCredit(reading({ gasEstimate: null }));
    expect(c.simulationReverted).toBe(true);
    expect(c.pullable).toBe(false);
    expect(renderReport(c)).toMatch(/estimateGas/i);
  });
});

// The dedupe existed to stop an hourly identical comment. It hashed the RENDERED
// report, which embeds the live gas price, so the hash changed every block and the
// dedupe never fired once — the alert it was added to suppress posted hourly anyway.
describe('the dedupe fingerprint is stable against things that move on their own', () => {
  const fp = (r: Parameters<typeof reading>[0]) => {
    const out = renderGithubOutput(classifyCallerCredit(reading(r)));
    return /stranded_fingerprint=([0-9a-f]+)/.exec(out)?.[1];
  };

  it('does not change when only the gas price moves', () => {
    const a = fp({ gasPriceWei: 100_000_000n });
    const b = fp({ gasPriceWei: 100_000_001n });
    const c = fp({ gasPriceWei: 9_000_000_000n });
    expect(a).toBeTruthy();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('DOES change when the strand itself changes', () => {
    const base = fp({});
    expect(fp({ creditWei: 5_000_000_000_000n })).not.toBe(base);
    expect(fp({ routerPaused: true })).not.toBe(base);
    expect(fp({ creditWei: 0n })).not.toBe(base);
  });
});

describe('worthPulling is the only fact that should ever wake somebody', () => {
  const fp = (r: Parameters<typeof reading>[0]) => {
    const out = renderGithubOutput(classifyCallerCredit(reading(r)));
    return /stranded_fingerprint=([0-9a-f]+)/.exec(out)?.[1];
  };

  // `state === 'stranded'` has been permanently true since the rail was wired, and
  // `pullable` only says the transaction would not revert. Neither distinguishes the one
  // hour a human should sign from the thousands where signing burns money.
  it('is false while the pull still costs more than it recovers', () => {
    const c = classifyCallerCredit(reading());
    expect(c.state).toBe('stranded');
    expect(c.pullable).toBe(true);
    expect(c.worthPulling).toBe(false);
  });

  it('is true once the pull pays for itself', () => {
    expect(classifyCallerCredit(reading({ gasPriceWei: 1n })).worthPulling).toBe(true);
  });

  // Rule 1, on the field an operator acts on. "We could not price it" and "it is not
  // worth it" produce OPPOSITE behaviour, so collapsing them into `false` would be the
  // same class of bug this whole file exists to pin.
  it('is null, NOT false, when the economics could not be computed', () => {
    const c = classifyCallerCredit(reading({ gasEstimate: null }));
    expect(c.economics).toBeNull();
    expect(c.worthPulling).toBeNull();
    expect(c.worthPulling).not.toBe(false);
  });

  it('renders as unknown in GITHUB_OUTPUT rather than as a confident false', () => {
    const unknown = renderGithubOutput(classifyCallerCredit(reading({ gasEstimate: null })));
    expect(unknown).toContain('stranded_worth_pulling=unknown');
    const known = renderGithubOutput(classifyCallerCredit(reading()));
    expect(known).toContain('stranded_worth_pulling=false');
  });

  // THE REGRESSION THIS BLOCK EXISTS FOR.
  //
  // The fingerprint deliberately excludes gas price, so that a figure moving every block
  // cannot re-post the same alert hourly. But "pulling is now worth it" flips on gas
  // price ALONE, with the credit, the blockers and the state all unchanged. Before
  // `worthPulling` joined the fingerprint, the single run where the rail first became
  // worth draining hashed identically to the thousands where it was not, and the dedupe
  // swallowed it: the alert would have been suppressed at the only moment it mattered.
  //
  // MUTATION: drop `String(classification.worthPulling)` from `fingerprintFacts` in
  // caller-credit.mjs and this test fails, while every other test in this file passes.
  it('DOES change the fingerprint when pulling becomes worth it, though gas price alone does not', () => {
    const notWorth = fp({});
    const worth = fp({ gasPriceWei: 1n });

    // Same strand, same blockers, same state - only the economics differ.
    const a = classifyCallerCredit(reading());
    const b = classifyCallerCredit(reading({ gasPriceWei: 1n }));
    expect(b.creditWei).toBe(a.creditWei);
    expect(b.state).toBe(a.state);
    expect(b.pullable).toBe(a.pullable);
    expect(b.worthPulling).not.toBe(a.worthPulling);

    expect(notWorth).toBeTruthy();
    expect(worth).not.toBe(notWorth);
  });
});
