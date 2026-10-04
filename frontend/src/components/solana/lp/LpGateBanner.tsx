import { Card, Notice } from '../curve/ui';
import { CardArt } from '../../ui/CardArt';
import type { LpWrites } from './useLpWrites';

/**
 * Says, at the top of the LP section, why adding and removing are not offered, when
 * they are not. Nothing while the write code loads (the section still reads), and
 * nothing once the gate is open. Every "no" names what was read; a failed read says the
 * read failed, never that the program is missing.
 */
export function LpGateBanner({ writes }: { writes: LpWrites }) {
  const text = bannerText(writes);
  if (!text) return null;
  const unreadable = writes.gate?.kind === 'blocked' && writes.gate.reason === 'unreadable';
  return (
    <Card title="Adding and removing liquidity" testId="lp-gate-banner" art={<CardArt pageId="solana-lp" idx={4} />}>
      <Notice tone="warn">{text}</Notice>
      {writes.gate?.kind === 'blocked' && writes.gate.detail && <p className="text-white/40 text-[10px] break-all">{writes.gate.detail}</p>}
      {unreadable && (
        <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={writes.refreshGate}>
          Read again
        </button>
      )}
    </Card>
  );
}

function bannerText(w: LpWrites): string | null {
  if (w.status === 'load-failed') {
    return `The add and remove forms did not load (${w.detail ?? 'no detail'}). This section still reads; reload the page to try again.`;
  }
  if (w.status !== 'ready' || !w.gate) return null;
  if (w.mismatch) {
    return 'This page reads pools from a different program than the one it would send to, so nothing can be sent from here.';
  }
  switch (w.gate.kind) {
    case 'open':
      return null;
    case 'off':
      return 'Adding and removing liquidity are not set up on this site, so this section only reads.';
    case 'blocked':
      switch (w.gate.reason) {
        case 'wrong-cluster':
          return 'Your connection is on a different Solana network from this site, so nothing can be sent from here.';
        case 'cpswap-program-missing':
          return 'The pool program could not be found on the network, so nothing can be sent from here.';
        case 'unreadable':
          return 'We could not check the network just now, so adding and removing are off until we can. This does not change anything about your shares.';
        default:
          return 'Adding and removing liquidity are off here right now, so nothing can be sent from this section.';
      }
  }
}
