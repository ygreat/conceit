import React from "react";
import ReactDOM from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import App from "../App";
import { legacyBoard, loadFromStorage, markLegacyMoved, startAutosave, toBase64 } from "../board/doc";
import { api, flushAll, getCurrent, goHome, lastBoard, newBoard, openBoard, pickAndOpen, type Loaded } from "./files";
import { Home } from "./Home";
import { startBoard } from "./persist";
import { RENAME_EVENT, revealBoard, SAVE_COPY_EVENT } from "./BoardMenu";
import "../App.css";

/**
 * Startup: decide which board to open, load it, then render.
 *  1. a file the OS asked us to open (double-click in Finder);
 *  2. `?board=<path>`, `?new`, or `?home` (moving between boards reloads the page);
 *  3. first run with a board from before board files: move it into a file;
 *  4. the board open when the app last quit;
 *  5. otherwise the home screen.
 * In a plain browser (no Tauri) the board lives in localStorage, as before.
 */
export async function boot() {
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
  const render = (node: React.ReactNode) => root.render(<React.StrictMode>{node}</React.StrictMode>);

  if (!isTauri()) {
    loadFromStorage();
    startAutosave();
    render(<App />);
    return;
  }

  const q = new URLSearchParams(window.location.search);
  let error: string | undefined;
  let loaded: Loaded | null = null;
  try {
    const pending = await api.takePending().catch(() => null);
    if (pending) loaded = await api.open(pending);
    else if (q.has("board")) loaded = await api.open(q.get("board")!);
    else if (q.has("new")) loaded = await api.create();
    else if (!q.has("home")) {
      const legacy = legacyBoard();
      if (legacy) {
        loaded = await api.importLegacy(toBase64(legacy));
        markLegacyMoved(loaded.info.path);
      } else {
        const last = lastBoard();
        if (last) loaded = await api.open(last).catch(() => null);
      }
    }
  } catch (e) {
    error = `Couldn't open the board: ${String(e).replace(/^Error: /, "")}`;
  }

  installAppEvents();
  if (loaded) {
    await startBoard(loaded);
    // Same URL on reload (e.g. after a crash), and no "?new" re-creating boards.
    window.history.replaceState(null, "", `${window.location.pathname}?board=${encodeURIComponent(loaded.info.path)}`);
    render(<App />);
  } else {
    render(<Home error={error} />);
  }
}

function installAppEvents() {
  // Native File menu.
  listen<string>("menu", ({ payload }) => {
    const onBoard = !!getCurrent().info;
    switch (payload) {
      case "board:new":
        return newBoard();
      case "board:open":
        return pickAndOpen();
      case "board:home":
      case "board:close":
        return onBoard ? goHome() : undefined;
      case "board:rename":
        return window.dispatchEvent(new Event(RENAME_EVENT));
      case "board:copy":
        return window.dispatchEvent(new Event(SAVE_COPY_EVENT));
      case "board:reveal": {
        const info = getCurrent().info;
        return info ? revealBoard(info.path) : undefined;
      }
    }
  });
  // A .conceit file double-clicked in Finder while the app is running.
  listen("board-open-request", async () => {
    const path = await api.takePending();
    if (path && path !== getCurrent().info?.path) await openBoard(path);
  });
  // Quit or window close: save, then let Rust quit.
  listen("app-will-quit", async () => {
    await flushAll();
    await invoke("app_quit_now");
  });
}
