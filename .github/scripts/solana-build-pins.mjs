#!/usr/bin/env node
// The Solana build pipeline's own pins, checked on every solana-ci run from the repo root:
//   node .github/scripts/solana-build-pins.mjs
// Each rule keeps one finding of the Solana audit of 2026-11-15 closed. A run that checked
// nothing fails, so "found nothing wrong" and "looked at nothing" never share an exit code.
import { readFileSync, readdirSync } from 'node:fs';

const WF = '.github/workflows/';
const read = (p) => readFileSync(p, 'utf-8');
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l));
const problems = [];
let checked = 0;
const rule = (ok, msg) => {
  checked += 1;
  if (!ok) problems.push(msg);
};

// XCHL-03: avm comes from one named commit, never a branch that moves.
const AVM = /cargo install --git https:\/\/github\.com\/otter-sec\/anchor --rev ([0-9a-f]{40}) avm --locked --force$/;
const installs = readdirSync(WF)
  .filter((f) => /\.ya?ml$/.test(f))
  .flatMap((f) => code(read(WF + f)).filter((l) => l.includes('cargo install --git')).map((l) => [f, l.trim()]));
rule(installs.length === 4, `found ${installs.length} avm installs, expected 4`);
for (const [f, l] of installs) rule(AVM.test(l), `${f}: "${l}" does not install avm from one pinned commit`);
rule(new Set(installs.map(([, l]) => AVM.exec(l)?.[1])).size === 1, 'the avm installs name different commits');

if (checked === 0) problems.push('checked nothing');
for (const p of problems) console.log(`::error::${p}`);
console.log(`${checked} pins checked, ${problems.length} broken`);
process.exit(problems.length ? 1 : 0);
