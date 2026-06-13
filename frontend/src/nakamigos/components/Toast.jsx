import { useState, useCallback, useEffect, useRef } from "react";

// Default auto-dismiss windows. Errors and undo-able toasts get longer so the
// user has time to read / react (mirrors sonner's behavior in the main app).
const SUCCESS_DURATION = 3500;
const ERROR_DURATION = 7000;

export default function Toast({ toasts, onRemove }) {
  const [dismissing, setDismissing] = useState(new Set());
  const timersRef = useRef(new Map());
  // Tracks remaining time + deadline per toast so hover can pause/resume.
  const remainingRef = useRef(new Map());
  const [paused, setPaused] = useState(false);

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

  // Auto-dismiss non-persistent toasts with animation.
  // While `paused` (pointer/focus over the stack) we clear pending timers and
  // bank the remaining time, then resume the countdown on un-pause.
  useEffect(() => {
    const remaining = remainingRef.current;
    if (paused) {
      // Pause: clear timers, banking how long each had left.
      const now = Date.now();
      for (const [id, timer] of timersRef.current) {
        clearTimeout(timer);
        const meta = remaining.get(id);
        if (meta) remaining.set(id, { ...meta, left: Math.max(0, meta.deadline - now) });
      }
      timersRef.current.clear();
    } else {
      for (const t of toasts) {
        if (t.persistent || dismissing.has(t.id) || timersRef.current.has(t.id)) continue;
        const banked = remaining.get(t.id)?.left;
        const full = t.duration || (t.type === "error" || t.undoAction ? ERROR_DURATION : SUCCESS_DURATION);
        const duration = banked != null ? banked : full;
        remaining.set(t.id, { left: duration, deadline: Date.now() + duration });
        const timer = setTimeout(() => {
          timersRef.current.delete(t.id);
          remaining.delete(t.id);
          handleDismiss(t.id);
        }, duration);
        timersRef.current.set(t.id, timer);
      }
    }
    // Cleanup timers + banked state for removed toasts
    const toastIds = new Set(toasts.map((t) => t.id));
    for (const [id, timer] of timersRef.current) {
      if (!toastIds.has(id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
    for (const id of remaining.keys()) {
      if (!toastIds.has(id)) remaining.delete(id);
    }
  }, [toasts, dismissing, handleDismiss, paused]);

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
    <div
      className="toast-container"
      aria-live="polite"
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
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
