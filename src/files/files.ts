import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Board files (PRD §4.1): each board is one `.conceit` file the user owns,
 * autosaved as they work. The Rust side (src-tauri/src/board.rs) holds the
 * open file; this module is its client plus the app-level state around it:
 * which board is open, save status, recent boards, and moving between boards.
 *
 * Moving between boards reloads the page (`?board=<path>` or `?home`): the
 * board document, undo history, AI suggestions and chat all start clean.
 */

export interface BoardInfo {
  path: string;
  /** Permanent id, separate from the file name (survives renames; copies get a new one). */
  id: string;
  title: string;
}

export interface Loaded {
  info: BoardInfo;
  updates: string[];
  lastSeq: number;
  assets: string[];
}

export interface Peek {
  path: string;
  id: string;
  title: string;
  updated: number;
  preview: string | null;
  bytes: number;
}

export const api = {
  create: (title?: string, path?: string) => invoke<Loaded>("board_create", { title, path }),
  open: (path: string) => invoke<Loaded>("board_open", { path }),
  importLegacy: (update: string) => invoke<Loaded>("board_import_legacy", { update }),
  close: () => invoke<void>("board_close"),
  append: (update: string) => invoke<number>("board_append", { update }),
  compact: (snapshot: string, upto: number, keepAssets?: string[]) => invoke<void>("board_compact", { snapshot, upto, keepAssets }),
  storeAssets: (ids: string[]) => invoke<string[]>("board_store_assets", { ids }),
  setPreview: (preview: string) => invoke<void>("board_set_preview", { preview }),
  rename: (title: string) => invoke<BoardInfo>("board_rename", { title }),
  saveCopy: (dest: string, includeChats: boolean) => invoke<void>("board_save_copy", { dest, includeChats }),
  peek: (paths: string[]) => invoke<({ Ok: Peek } | { Err: string })[]>("board_peek", { paths }),
  defaultDir: () => invoke<string>("board_default_dir"),
  takePending: () => invoke<string | null>("board_take_pending"),
};

// ---------------------------------------------------------------- Current board

export type SaveState = "saved" | "saving" | "error";

interface Current {
  info: BoardInfo | null;
  save: SaveState;
  error?: string;
}

let current: Current = { info: null, save: "saved" };
const listeners = new Set<() => void>();

export function getCurrent(): Current {
  return current;
}

export function setCurrent(patch: Partial<Current>) {
  current = { ...current, ...patch };
  listeners.forEach((l) => l());
}

export function useCurrent(): Current {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getCurrent,
  );
}

// ---------------------------------------------------------------- Recent boards (per machine)

export interface Recent {
  path: string;
  title: string;
  openedAt: number;
}

const RECENTS = "conceit.recents.v1";
const LAST = "conceit.lastBoard.v1";

export function recents(): Recent[] {
  try {
    const r = JSON.parse(localStorage.getItem(RECENTS) ?? "[]");
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

function saveRecents(list: Recent[]) {
  try {
    localStorage.setItem(RECENTS, JSON.stringify(list.slice(0, 30)));
  } catch {
    /* ignore */
  }
}

export function rememberRecent(info: BoardInfo, previousPath?: string) {
  saveRecents([
    { path: info.path, title: info.title, openedAt: Date.now() },
    ...recents().filter((r) => r.path !== info.path && r.path !== previousPath),
  ]);
  try {
    localStorage.setItem(LAST, info.path);
  } catch {
    /* ignore */
  }
}

export function forgetRecent(path: string) {
  saveRecents(recents().filter((r) => r.path !== path));
  if (lastBoard() === path) forgetLast();
}

export function lastBoard(): string | null {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
}

/** After closing a board on purpose, the next launch shows all boards. */
export function forgetLast() {
  try {
    localStorage.removeItem(LAST);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- Navigation

/** Runs before leaving the page (save what's pending). Set by persist.ts. */
let beforeLeave: () => Promise<void> = async () => {};
export function onBeforeLeave(fn: () => Promise<void>) {
  beforeLeave = fn;
}

export async function flushAll() {
  try {
    await beforeLeave();
  } catch (err) {
    console.warn("Saving before leaving failed:", err);
  }
}

async function go(query: string) {
  await flushAll();
  window.location.replace(`${window.location.pathname}${query}`);
}

export const openBoard = (path: string) => go(`?board=${encodeURIComponent(path)}`);
export async function goHome() {
  forgetLast();
  await go("?home");
}
/** A brand-new board in ~/Documents/Conceit. */
export const newBoard = () => go("?new");

export const BOARD_FILTER = [{ name: "Conceit board", extensions: ["conceit"] }];

/** "Open…": pick a board file. */
export async function pickAndOpen() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, directory: false, filters: BOARD_FILTER, defaultPath: await api.defaultDir().catch(() => undefined) });
  if (typeof path === "string") await openBoard(path);
}

export function prettyPath(path: string): string {
  const parts = path.split(/[\\/]/);
  const i = parts.findIndex((p) => p === "Users");
  const folder = parts.slice(0, -1);
  if (i >= 0 && folder.length > i + 1) return ["~", ...folder.slice(i + 2)].join("/");
  return folder.join("/");
}

export function ago(ms: number): string {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------- Author (for chats now, collaboration later)

const DEVICE = "conceit.device.v1";
/** A random id for this install: tags what this person wrote (AI chats today). */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE, id);
    }
    return id;
  } catch {
    return "local";
  }
}

// Dev only: module state (the open board) must not be hot-swapped.
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload());
}
