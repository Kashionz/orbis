// 畫面底部置中的短暫提示（例如「已複製」）。

import "./Toast.css";
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

const TOAST_MS = 2200;

interface ToastApi {
  show: (text: string) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((next: string) => {
    setText(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(null), TOAST_MS);
  }, []);
  const [api] = useState<ToastApi>(() => ({ show }));
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="o-toast-region">
        {text && (
          <div key={text} className="o-toast">
            {text}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
