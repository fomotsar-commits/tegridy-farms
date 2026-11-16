#!/usr/bin/env node
// Runs first in each job of solana-deploy-artifact.yml, from the repo root, before anything is
// installed or built. A mainnet ladder or launcher build must carry the program id and deployer
// the address registry (frontend/scripts/addresses.json) names; a registry it cannot read is a
// refusal. Inputs come from env only: PROGRAM, CLUSTER, PROGRAM_ID, DEPLOYER.
import { readFileSync } from 'node:fs';

const { PROGRAM = '', CLUSTER = '', PROGRAM_ID = '', DEPLOYER = '' } = process.env;
// The registry rows that hold each program's live identities.
const ROWS = {
  'bayla-ladder': ['bayla-ladder-program', 'bayla-ladder-deployer'],
  'tegridy-launch': ['tegridy-launch-program-restart', 'tegridy-launch-deployer'],
};
const problems = [];

if (CLUSTER === 'devnet') {
  console.log('a devnet build: nothing here holds it');
  process.exit(0);
}
if (CLUSTER !== 'mainnet') problems.push(`cluster "${CLUSTER}" is neither devnet nor mainnet`);
else if (ROWS[PROGRAM]) {
  let rows = null;
  try {
    rows = JSON.parse(readFileSync('frontend/scripts/addresses.json', 'utf-8')).solana;
    if (!Array.isArray(rows)) throw new Error('it has no solana list');
  } catch (e) {
    problems.push(`the address registry could not be read (${e.message})`);
  }
  for (const [label, row, typed] of rows ? [['program id', ROWS[PROGRAM][0], PROGRAM_ID], ['deployer', ROWS[PROGRAM][1], DEPLOYER]] : []) {
    const want = rows.find((r) => r.id === row)?.address ?? '';
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(want)) problems.push(`the registry holds no address for ${row}`);
    else if (typed !== want) problems.push(`${label} "${typed}" is not ${want}, the registry's ${row}`);
    else console.log(`${label} ${typed} is the registry's ${row}`);
  }
}

for (const p of problems) console.log(`::error::refused before building: ${p}`);
if (problems.length) process.exit(1);
console.log(`a ${CLUSTER} ${PROGRAM} build may go ahead`);
