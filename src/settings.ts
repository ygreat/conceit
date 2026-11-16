import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";

/**
 * App preferences (per machine, not per board). Kept in localStorage: if it's
 * unavailable or cleared, the app simply falls back to the defaults.
 */

export type Theme = "system" | "light" | "dark";

export interface Settings {
  theme: Theme;
  minimap: boolean;
  /** Dotted background grid. */
  grid: boolean;
  /** Snap cards to a 16 px grid while dragging. */
  snap: boolean;
  /** FPS and object-count readout. */
  stats: boolean;
  /** Draw tool brush. */
  brushColor: string;
  brushSize: number;
  /** AI panel: which access to use ("" = first one available). */
  aiProvider: "" | "claude-cli" | "codex-cli" | "anthropic-api";
  /** Model override per access; missing or "" = that provider's default. */
  aiModels: Partial<Record<"claude-cli" | "codex-cli" | "anthropic-api", string>>;
  /** Keep a copy of web images in the board file, so boards survive dead links. */
  cacheWebImages: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  minimap: true,
  grid: true,
  snap: false,
  stats: true,
  brushColor: "#1d1d1f",
  brushSize: 4,
  aiProvider: "",
  aiModels: {},
  cacheWebImages: true,
};

const KEY = "conceit.settings.v1";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable or corrupt: use defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

let current = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* not persisted this session; still applied */
  }
  if (patch.theme) applyTheme(current.theme);
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSettings,
  );
}

/** Resolved light/dark, for libraries that need a concrete value. */
export function resolvedTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Apply the theme to the page (CSS reads `data-theme`; none = follow the OS)
 * and to the native window, so the title bar matches.
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (isTauri()) {
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme === "system" ? null : theme))
      .catch((err) => console.warn("Could not set window theme:", err));
  }
}
