// The command line: its arguments (no way to pass a password), and the password prompt,
// which reads only from a terminal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseArgs } from '../src/cli.mjs';
import { promptHidden } from '../src/tty.mjs';
import { parseEnv } from '../src/config.mjs';

test('the five commands and their options parse', () => {
  assert.deepEqual(parseArgs(['serve', '--keys', 'D:\\keys', '--dev']), { command: 'serve', keys: 'D:\\keys', dev: true, pipe: null });
  assert.deepEqual(parseArgs(['kill']), { command: 'kill', keys: null, dev: false, pipe: null });
  for (const c of ['create', 'address', 'status']) assert.equal(parseArgs([c]).command, c);
});

test('there is no way to hand the signer a password on the command line', () => {
  assert.throws(() => parseArgs(['serve', '--password', 'hunter2hunter2']), /unknown option --password/);
  assert.throws(() => parseArgs(['serve', '--password=hunter2']), /unknown option/);
  assert.throws(() => parseArgs(['create', 'hunter2hunter2']), /unexpected argument/);
});

test('bad commands and misplaced options are refused', () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['sign']), /usage/);
  assert.throws(() => parseArgs(['status', '--dev']), /--dev only applies/);
  assert.throws(() => parseArgs(['kill', '--pipe', 'x']), /--pipe only applies/);
  assert.throws(() => parseArgs(['serve', '--keys']), /needs a value/);
});

/** A fake stdin: emits `typed` once a listener is attached. */
function fakeInput({ isTTY, typed }) {
  const e = new EventEmitter();
  e.isTTY = isTTY;
  e.rawModes = [];
  e.setRawMode = (on) => e.rawModes.push(on);
  e.resume = () => {};
  e.pause = () => {};
  e.setEncoding = () => {};
  const on = e.on.bind(e);
  e.on = (name, fn) => {
    on(name, fn);
    if (name === 'data') setImmediate(() => e.emit('data', typed));
    return e;
  };
  return e;
}
const sink = { write: () => true };

test('the prompt reads a typed line with nothing echoed, handling backspace', async () => {
  const input = fakeInput({ isTTY: true, typed: 'abc\u007fd\r' });
  assert.equal(await promptHidden('pw: ', { input, output: sink }), 'abd');
  assert.deepEqual(input.rawModes, [true, false]);
});

test('the yes at live start-up is shown as it is typed; a password never is', async () => {
  const shown = [];
  const out = { write: (s) => { shown.push(s); return true; } };
  assert.equal(await promptHidden('q: ', { input: fakeInput({ isTTY: true, typed: 'yez\u007fs\r' }), output: out, echo: true }), 'yes');
  assert.ok(shown.join('').includes('yez\b \bs'));
  const hidden = [];
  await promptHidden('pw: ', { input: fakeInput({ isTTY: true, typed: 'secret-pass\r' }), output: { write: (s) => { hidden.push(s); return true; } } });
  assert.equal(hidden.join('').includes('secret'), false);
});

test('Ctrl+C at the prompt cancels', async () => {
  await assert.rejects(promptHidden('pw: ', { input: fakeInput({ isTTY: true, typed: 'ab\u0003' }), output: sink }), /cancelled/);
});

test('PIN:K.tty a password is never read from a pipe or a file, only a terminal', async () => {
  await assert.rejects(promptHidden('pw: ', { input: fakeInput({ isTTY: false, typed: 'piped-password\n' }), output: sink }), /only read from a terminal/);
});

test('the env file parser reads KEY=VALUE lines and ignores comments', () => {
  assert.deepEqual(parseEnv('# c\nHOUSE_RPC_HTTP=https://a.example/x, https://b.example\n\nHOUSE_PIN_COMMIT="abc"\nbad line\n'), {
    HOUSE_RPC_HTTP: 'https://a.example/x, https://b.example',
    HOUSE_PIN_COMMIT: 'abc',
  });
});
