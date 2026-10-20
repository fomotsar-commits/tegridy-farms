import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChainIcon } from '../ui/ChainIcon';
import { VENUE_CHAINS, venueChain, type VenueChain } from '../../lib/sectionChains';

export interface ChainPickerOption {
  chain: VenueChain;
  /** Off: listed and greyed, with `note` saying why. */
  enabled: boolean;
  /** One short line under the name: where it routes, or why it is off. */
  note?: string;
}

export interface ChainPickerProps {
  /** Accessible name of the button and its list, e.g. "Swap network". */
  label: string;
  active: VenueChain;
  options: readonly ChainPickerOption[];
  onPick: (chain: VenueChain) => void;
  /** Stretch the button to its row's height (beside a tab strip). */
  stretch?: boolean;
  /** 'end': the list opens from the button's right edge, for a picker near the screen's right side. */
  align?: 'start' | 'end';
}

const PANEL_BG = 'rgba(13,21,48,0.97)';
const BOX = {
  background: 'rgba(13,21,48,0.92)',
  border: '1px solid rgba(255,255,255,0.22)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
} as const;

/**
 * The network drop-down (owner, 2026-10-15, after Uniswap's): one button with the network's
 * mark and name, and a list of all four networks under it. A network the section has nothing on
 * stays listed, greyed, with its reason; nothing here says Soon (docs/FACE_LAWS.md, law 23).
 * Presentational: the section's hook (useSectionChain) owns where a pick goes.
 */
export function ChainPicker({ label, active, options, onPick, stretch = false, align = 'start' }: ChainPickerProps) {
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const listId = useId();
  const current = venueChain(active);
  const rows = VENUE_CHAINS.map((c) => ({ info: c, option: options.find((o) => o.chain === c.id) }));

  // Close on a press outside, as any menu does.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Opening puts the keyboard on the lit network.
  useEffect(() => {
    if (open) optionRefs.current[focusIdx]?.focus();
  }, [open, focusIdx]);

  const toggle = () => {
    if (!open) setFocusIdx(Math.max(0, rows.findIndex((r) => r.info.id === active)));
    setOpen((o) => !o);
  };

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const pick = (chain: VenueChain) => {
    setOpen(false);
    buttonRef.current?.focus();
    if (chain !== active) onPick(chain);
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setFocusIdx((i) => (i + step + rows.length) % rows.length);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setFocusIdx(e.key === 'Home' ? 0 : rows.length - 1);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={`relative shrink-0 ${stretch ? 'self-stretch flex' : 'inline-flex'}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${current.name}`}
        onClick={toggle}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
            e.preventDefault();
            toggle();
          }
        }}
        className={`inline-flex items-center gap-2 px-3 min-h-[44px] min-[800px]:min-h-[40px] rounded-2xl text-white text-[12.5px] md:text-[13.5px] font-medium whitespace-nowrap ${stretch ? 'h-full' : ''}`}
        style={BOX}
      >
        <ChainIcon chain={active} size={20} />
        <span>{current.short}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={`opacity-70 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          onKeyDown={onListKey}
          className={`absolute ${align === 'end' ? 'right-0' : 'left-0'} top-full mt-2 z-50 w-[min(17rem,calc(100vw-2rem))] rounded-2xl p-1.5`}
          style={{ ...BOX, background: PANEL_BG }}
        >
          <p className="px-2.5 pt-1.5 pb-1 text-[11px] uppercase tracking-wider text-white/55">Select a network</p>
          {rows.map(({ info, option }, i) => {
            const enabled = option?.enabled ?? false;
            const selected = info.id === active;
            return (
              <button
                key={info.id}
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                type="button"
                role="option"
                aria-selected={selected}
                aria-disabled={!enabled && !selected}
                tabIndex={i === focusIdx ? 0 : -1}
                onClick={() => (enabled || selected ? pick(info.id) : undefined)}
                className={`w-full flex items-center gap-3 px-2.5 py-2 min-h-[44px] rounded-xl text-left transition-colors ${
                  enabled || selected ? 'hover:bg-white/10 focus-visible:bg-white/10' : 'cursor-not-allowed opacity-50'
                } ${selected ? 'bg-white/[0.07]' : ''}`}
              >
                <ChainIcon chain={info.id} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="block text-white text-[13.5px] font-medium leading-tight">{info.name}</span>
                  {option?.note && <span className="block text-white/60 text-[11px] leading-tight mt-0.5">{option.note}</span>}
                </span>
                {selected && (
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 text-white">
                    <circle cx="8" cy="8" r="8" fill="currentColor" />
                    <path d="M4.5 8.2l2.2 2.2 4.8-4.8" fill="none" stroke="#0d1530" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
