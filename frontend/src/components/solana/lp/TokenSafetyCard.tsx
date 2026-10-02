import { displaySafe } from '../../../lib/launchMetadata/validate';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { CopyButton } from '../../ui/CopyButton';
import { Card, Notice, Row } from '../curve/ui';

const VERDICT_TITLE: Record<'blocked' | 'warn' | 'ok', string> = {
  blocked: 'Blocked on this site',
  warn: 'Allowed, with warnings',
  ok: 'No problems found',
};

/**
 * What the mint itself says about a token. The mint address is always shown in full:
 * a name and a ticker are the token's own claims, and anyone can copy them.
 */
export function TokenSafetyCard({ mint, safety }: { mint: string; safety: TokenSafety }) {
  const verdict = safety.kind === 'read' ? safety.verdict : safety.kind;
  return (
    <div data-testid="token-safety" data-verdict={verdict}>
      <Card title="The token">
        <Row label="Mint address" value={mint} />
        <div>
          <CopyButton text={mint} display="Copy the mint address" className="min-h-[44px] underline text-white/70 text-[12px]" />
        </div>
        {safety.kind === 'unread' && (
          <Notice tone="warn">
            We could not read this token ({safety.detail}). That is a problem on our side, not a finding about the token.
            Nothing on this page counts as checked until it is read.
          </Notice>
        )}
        {safety.kind === 'absent' && <Notice tone="bad">There is no account at this address on Solana. It is not a token.</Notice>}
        {safety.kind === 'read' && (
          <>
            {safety.name !== null || safety.symbol !== null ? (
              <Row
                label="Calls itself"
                value={`${displaySafe(safety.name ?? '', 32) || '(no name)'} (${displaySafe(safety.symbol ?? '', 12) || 'no ticker'})`}
                mono={false}
              />
            ) : null}
            {safety.facts && (
              <Row
                label="Token program"
                value={safety.facts.program === 'spl-token' ? 'SPL Token (classic)' : 'Token-2022'}
                mono={false}
              />
            )}
            <p className="text-white text-[13px] font-semibold" data-testid="token-safety-verdict">
              {VERDICT_TITLE[safety.verdict]}
            </p>
            {safety.blocks.map((b) => (
              <Notice key={b.code + b.text} tone="bad">{b.text}</Notice>
            ))}
            {safety.warnings.map((w) => (
              <Notice key={w.code + w.text} tone="warn">{w.text}</Notice>
            ))}
            <Notice>Names and tickers can be copied by anyone. Check the mint address above against a source you trust.</Notice>
          </>
        )}
      </Card>
    </div>
  );
}
