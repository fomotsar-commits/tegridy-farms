#!/usr/bin/env node
// ---------------------------------------------------------------------------
// diff-addresses.ts — Wave 0 helper for the Tegriddy Farms Spartan Battle Plan.
//
// Role: after scripts/redeploy-patched-3.sh finishes, this script reads the
//       three broadcast JSONs produced by Foundry, pulls out the freshly-
//       deployed contract addresses, and prints a copy-pasteable diff showing
//       the exact lines to change in frontend/src/lib/constants.ts.
//
// This script is READ-ONLY. It never writes to constants.ts. The user applies
// the patch manually after reviewing the output.
//
// Run it with:   npx tsx scripts/diff-addresses.ts
//
// Exits non-zero if:
//   - any of the three broadcast JSONs is missing
//   - any broadcast JSON is older than 1 hour (stale — likely a prior run)
//   - any expected contract name is absent from the broadcast transactions
// ---------------------------------------------------------------------------

import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const BROADCAST_DIR = resolve(REPO_ROOT, 'contracts', 'broadcast');
const CONSTANTS_PATH = resolve(REPO_ROOT, 'frontend', 'src', 'lib', 'constants.ts');

const ONE_HOUR_MS = 60 * 60 * 1000;
const CHAIN_ID = '1'; // mainnet

// Each target describes one deploy we want to read back.
//   scriptFile    — the *.s.sol filename (Foundry names broadcast dirs by this)
//   contractName  — the Solidity contract whose address we want
//   constantName  — the symbol in frontend/src/lib/constants.ts to diff
interface Target {
  label: string;
  scriptFile: string;
  contractName: string;
  constantName: string;
}

const TARGETS: Target[] = [
  {
    label: 'TegridyLPFarming',
    scriptFile: 'DeployTegridyLPFarming.s.sol',
    contractName: 'TegridyLPFarming',
    constantName: 'LP_FARMING_ADDRESS',
  },
  {
    label: 'TegridyNFTLending',
    scriptFile: 'DeployNFTLending.s.sol',
    contractName: 'TegridyNFTLending',
    constantName: 'TEGRIDY_NFT_LENDING_ADDRESS',
  },
];

interface BroadcastTx {
  contractName?: string | null;
  contractAddress?: string | null;
  transactionType?: string;
}

interface BroadcastFile {
  transactions?: BroadcastTx[];
  timestamp?: number;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function loadBroadcast(target: Target): { address: string; mtimeMs: number } {
  const jsonPath = resolve(BROADCAST_DIR, target.scriptFile, CHAIN_ID, 'run-latest.json');

  if (!existsSync(jsonPath)) {
    fail(
      `Missing broadcast JSON for ${target.label}.\n` +
        `       Expected: ${jsonPath}\n` +
        `       Did scripts/redeploy-patched-3.sh run successfully?`
    );
  }

  const stat = statSync(jsonPath);
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > ONE_HOUR_MS) {
    const ageMin = Math.round(ageMs / 60000);
    fail(
      `Broadcast JSON for ${target.label} is stale (${ageMin} min old).\n` +
        `       Path: ${jsonPath}\n` +
        `       Re-run scripts/redeploy-patched-3.sh before diffing addresses.`
    );
  }

  const raw = readFileSync(jsonPath, 'utf8');
  let parsed: BroadcastFile;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`Failed to parse ${jsonPath}: ${(err as Error).message}`);
  }

  const txs = parsed.transactions ?? [];
  // Prefer CREATE transactions, but fall back to any tx that matches.
  const match =
    txs.find(
      (t) =>
        t.contractName === target.contractName &&
        !!t.contractAddress &&
        (t.transactionType === 'CREATE' || t.transactionType === 'CREATE2')
    ) ?? txs.find((t) => t.contractName === target.contractName && !!t.contractAddress);

  if (!match || !match.contractAddress) {
    fail(
      `Could not find a ${target.contractName} deployment in ${jsonPath}.\n` +
        `       The script may have failed mid-run, or the contract name changed.`
    );
  }

  return { address: match.contractAddress, mtimeMs: stat.mtimeMs };
}

function loadConstantsLine(constantName: string): { lineNumber: number; line: string } {
  if (!existsSync(CONSTANTS_PATH)) {
    fail(`Cannot find ${CONSTANTS_PATH}`);
  }
  const text = readFileSync(CONSTANTS_PATH, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // Match:  export const NAME = '0x...' as const;
    const re = new RegExp(
      `^\\s*export\\s+const\\s+${constantName}\\s*=\\s*['"\`]0x[0-9a-fA-F]+['"\`]`
    );
    if (re.test(lines[i])) {
      return { lineNumber: i + 1, line: lines[i] };
    }
  }
  fail(`Could not find "export const ${constantName} = '0x...'" in ${CONSTANTS_PATH}`);
}

function buildReplacementLine(originalLine: string, newAddress: string): string {
  // Swap only the 0x... literal, preserve quoting, spacing, `as const`, comments.
  return originalLine.replace(/0x[0-9a-fA-F]+/, newAddress);
}

function main(): void {
  console.log('// ---------------------------------------------------------------');
  console.log('// frontend/src/lib/constants.ts — patch to apply after Wave 0');
  console.log('// Source: newest broadcast JSONs under contracts/broadcast/');
  console.log(`// Generated: ${new Date().toISOString()}`);
  console.log('// ---------------------------------------------------------------');
  console.log('');

  let ok = true;

  for (const target of TARGETS) {
    try {
      const { address, mtimeMs } = loadBroadcast(target);
      const { lineNumber, line } = loadConstantsLine(target.constantName);
      const newLine = buildReplacementLine(line, address);

      const ageMin = Math.round((Date.now() - mtimeMs) / 60000);
      console.log(`// ${target.label}`);
      console.log(`// broadcast age: ${ageMin} min   constants.ts line ${lineNumber}`);
      if (line === newLine) {
        console.log(`// (no change — on-chain address already matches constants.ts)`);
      } else {
        console.log(`- ${line}`);
        console.log(`+ ${newLine}`);
      }
      console.log('');
    } catch (err) {
      ok = false;
      console.error((err as Error).message);
    }
  }

  if (!ok) {
    process.exit(1);
  }

  console.log('// ---------------------------------------------------------------');
  console.log('// Apply the +/- lines above to frontend/src/lib/constants.ts,');
  console.log('// then rebuild the frontend.');
  console.log('// ---------------------------------------------------------------');
}

main();
