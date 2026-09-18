// EVERY RECEIPT WAIT READS THE REVERT WHERE WAGMI PUTS IT.
//
// @wagmi/core's waitForTransactionReceipt THROWS on `status === 'reverted'` (it
// replays the tx to recover a reason and throws that), so a genuine revert
// reaches `useWaitForTransactionReceipt()` as `isError`, never as `isSuccess`
// with a reverted `data`. Measured 2026-09-17 against the installed wagmi; the
// table is in lib/txErrors.ts and the real library is pinned by
// lib/txErrors.receipt.test.ts.
//
// Until then some 26 consumers derived a revert as
// `isSuccess && receipt.status !== 'success'`, a shape wagmi 3 never produces.
// Every one of those revert branches was dead. A real revert did whatever the
// surface's `isError` path did — usually nothing: silent, or a step latched on
// "Confirming on-chain…" until a reload (CurveTradePanel, CurveCreatorClaim, the
// NFT AMM's approval step), or "pending" for good (the bungalow pools). And the
// few that did read `isError` called an UNREADABLE receipt "failed".
//
// The rule pinned here is structural, so it also covers the legs no render test
// here reaches (offer and loan cards behind a tab and a data load): in every
// source file, each receipt wait is matched by a call into the split —
// `receiptOutcome()`, `useReceiptOutcome()` or `isRevertedReceiptError()` —
// which are the only readers that tell a revert from an unreadable receipt.
// A file that adds a wait without one fails here, and says which.
//
// AND EVERY WAIT RECORDS WHY ITS TRANSACTION WAS REPLACED. When the wallet
// replaces a pending tx at its nonce, viem resolves the wait with the
// REPLACEMENT's receipt (a cancel's says success) and says why only through
// `onReplaced`. receiptOutcome() needs that reason to tell a speed-up (the same
// call, which ran) from a cancel (which did not); without it every speed-up
// reads as "replaced". So each `useWaitForTransactionReceipt(` call passes
// `onReplaced: noteReplacement`, checked per call, not per file.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Source with comments removed, so a comment that NAMES a call is not the call. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

const WAIT = /\buseWaitForTransactionReceipt\(/g;
const SPLIT = /\b(?:receiptOutcome|useReceiptOutcome|isRevertedReceiptError)\(/g;
// The dead derivation itself: a revert read off a receipt that was "fetched".
const DEAD_REVERT = /(?:Fetched|isSuccess)\s*&&\s*!!\s*[\w.]+\s*&&\s*[\w.]+\.status\s*!==\s*'success'/g;

/** The argument text of every `useWaitForTransactionReceipt(...)` call in `src`. */
function waitCalls(src: string): string[] {
  const calls: string[] = [];
  for (let i = src.indexOf('useWaitForTransactionReceipt('); i >= 0; i = src.indexOf('useWaitForTransactionReceipt(', i + 1)) {
    let depth = 0;
    let j = i + 'useWaitForTransactionReceipt'.length;
    do {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') depth--;
      j++;
    } while (depth > 0 && j < src.length);
    calls.push(src.slice(i, j));
  }
  return calls;
}

const consumers = walk(SRC)
  .filter((f) => !f.endsWith(join('lib', 'txErrors.ts')))
  .map((f) => ({ file: relative(SRC, f).replace(/\\/g, '/'), src: code(f) }))
  .filter(({ src }) => count(src, WAIT) > 0);

describe('every useWaitForTransactionReceipt consumer reads the thrown revert', () => {
  it('finds the consumers (a scan that matched nothing would pass vacuously)', () => {
    expect(consumers.length).toBeGreaterThan(20);
  });

  it('matches every receipt wait in a file with a call into the revert/unreadable split', () => {
    const short = consumers
      .map(({ file, src }) => ({ file, waits: count(src, WAIT), splits: count(src, SPLIT) }))
      .filter(({ waits, splits }) => splits < waits)
      .map(({ file, waits, splits }) => `${file}: ${waits} receipt wait(s), ${splits} split call(s)`);
    expect(short, 'these files read a receipt wait without telling a revert from an unreadable receipt').toEqual([]);
  });

  it('passes onReplaced: noteReplacement on every receipt wait', () => {
    const missing = consumers.flatMap(({ file, src }) =>
      waitCalls(src)
        .filter((call) => !/\bonReplaced:\s*noteReplacement\b/.test(call))
        .map((call) => `${file}: ${call.replace(/\s+/g, ' ').slice(0, 90)}`),
    );
    expect(
      missing,
      'these waits never learn WHY a replaced tx was replaced, so a speed-up reads as a cancel',
    ).toEqual([]);
  });

  it('derives no revert from `isSuccess && receipt.status !== "success"` alone', () => {
    const dead = consumers
      .filter(({ src }) => count(src, DEAD_REVERT) > 0)
      .map(({ file, src }) => `${file}: ${count(src, DEAD_REVERT)}`);
    expect(dead, 'wagmi never delivers a reverted receipt on isSuccess; this branch cannot fire').toEqual([]);
  });
});
