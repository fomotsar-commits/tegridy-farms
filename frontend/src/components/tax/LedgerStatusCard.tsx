import type { LedgerRead } from '../../hooks/useWalletLedger';
import { MAX_LEDGER_PAGES } from '../../hooks/useWalletLedger';

// WHAT WAS READ, SAID BEFORE ANY FIGURE IS SHOWN.
//
// The report below this card renders totals whatever happens; this card is the
// only place that says whether those totals are about anything. Each state gets
// its own sentence rather than a shared "couldn't load" because they are not
// the same fact and they do not have the same fix:
//
//   head-unavailable   the app's own RPC did not answer, so no window could be
//                      pinned and NOTHING was requested from the explorer.
//   explorer-keyless   the deployment has no working ETHERSCAN_API_KEY. This is
//                      an OPERATOR state and the operator step is printed, on
//                      the page, where a visitor can quote it in a bug report.
//   rate-limited       a temporary refusal. "Try again" is the honest advice
//                      here and dishonest in the two states above it.
//
// Every one of them is ALSO a whole-period gap on every export (see
// lib/tax/coverage.ts) — this card is the courtesy, the file is the record.
//
// WHY THE PILL AND THIS CARD DISAGREE ON PURPOSE. The /tax nav entry carries no
// SOON pill, because the rail is a repo fact: /api/etherscan ships with every
// deployment and allowlists the three actions this read needs. Whether the
// deployment's server-side key is set is not readable in the browser at
// nav-render time, so the disclosure lives here, where the state IS readable.
// lib/tax/rails.ts holds the full reasoning.

const ACTION_LABEL: Record<string, string> = {
  txlist: 'transactions',
  txlistinternal: 'internal transfers',
  tokentx: 'token transfers',
};

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function bodyFor(read: LedgerRead): { tone: 'neutral' | 'good' | 'warn'; lines: string[] } {
  switch (read.status) {
    case 'idle':
      return {
        tone: 'neutral',
        lines: ['No wallet connected — nothing has been read for anyone.'],
      };
    case 'loading':
      return {
        tone: 'neutral',
        lines: [
          `Reading Ethereum mainnet history through this deployment’s explorer proxy — ` +
            `${ACTION_LABEL[read.action] ?? read.action}, page ${read.page} of at most ${MAX_LEDGER_PAGES}.`,
        ],
      };
    case 'ready': {
      const lines = [
        `Ethereum mainnet history read through Etherscan (via /api/etherscan): rows the explorer had ` +
          `indexed up to block ${read.head.block.toString()} at read time (${iso(read.head.timestamp)}, by ` +
          `the chain’s own clock) — ${read.ledger.transferCount} transfers in ${read.ledger.txs.length} ` +
          'transactions. Base and other chains were not read.',
      ];
      if (read.ledger.truncated.length > 0 && read.ledger.cut !== null) {
        lines.push(
          `More than ${MAX_LEDGER_PAGES * 500} rows exist in at least one list; everything before ` +
            `${iso(read.ledger.cut)} was not fully read and is a declared gap. Transactions before it are ` +
            'not classified, and lots acquired before it are unknown, not zero.',
        );
      }
      return { tone: 'good', lines };
    }
    case 'failed':
      switch (read.reason) {
        case 'head-unavailable':
          return { tone: 'warn', lines: [read.detail] };
        case 'explorer-keyless':
          return {
            tone: 'warn',
            lines: [
              'Ethereum history could not be read. The explorer proxy answered without data — its ' +
                'server-side key is missing or rejected — so nothing about this wallet was concluded.',
              'Operator step: set ETHERSCAN_API_KEY on the deployment so /api/etherscan can answer. Until ' +
                'then the whole period is a declared gap on every export.',
            ],
          };
        case 'explorer-rate-limited':
        case 'proxy-rate-limited':
          return {
            tone: 'warn',
            lines: [
              'The explorer is rate-limiting this deployment right now. Nothing was concluded — try again ' +
                'in a minute. The whole period stays a declared gap until a read succeeds.',
            ],
          };
        default:
          return {
            tone: 'warn',
            lines: [
              read.detail,
              'Nothing about this wallet was concluded, and the whole period is a declared gap on every ' +
                'export until a read succeeds.',
            ],
          };
      }
  }
}

const TONE_CLASS: Record<'neutral' | 'good' | 'warn', string> = {
  neutral: 'border-white/15 bg-white/[0.02]',
  good: 'border-emerald-400/25 bg-emerald-400/[0.06]',
  warn: 'border-amber-400/30 bg-amber-400/[0.06]',
};

export function LedgerStatusCard({ read }: { read: LedgerRead }) {
  const { tone, lines } = bodyFor(read);
  return (
    <section className={`rounded-xl border p-4 ${TONE_CLASS[tone]}`}>
      <h2 className="text-sm font-semibold text-white">What was read</h2>
      {lines.map((line) => (
        <p key={line.slice(0, 48)} className="mt-2 text-[13px] leading-relaxed text-white/85">
          {line}
        </p>
      ))}
      <p className="mt-3 text-[11px] leading-relaxed text-white/50">
        Source: Etherscan, through this deployment’s own <code className="text-white/70">/api/etherscan</code>{' '}
        proxy — the same rail the activity and deployer surfaces read. Ethereum mainnet only; the venue’s
        indexer is used as an extra source only where one is configured.
      </p>
    </section>
  );
}

export default LedgerStatusCard;
