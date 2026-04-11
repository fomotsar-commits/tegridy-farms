import { createContext, useContext, useState, useCallback, useMemo } from "react";

const ToastContext = createContext(undefined);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = "info", opts = {}) => {
    const id = Date.now() + Math.random();
    const createdAt = Date.now();
    setToasts((prev) => {
      if (prev.some(t => t.message === message && createdAt - t.createdAt < 500)) return prev;
      return [...prev, { id, message, type, createdAt, ...opts }];
    });
    return id;
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const value = useMemo(
    () => ({ toasts, addToast, removeToast }),
    [toasts, addToast, removeToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
