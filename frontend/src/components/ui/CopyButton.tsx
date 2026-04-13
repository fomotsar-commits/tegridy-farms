import { useState, useRef, useEffect } from 'react';

export function CopyButton({ text, display, className = '' }: { text: string; display?: string; className?: string }) {
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
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 cursor-pointer transition-colors hover:text-white ${className}`}
      title="Copy to clipboard"
    >
      {display ?? text}
      {copied ? (
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-success flex-shrink-0">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white flex-shrink-0">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </button>
  );
}
