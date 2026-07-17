import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { STORAGE_KEYS } from "@/lib/storage";

export type Theme = "light" | "dark";
export type ThemeMode = "light" | "dark" | "system";
const STORAGE_KEY = STORAGE_KEYS.theme;
const ThemeContext = createContext<Theme>("light");

function readStoredMode(): ThemeMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // ignore
  }
  return null;
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveTheme(mode: ThemeMode): Theme {
  return mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export function useTheme(): {
  theme: Theme;
  mode: ThemeMode;
  toggle: () => void;
  setMode: (m: ThemeMode) => void;
} {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const stored = readStoredMode();
    return stored ?? "system";
  });
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(mode));

  // Re-resolve when mode changes or the system preference flips.
  useEffect(() => {
    setTheme(resolveTheme(mode));
  }, [mode]);

  useEffect(() => {
    if (mode !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(resolveTheme("system"));
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [mode]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // ignore
    }
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => setModeState(m), []);
  const toggle = useCallback(
    () => setModeState((m) => (m === "light" ? "dark" : m === "dark" ? "system" : "light")),
    [],
  );
  return { theme, mode, toggle, setMode };
}

export function ThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  return createElement(ThemeContext.Provider, { value: theme }, children);
}

export function useThemeValue(): Theme {
  return useContext(ThemeContext);
}
