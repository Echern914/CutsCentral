"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";

type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastApi {
  toast: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Lightweight toast provider - no external dependency. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  let nextId = 0;

  const toast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = ++nextId + Date.now();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* aria-live on the always-mounted container so screen readers announce
          toasts as they arrive (WCAG 4.1.3) — errors assertively, the rest
          politely. role is per-toast so each message gets the right urgency. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2"
      >
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              role={t.kind === "error" ? "alert" : "status"}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 300, damping: 24 }}
              className={`pointer-events-auto rounded-full border px-5 py-2.5 text-sm shadow-ambient ${
                t.kind === "success"
                  ? "border-emerald-soft/30 bg-charcoal-800 text-emerald-soft"
                  : t.kind === "error"
                    ? "border-danger-soft/30 bg-charcoal-800 text-danger-soft"
                    : "border-subtle bg-charcoal-800 text-offwhite"
              }`}
            >
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

/** Returns a no-op if used outside the provider, so components stay safe. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? { toast: () => {} };
}
