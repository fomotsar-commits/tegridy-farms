// EVERY SOLANA SEND ENDS ON A PROVEN ENDING.
//
// The EVM side has had this fence since 2026-09-17 (hooks/receiptConsumers.guard.test.ts):
// a receipt wait that does not tell a revert from an unread receipt fails there, and says
// which file. This is the same fence for Solana, where the rule is older and the readers
// are three: lib/solana/confirm.ts (pollConfirm: confirmed, reverted, unknown),
// lib/launcher/solana/write/submit.ts (submitPrepared and recheckOutcome: confirmed,
// reverted, expired, unknown) and lib/solana/walletThrow.ts (declined, not-signed, unsure).
// Every sender on trunk reads them today. Nothing here changes one; it keeps the next one
// from saying "failed" for a send it only failed to hear back from, which is the sentence
// that has someone press the button again and pay twice.
//
// THE LIST IS CLOSED BOTH WAYS. A source file that hands a transaction to a Solana wallet
// or to the network is named in SENDERS with how it ends, or this fails and names it. A row
// whose file no longer sends fails too, so the list cannot rot into a history.
//
// NOTHING SUBSCRIBES. `connection.confirmTransaction` and `onSignature` open a websocket,
// the browser talks to /api/solrpc over HTTPS only and the CSP has no wss origin
// (lib/solana/confirm.ts, its first note). The count is pinned at zero.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { code } from '../../test/sourceCode';
import type { ConfirmOutcome } from './confirm';
import type { SendThrow } from './walletThrow';
import type { TxOutcome } from '../launcher/solana/write/types';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.(test|fixture)\./.test(e.name)) acc.push(p);
  }
  return acc;
}

// The one-pass reader, shared with the EVM guard (hooks/receiptConsumers.guard.test.ts).
export { code };

// A call only Solana has, or one both rails have in a file that imports a Solana package.
const SOLANA_ONLY = /\.signAllTransactions\(|\.signAndSendTransaction\(|\.sendRawTransaction\(|\bsignV1\(|\bsubmitPrepared\(|\bsendSigned\(/;
const EITHER_RAIL = /\.signTransaction\(|\bsendTransaction\(/;
const SOLANA_IMPORT = /from\s+['"]@(?:solana|streamflow)\//;
export const sends = (src: string): boolean => SOLANA_ONLY.test(src) || (EITHER_RAIL.test(src) && SOLANA_IMPORT.test(src));

/** The wallet is asked in this file, so its throw is read in this file. */
const ASKS_WALLET = /\.signTransaction\(|\.signAllTransactions\(|\bsendTransaction\(|\bsignV1\(/;
const READS_THROW = /\b(?:readSendThrow|signThrowCopy)\(/;
const ENDER = { pollConfirm: /\bpollConfirm\(/, submitPrepared: /\bsubmitPrepared\(/, sendSigned: /\bsendSigned\(/ } as const;
const ANY_ENDER = /\b(?:pollConfirm|submitPrepared|sendSigned)\(/;
const SUBSCRIBES = /\.confirmTransaction\(|\.onSignature\(/g;

type How =
  /** Calls a proven ending itself. */
  | { ends: keyof typeof ENDER }
  /** Hands the wallet's own function to the file that sends and ends. */
  | { passes: string }
  /** A vendor SDK broadcasts inside one call; the file reads every throw as sent or not. */
  | { sdk: string }
  /** Adapts a wallet. Sends nothing of its own. */
  | { plumbing: string };

/** Every source file that moves a Solana transaction, and how the person is told what happened. */
export const SENDERS: Record<string, How> = {
  // The swap page: Jupiter's swap (walletSwapSend.ts), and DCA and limit orders (walletWrite.ts sendBuiltTx).
  'pages/SolanaSwapPage.tsx': { passes: 'lib/solana/swap/walletSwapSend.ts' },
  // A swap in the venue's own pool, through the review screen.
  'components/swap/useVenueSwap.ts': { ends: 'submitPrepared' },
  // The island basket: each coin on its own approval, through the swap's send or the write layer's.
  'components/swap/IslandBasketSolana.tsx': { passes: 'lib/solana/swap/walletSwapSend.ts' },
  // Add, remove, open a pool, range pools, the launch curve: the review screen's one writer.
  'lib/launcher/solana/write/submit.ts': { ends: 'submitPrepared' },
  'components/solana/curve/ports.ts': { ends: 'submitPrepared' },
  'components/solana/curve/useTxFlow.ts': { ends: 'submitPrepared' },
  // Harvest's pool fees: each share's Claim fees, built and sent as the Pools panel sends it.
  'components/solana/lp/harvestFees.ts': { ends: 'submitPrepared' },
  // Add with one coin: its swap leg (oneCoinSwap.ts) is signed by the wallet and sent and watched by the swap's own send.
  'components/solana/lp/AddOneCoinPanel.tsx': { passes: 'lib/solana/swap/walletSwapSend.ts' },
  // A Jupiter swap: the wallet signs, the page sends, sends again and watches (the swap, step 1 of a one-coin add, a basket coin).
  'lib/solana/swap/walletSwapSend.ts': { ends: 'sendSigned' },
  // Every write with no review screen: the BAYLA ladder, the lighthouse pools, each claim of
  // Claim all, DCA and limit orders. Tested, SOL checked, signed only, sent by us.
  'lib/solana/walletWrite.ts': { ends: 'sendSigned' },
  // The send itself: preflight first, the same bytes again every 2 s, polled.
  'lib/solana/sendSigned.ts': { ends: 'pollConfirm' },
  'lib/solana/v1Signer.ts': { plumbing: 'finds a wallet\'s version 1 signing feature; the caller sends' },
  'lib/solanaWallets.ts': { plumbing: 'wallet adapters; the page that asks sends' },
};

/**
 * The files that may hand a Solana wallet its own send (`sendTransaction`), and why: only as
 * the fallback for a wallet that cannot sign alone (walletSwapSend.ts `viaWalletSend`). Every
 * other send is ours, after the wallet SIGNED (Phantom, ticket #467471).
 */
export const WALLET_SEND_FALLBACK: Record<string, string> = {
  'pages/SolanaSwapPage.tsx': 'the swap\'s signAndSend, for a wallet with no signTransaction',
  'components/swap/IslandBasketSolana.tsx': 'a basket coin\'s signAndSend, for a wallet with no signTransaction',
  'components/solana/lp/AddOneCoinPanel.tsx': 'the one-coin add\'s swap step, for a wallet with no signTransaction',
};
const PLUMBING = new Set(Object.entries(SENDERS).filter(([, h]) => 'plumbing' in h).map(([f]) => f));

const files = walk(SRC).map((f) => ({ file: relative(SRC, f).replace(/\\/g, '/'), src: code(readFileSync(f, 'utf8')) }));
const senders = files.filter(({ src }) => sends(src));
const srcOf = (file: string): string => files.find((f) => f.file === file)?.src ?? '';

/** What is wrong with a sender's row, or null. `listed` is its row in SENDERS, when it has one. */
export function fault(file: string, src: string, listed: How | undefined, read: (f: string) => string = srcOf): string | null {
  if (!listed) return `${file}: sends a Solana transaction and is not named in SENDERS (say how it ends)`;
  if ('ends' in listed) {
    if (!ENDER[listed.ends].test(src)) return `${file}: named as ending on ${listed.ends}() and never calls it`;
  } else if ('passes' in listed) {
    const to = read(listed.passes);
    if (!to) return `${file}: passes to ${listed.passes}, which is not a source file`;
    if (!ANY_ENDER.test(to)) return `${file}: passes to ${listed.passes}, which calls no proven ending`;
    if (!READS_THROW.test(to)) return `${file}: passes to ${listed.passes}, which never reads the wallet's throw`;
    return null;
  } else if ('plumbing' in listed) {
    return listed.plumbing.trim() ? null : `${file}: plumbing with no reason given`;
  } else if (!listed.sdk.trim()) {
    return `${file}: an SDK send with no reason given`;
  }
  if (ASKS_WALLET.test(src) && !READS_THROW.test(src)) return `${file}: asks the wallet and never reads its throw (readSendThrow or signThrowCopy)`;
  return null;
}

describe('every Solana send ends on a proven ending', () => {
  it('finds the senders (a scan that matched nothing would pass vacuously)', () => {
    expect(senders.length).toBeGreaterThanOrEqual(10);
  });

  it('names every file that sends, and no file that does not', () => {
    const found = senders.map((s) => s.file).sort();
    expect(found, 'a file sends a Solana transaction and SENDERS does not say how it ends, or a row names a file that no longer sends').toEqual(
      Object.keys(SENDERS).sort(),
    );
  });

  it('holds every sender to its row', () => {
    const faults = senders.map(({ file, src }) => fault(file, src, SENDERS[file])).filter((f): f is string => f !== null);
    expect(faults).toEqual([]);
  });

  it('passes only to a file that exists', () => {
    const gone = Object.values(SENDERS)
      .filter((h): h is { passes: string } => 'passes' in h)
      .filter((h) => !existsSync(join(SRC, h.passes)))
      .map((h) => h.passes);
    expect(gone).toEqual([]);
  });

  it('opens no websocket to confirm: no confirmTransaction, no onSignature', () => {
    const subs = files.filter(({ src }) => (src.match(SUBSCRIBES) ?? []).length > 0).map(({ file }) => file);
    expect(subs, 'the browser has no wss origin to subscribe on; poll with pollConfirm').toEqual([]);
  });

  it('keeps "we cannot tell" among the endings, at compile time', () => {
    // Each line stops compiling the day its ending is cut from the union it belongs to.
    const unknown: ConfirmOutcome['outcome'] = 'unknown';
    const unsure: SendThrow['kind'] = 'unsure';
    const stillOut: TxOutcome['status'] = 'unknown';
    const safeToRetry: TxOutcome['status'] = 'expired';
    expect([unknown, unsure, stillOut, safeToRetry]).toEqual(['unknown', 'unsure', 'unknown', 'expired']);
  });
});

// PHANTOM'S RULES (ticket #467471, 2026-11-16; docs.phantom.com "Domain and transaction
// warnings"): one transaction per wallet approval, asked with signTransaction, and sent by
// us with preflight on. A request carrying two or more transactions is one Phantom may
// block outright as "Request blocked" (RELIABLE_SIMULATION_NOT_POSSIBLE).
const SIGNS_SEVERAL = /\.signAllTransactions\(|\.signAndSendAllTransactions\(|\.signTransaction\(\s*\.\.\./;
const WALLET_SENDS = /\bsendTransaction\(|\.signAndSendTransaction\(/;

/** What breaks Phantom's rules in a sender, or null. */
export function phantomFault(file: string, src: string): string | null {
  if (PLUMBING.has(file)) return null;
  if (SIGNS_SEVERAL.test(src)) return `${file}: asks a Solana wallet to sign several transactions on one approval`;
  if (WALLET_SENDS.test(src) && !(file in WALLET_SEND_FALLBACK)) return `${file}: has a Solana wallet send a transaction itself`;
  return null;
}

describe('every Solana send keeps Phantom\'s rules', () => {
  it('asks no wallet to sign several transactions on one approval, and lets no wallet send but a wallet that cannot sign alone', () => {
    const faults = senders.map(({ file, src }) => phantomFault(file, src)).filter((f): f is string => f !== null);
    expect(faults).toEqual([]);
  });

  it('names a fallback only for a file that still has one', () => {
    const gone = Object.keys(WALLET_SEND_FALLBACK).filter((f) => !WALLET_SENDS.test(srcOf(f)));
    expect(gone).toEqual([]);
  });

  it('seen red: a batch and a wallet send are both caught', () => {
    expect(phantomFault('lib/new/claim.ts', 'const s = await wallet.signAllTransactions(txs);')).toMatch(/several transactions/);
    expect(phantomFault('lib/new/claim.ts', 'await feature.signTransaction(...list.map((t) => t));')).toMatch(/several transactions/);
    expect(phantomFault('lib/new/claim.ts', 'const sig = await invoker.sendTransaction(tx, conn);')).toMatch(/send a transaction itself/);
    expect(phantomFault('lib/new/claim.ts', 'const signed = await wallet.signTransaction(tx);')).toBeNull();
  });
});

describe('the fence itself, seen red', () => {
  it('reads a line comment that carries /* as a line comment', () => {
    const src = "// load before any @solana/* import\nconst sig = await conn.sendRawTransaction(raw);\n/* gone */ const b = 1;";
    expect(code(src)).toContain('sendRawTransaction(');
    expect(code(src)).not.toContain('gone');
  });

  it('keeps // inside a string and drops a commented-out send', () => {
    expect(code("const u = 'https://solscan.io/tx/';")).toContain('https://solscan.io/tx/');
    expect(sends(code('// await conn.sendRawTransaction(raw);\nconst a = 1;'))).toBe(false);
  });

  it('leaves the EVM rail to its own guard', () => {
    expect(sends("import { useSendTransaction } from 'wagmi';\nsendTransaction({ to, value });")).toBe(false);
    expect(sends("import { useWallet } from '@solana/wallet-adapter-react';\nawait sendTransaction(tx, connection);")).toBe(true);
  });

  it('fails a new sender that is not on the list', () => {
    const src = "import { Connection } from '@solana/web3.js';\nconst sig = await conn.sendRawTransaction(raw);";
    expect(sends(src)).toBe(true);
    expect(fault('lib/new/claim.ts', src, undefined)).toMatch(/not named in SENDERS/);
  });

  it('fails a row that names an ending the file never calls', () => {
    const src = "import { Connection } from '@solana/web3.js';\nconst sig = await conn.sendRawTransaction(raw);\ntoast.error('Swap failed');";
    expect(fault('lib/new/claim.ts', src, { ends: 'pollConfirm' })).toMatch(/never calls it/);
  });

  it('fails a file that asks the wallet and never reads its throw', () => {
    const src = "import { useWallet } from '@solana/wallet-adapter-react';\nconst sig = await sendTransaction(tx, connection);\nawait pollConfirm(connection, sig);";
    expect(fault('pages/New.tsx', src, { ends: 'pollConfirm' })).toMatch(/never reads its throw/);
  });

  it('fails a pass to a file that ends nothing', () => {
    const src = "import { useWallet } from '@solana/wallet-adapter-react';\nrun((tx) => sendTransaction(tx, connection));";
    expect(fault('components/New.tsx', src, { passes: 'lib/new/run.ts' }, () => 'export const run = () => 1;')).toMatch(/calls no proven ending/);
  });
});
