import { useState } from 'react';
import { shortAddress } from '../../../lib/solana/lp/format';
import { CopyButton } from '../../ui/CopyButton';
import { Row } from '../curve/ui';

/**
 * A 44-character address as a card shows it: the short form on a press that opens the
 * whole value, a Copy that copies the WHOLE value (eight base58 characters can be grinded
 * to collide, so the short form is never what leaves the page), and an explorer link when
 * the caller has one. The review (TxFlowView) keeps printing addresses in full.
 */
const PRESS = 'min-h-[44px] inline-flex items-center gap-1.5 px-1 text-[12px] underline underline-offset-2 text-white/85 hover:text-white';

export function AddressRow({ label, value, explorerUrl }: { label: string; value: string; explorerUrl?: string | null }) {
  const [whole, setWhole] = useState(false);
  const toggle = (
    <button type="button" aria-expanded={whole} onClick={() => setWhole((w) => !w)} className={whole ? PRESS : `${PRESS} sm:ml-auto`}>
      {whole ? (
        'Show less'
      ) : (
        <>
          <span className="font-mono">{shortAddress(value)}</span> <span className="text-white/60">Show whole</span>
        </>
      )}
    </button>
  );
  const others = (
    <>
      <CopyButton text={value} display="Copy" className={PRESS} />
      {explorerUrl && (
        <a href={explorerUrl} target="_blank" rel="noopener noreferrer nofollow" className={PRESS}>
          Explorer
        </a>
      )}
    </>
  );
  return (
    <div role="group" aria-label={label} className="text-white/75">
      {whole && <Row label={label} value={value} />}
      {/* Closed, on a phone: the label and the short address on one line, Copy and Explorer on
          the next, from the left edge; from `sm:` up, one line with the presses at the right.
          The press keeps its place in both forms, so it keeps focus when it is pressed. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="flex flex-wrap items-center gap-x-3 min-w-0 sm:contents">
          {!whole && <span className="break-words">{label}</span>}
          {toggle}
        </span>
        <span className="flex flex-wrap items-center gap-x-3">{others}</span>
      </div>
    </div>
  );
}
