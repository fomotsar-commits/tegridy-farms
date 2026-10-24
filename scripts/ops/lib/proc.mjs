// Run a child process to completion and collect what it said. Never throws: a spawn
// error, a timeout or a signal comes back as data for the job to judge.

import { spawn } from 'node:child_process';

const CAP = 8 * 1024 * 1024;

export function runProcess(cmd, args, { cwd, env, timeoutMs = 10 * 60_000, shell = false } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ code: null, signal: null, stdout, stderr, timedOut, error: e.message });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (d) => { if (stdout.length < CAP) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < CAP) stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, timedOut, error: e.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, error: null });
    });
  });
}

/** Parse what a script appended to $GITHUB_OUTPUT: key=value lines and key<<DELIM blocks. Last write wins. */
export function parseGithubOutput(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const block = /^([A-Za-z_][A-Za-z0-9_-]*)<<(.+)$/.exec(lines[i]);
    if (block) {
      const end = lines.indexOf(block[2], i + 1);
      if (end === -1) break;
      out[block[1]] = lines.slice(i + 1, end).join('\n');
      i = end;
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/.exec(lines[i]);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}
