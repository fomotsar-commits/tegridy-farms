import { useState, useCallback, useEffect, useRef } from "react";

export default function Toast({ toasts, onRemove }) {
  const [dismissing, setDismissing] = useState(new Set());
  const timersRef = useRef(new Map());

  const handleDismiss = useCallback(
    (id) => {
      // Clear any pending auto-dismiss timer
      const timer = timersRef.current.get(id);
      if (timer) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
      setDismissing((prev) => {
        if (prev.has(id)) return prev; // already dismissing
        return new Set(prev).add(id);
      });
      setTimeout(() => {
        onRemove?.(id);
        setDismissing((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 300);
    },
    [onRemove],
  );

  // Auto-dismiss non-persistent toasts with animation
  useEffect(() => {
    for (const t of toasts) {
      if (t.persistent || dismissing.has(t.id) || timersRef.current.has(t.id)) continue;
      const duration = t.duration || 3500;
      const timer = setTimeout(() => {
        timersRef.current.delete(t.id);
        handleDismiss(t.id);
      }, duration);
      timersRef.current.set(t.id, timer);
    }
    // Cleanup timers for removed toasts
    const toastIds = new Set(toasts.map((t) => t.id));
    for (const [id, timer] of timersRef.current) {
      if (!toastIds.has(id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
  }, [toasts, dismissing, handleDismiss]);

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  if (!toasts.length) return null;

  return (
    <div className="toast-container" aria-live="polite" role="status">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.type}${dismissing.has(t.id) ? " toast-dismissing" : ""}`}
        >
          <span style={{ flex: 1 }}>{t.message}</span>
          {t.undoAction && (
            <button
              onClick={() => {
                t.undoAction();
                handleDismiss(t.id);
              }}
              className="toast-undo-btn"
            >
              UNDO
            </button>
          )}
          {onRemove && (
            <button
              onClick={() => handleDismiss(t.id)}
              className="toast-dismiss-btn"
              aria-label="Dismiss"
            >
              &times;
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
