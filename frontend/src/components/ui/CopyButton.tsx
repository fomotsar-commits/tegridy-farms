import { useState, useRef, useEffect, type ReactNode } from 'react';
import { tick } from '../../lib/tick';

export function CopyButton({ text, display, children, copiedMs = 2000, copiedWord, className = '', wordsClassName, style, 'aria-label': ariaLabel, testId }: {
  text: string;
  display?: string;
  /** What the press shows instead of `display`: CoinName's name and head-and-tail. */
  children?: ReactNode;
  /** How long "copied" shows. CoinName asks for one second (island answer twenty-four, §4). */
  copiedMs?: number;
  /** A visible word while copied, beside the tick mark; the live region says it either way. */
  copiedWord?: string;
  className?: string;
  /** Wraps the words and the icon in a span of this class, for a caller that styles them apart from the button's box. */
  wordsClassName?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for older browsers
      const el = document.createElement('textarea');
      el.value = text;
      Object.assign(el.style, { position: 'fixed', left: '-9999px', opacity: '0' });
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    // The phone's tick on every copy, where the browser gives one (answer twenty-four, §2b).
    tick();
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), copiedMs);
  };

  const words = (
    <>
      {children ?? display ?? text}
      {copied ? (
        <>
          {copiedWord && <span className="text-success text-[11px] font-medium">{copiedWord}</span>}
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-success flex-shrink-0">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </>
      ) : (
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white flex-shrink-0">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
    </>
  );

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 cursor-pointer transition-opacity hover:opacity-80 ${className}`}
      style={style}
      title="Copy to clipboard"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {wordsClassName ? <span className={`inline-flex items-center gap-1.5 ${wordsClassName}`}>{words}</span> : words}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </button>
  );
}
