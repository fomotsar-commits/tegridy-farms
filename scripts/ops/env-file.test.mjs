// node --test scripts/ops/env-file.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitWorkTreeAbove, loadEnvFile, parseEnvText, takeEnvFileFlag } from './lib/env-file.mjs';

describe('parseEnvText keeps a secret exactly as written', () => {
  test("keeps '#' inside an unquoted value (node's own --env-file cuts it there)", () => {
    const { vars, errors } = parseEnvText('BACKUP_PASSPHRASE=abc#def ghi\n');
    assert.deepEqual(errors, []);
    assert.equal(vars.BACKUP_PASSPHRASE, 'abc#def ghi');
  });

  test('keeps everything after the first = (base64 padding, URLs with queries)', () => {
    const { vars } = parseEnvText('K=a=b==\nU=https://hc-ping.com/abc?rid=1&x=2\n');
    assert.equal(vars.K, 'a=b==');
    assert.equal(vars.U, 'https://hc-ping.com/abc?rid=1&x=2');
  });

  test('strips CRLF, a BOM, and matching outer quotes, and nothing else', () => {
    const text = String.fromCharCode(0xfeff) + 'A=plain\r\nB=\'  two spaces kept  \'\r\nC="dq # \'q\'"\r\nD=  trimmed  \r\n';
    const { vars, errors } = parseEnvText(text);
    assert.deepEqual(errors, []);
    assert.deepEqual(vars, { A: 'plain', B: '  two spaces kept  ', C: "dq # 'q'", D: 'trimmed' });
  });

  test('skips blank and comment lines', () => {
    const { vars, errors } = parseEnvText('# a comment\n\n   # indented comment\nX=1\n');
    assert.deepEqual(errors, []);
    assert.deepEqual(vars, { X: '1' });
  });

  test('rejects a malformed line, an unclosed quote and a repeated name, by line number only', () => {
    const secret = 'hunter2-very-secret';
    const { errors } = parseEnvText(`not a pair ${secret}\nA='${secret}\nB=1\nB=2\n`);
    assert.equal(errors.length, 3);
    assert.match(errors[0], /line 1 is not NAME=value/);
    assert.match(errors[1], /line 2 \(A\) opens a quote/);
    assert.match(errors[2], /line 4 sets B a second time/);
    for (const e of errors) assert.ok(!e.includes(secret), 'an error message leaked the line text');
  });
});

describe('loadEnvFile refuses a file inside a git work tree', () => {
  test('loads a file outside any repo, and the file wins over the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opsenv-'));
    assert.equal(gitWorkTreeAbove(dir), null, 'the temp dir is itself inside a git work tree; this test cannot run here');
    const file = join(dir, 'ops.env');
    writeFileSync(file, 'X=from-file\nY=abc#def\n');
    const env = { X: 'from-env' };
    assert.deepEqual(loadEnvFile(file, env), ['X', 'Y']);
    assert.deepEqual(env, { X: 'from-file', Y: 'abc#def' });
  });

  test('throws when a .git sits in the file folder or any parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'opsrepo-'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'deep', 'er'), { recursive: true });
    const file = join(root, 'deep', 'er', 'ops.env');
    writeFileSync(file, 'X=1\n');
    assert.equal(gitWorkTreeAbove(file), root);
    assert.throws(() => loadEnvFile(file, {}), /inside the git work tree/);
  });

  test('a worktree .git FILE counts too', () => {
    const root = mkdtempSync(join(tmpdir(), 'opswt-'));
    writeFileSync(join(root, '.git'), 'gitdir: elsewhere\n');
    writeFileSync(join(root, 'ops.env'), 'X=1\n');
    assert.throws(() => loadEnvFile(join(root, 'ops.env'), {}), /inside the git work tree/);
  });

  test('a malformed file fails without echoing its content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opsbad-'));
    writeFileSync(join(dir, 'ops.env'), 'SECRETVALUE-not-a-pair\n');
    assert.throws(() => loadEnvFile(join(dir, 'ops.env'), {}), (e) => /malformed/.test(e.message) && !e.message.includes('SECRETVALUE'));
  });
});

describe('takeEnvFileFlag', () => {
  test('takes both spellings and leaves the other args in order', () => {
    assert.deepEqual(takeEnvFileFlag(['job', '--env-file', 'a.env', '--x']), { envFile: 'a.env', rest: ['job', '--x'] });
    assert.deepEqual(takeEnvFileFlag(['--env-file=b.env', 'job']), { envFile: 'b.env', rest: ['job'] });
    assert.throws(() => takeEnvFileFlag(['--env-file']), /needs a path/);
  });
});
