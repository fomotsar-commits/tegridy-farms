// The container's process: the batcher run as a child, started again after it exits 3 (EMURGO's
// library broke), with a longer wait each time in a row; any other exit is the container's; a stop
// signal goes to the batcher, and ends the container whatever the batcher ends with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervise } from '../src/supervise.ts';

/** A stand-in batcher: it counts its runs in a file and exits with the code for that run (the last one again after). */
const BATCHER = `const fs = require('fs');
const [counter, codes] = process.argv.slice(2);
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(n + 1));
const list = codes.split(',');
const code = list[Math.min(n, list.length - 1)];
if (code === 'hang') {
  process.on('SIGTERM', () => process.exit(0));
  // Never told to stop: it ends by itself, so a failing test cannot hold the run open.
  setTimeout(() => process.exit(9), 15_000);
} else process.exit(Number(code));
`;

/** A promise, or a failure after `ms`: a supervisor that never ends fails the test, it does not hang the run. */
const within = <T>(p: Promise<T>, ms = 10_000) => Promise.race([p, new Promise<never>((_r, reject) => setTimeout(() => reject(new Error(`not done within ${ms} ms`)), ms).unref())]);

function rig(codes: string) {
  const dir = mkdtempSync(join(tmpdir(), 'batcher-supervise-'));
  const script = join(dir, 'batcher.cjs');
  const counter = join(dir, 'runs');
  writeFileSync(script, BATCHER);
  const logs: Record<string, unknown>[] = [];
  let stop: (signal: NodeJS.Signals) => void = () => {};
  const run = (opts: { firstWaitMs?: number; now?: () => number } = {}) =>
    supervise({ script, argv: [counter, codes], env: process.env, onStop: (s) => (stop = s), log: (l) => logs.push(JSON.parse(l) as Record<string, unknown>), firstWaitMs: opts.firstWaitMs ?? 5, ...(opts.now ? { now: opts.now } : {}) });
  return { run, logs, runs: () => Number(readFileSync(counter, 'utf8')), stop: (s: NodeJS.Signals) => stop(s), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('exit 3 (the library broke): started again, waiting longer each time in a row; then its exit is the container’s', async () => {
  const r = rig('3,3,3,0');
  try {
    assert.equal(await r.run(), 0);
    assert.equal(r.runs(), 4);
    assert.deepEqual(r.logs.map((l) => [l.kind, l.waitMs]), [['restarting', 5], ['restarting', 10], ['restarting', 20]]);
  } finally {
    r.done();
  }
});

test('any other exit is never restarted here: Railway sees it', async () => {
  for (const code of ['0', '1', '2']) {
    const r = rig(code);
    try {
      assert.equal(await r.run(), Number(code));
      assert.equal(r.runs(), 1);
      assert.equal(r.logs.length, 0);
    } finally {
      r.done();
    }
  }
});

test('a stop signal reaches the batcher, and ends the container (exit 0), also while it waits to start one again', async () => {
  const running = rig('hang');
  try {
    const done = running.run();
    // Once the batcher has started, stop.
    for (let i = 0; i < 400 && !(() => { try { return running.runs() === 1; } catch { return false; } })(); i++) await new Promise((res) => setTimeout(res, 10));
    running.stop('SIGTERM');
    assert.equal(await within(done), 0);
  } finally {
    running.done();
  }
  const waiting = rig('3');
  try {
    const done = waiting.run({ firstWaitMs: 60_000 });
    for (let i = 0; i < 400 && waiting.logs.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
    waiting.stop('SIGTERM');
    assert.equal(await within(done, 5_000), 0);
    assert.equal(waiting.runs(), 1, 'it started another after the stop');
  } finally {
    waiting.done();
  }
});

test('a batcher that ran ten minutes or more before it broke was making progress: the wait starts over', async () => {
  const r = rig('3,3,3,0');
  try {
    let t = 0;
    assert.equal(await r.run({ now: () => (t += 600_000) }), 0);
    assert.deepEqual(r.logs.map((l) => l.waitMs), [5, 5, 5]);
  } finally {
    r.done();
  }
});
