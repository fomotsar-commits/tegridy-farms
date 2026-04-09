import { createContext, useContext, useState, useCallback } from "react";

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

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
