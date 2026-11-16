import { useSyncExternalStore } from "react";
import * as Y from "yjs";
import { invoke } from "@tauri-apps/api/core";
import { allObjects, fromBase64, loadUpdates, patchDataQuietly, toBase64, ydoc, type ColorData, type DrawingData, type ImageData, type NoteData } from "../board/doc";
import { getSettings } from "../settings";
import { api, onBeforeLeave, rememberRecent, setCurrent, type Loaded } from "./files";

/**
 * Keeps the open board file in step with the board document:
 * - every change is appended to the file as a Yjs update (batched ~¼ s);
 * - local media the board uses is copied into the file (and missing media is
 *   reported, so cards can offer "Relink");
 * - a small preview is stored for the home screen;
 * - web images get a local copy (setting), so the board survives dead links.
 */

const SAVE_DELAY = 250;
/** Compact the update log on open when it has grown past this many entries. */
const COMPACT_AFTER = 80;

let pending: Uint8Array[] = [];
let chain: Promise<void> = Promise.resolve();
let saveTimer: number | undefined;
let sideTimer: number | undefined;
let previewTimer: number | undefined;
let inflight = 0;

export async function startBoard(loaded: Loaded) {
  // Listen before loading: loading can itself change the document (schema
  // migration), and Yjs needs every change in order. A change that never
  // reaches the file would make all later ones unreadable on the next open.
  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "storage") return;
    pending.push(update);
    setCurrent({ save: "saving" });
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushUpdates, SAVE_DELAY);
    window.clearTimeout(sideTimer);
    sideTimer = window.setTimeout(sideWork, 1200);
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(writePreview, 4000);
  });
  loadUpdates(loaded.updates.map(fromBase64));
  setCurrent({ info: loaded.info, save: "saved" });
  rememberRecent(loaded.info);
  setWindowTitle(loaded.info.title);

  const gaps = hasGaps();
  if (gaps) console.warn("Some saved changes couldn't be applied (missing earlier changes):", gaps);
  // Undo history doesn't survive reopening, so assets of deleted cards can go too.
  // A full snapshot also repairs a log with gaps (keeps what could be read).
  if (gaps) {
    // What they build on is gone for good; drop them so the snapshot is clean.
    const store = (ydoc as unknown as { store: { pendingStructs: unknown; pendingDs: unknown } }).store;
    store.pendingStructs = null;
    store.pendingDs = null;
  }
  if (loaded.updates.length > COMPACT_AFTER || gaps) {
    const snap = toBase64(Y.encodeStateAsUpdate(ydoc));
    await api.compact(snap, loaded.lastSeq, gaps ? undefined : referencedAssets()).catch((e) => console.warn("Compaction failed:", e));
  }
  onBeforeLeave(flushEverything);
  await flushUpdates(); // the migration change, if any
  void sideWork();
  void writePreview();
}

/** Changes Yjs is holding back because something they build on is missing. */
function hasGaps(): string | null {
  const store = (ydoc as unknown as { store: { pendingStructs: unknown; pendingDs: unknown } }).store;
  return store.pendingStructs || store.pendingDs ? "pending updates" : null;
}

export function setWindowTitle(title: string) {
  document.title = title;
  import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title)).catch(() => {});
}

function flushUpdates(): Promise<void> {
  window.clearTimeout(saveTimer);
  if (!pending.length) return chain;
  const merged = pending.length === 1 ? pending[0] : Y.mergeUpdates(pending);
  pending = [];
  inflight++;
  chain = chain.then(async () => {
    try {
      await api.append(toBase64(merged));
      inflight--;
      if (!inflight && !pending.length) setCurrent({ save: "saved", error: undefined });
    } catch (err) {
      inflight--;
      // Keep it and try again: nothing is dropped.
      pending.unshift(merged);
      setCurrent({ save: "error", error: String(err) });
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(flushUpdates, 3000);
    }
  });
  return chain;
}

async function flushEverything() {
  window.clearTimeout(sideTimer);
  window.clearTimeout(previewTimer);
  await flushUpdates();
  await Promise.allSettled([syncAssets(), writePreview()]);
}

// ---------------------------------------------------------------- Media in the file

function referencedAssets(): string[] {
  const ids = new Set<string>();
  for (const o of allObjects()) {
    const a = (o.data as { asset?: string }).asset;
    if (a && (o.type === "image" || o.type === "video")) ids.add(a);
  }
  return [...ids];
}

let missing = new Set<string>();
const missingListeners = new Set<() => void>();

/** Asset ids the board uses that are neither in the file nor on this machine. */
export function useMissing(): Set<string> {
  return useSyncExternalStore(
    (l) => {
      missingListeners.add(l);
      return () => missingListeners.delete(l);
    },
    () => missing,
  );
}

async function syncAssets() {
  const ids = referencedAssets();
  if (!ids.length) return;
  try {
    const gone = new Set(await api.storeAssets(ids));
    if (gone.size !== missing.size || [...gone].some((g) => !missing.has(g))) {
      missing = gone;
      missingListeners.forEach((l) => l());
    }
  } catch (err) {
    console.warn("Couldn't store media in the board file:", err);
  }
}

async function sideWork() {
  await syncAssets();
  cacheWebImages();
}

// ---------------------------------------------------------------- Web image copies

const tried = new Set<string>();
let caching = 0;

function cacheWebImages() {
  if (!getSettings().cacheWebImages) return;
  for (const o of allObjects()) {
    if (caching >= 2) return;
    const d = o.data as ImageData;
    if (o.type !== "image" || d.asset || !d.url || !/^https?:/i.test(d.url) || tried.has(d.url)) continue;
    tried.add(d.url);
    caching++;
    const url = d.url;
    invoke<string>("cache_web_image", { url })
      .then((asset) => {
        // Only if the card still shows that link.
        const now = allObjects().find((x) => x.id === o.id);
        if (now && (now.data as ImageData).url === url && !(now.data as ImageData).asset) patchDataQuietly(o.id, { asset });
      })
      .catch(() => {
        /* the link stays: some sites refuse downloads */
      })
      .finally(() => {
        caching--;
        cacheWebImages();
      });
  }
}

// ---------------------------------------------------------------- Home-screen preview

/** Rectangles and colors (plus a few local pictures), normalized to the board's bounds. */
export interface Preview {
  w: number;
  h: number;
  items: [x: number, y: number, w: number, h: number, fill: string, asset?: string][];
}

export function buildPreview(): Preview | null {
  const objs = allObjects().filter((o) => o.type !== "drawing" || (o.data as DrawingData).points.length);
  if (!objs.length) return null;
  const x0 = Math.min(...objs.map((o) => o.position.x)), y0 = Math.min(...objs.map((o) => o.position.y));
  const x1 = Math.max(...objs.map((o) => o.position.x + o.width)), y1 = Math.max(...objs.map((o) => o.position.y + o.height));
  let pictures = 0;
  const r = (n: number) => Math.round(n);
  const items = objs.slice(0, 400).map((o): Preview["items"][number] => {
    const d = o.data as NoteData & ColorData & ImageData & DrawingData;
    const fill =
      o.type === "color" ? d.hex : o.type === "note" ? d.tint ?? "#fff1a8" : o.type === "video" ? "#3d3b38" : o.type === "drawing" ? d.color ?? "#1d1d1f" : "#d8d3ca";
    const asset = o.type === "image" && d.asset && pictures++ < 24 ? d.asset : undefined;
    return [r(o.position.x - x0), r(o.position.y - y0), r(o.width), r(o.height), fill, ...(asset ? [asset] : [])] as Preview["items"][number];
  });
  return { w: r(x1 - x0), h: r(y1 - y0), items };
}

async function writePreview() {
  window.clearTimeout(previewTimer);
  const p = buildPreview();
  await api.setPreview(p ? JSON.stringify(p) : "").catch(() => {});
}

// Dev only: module state is bound to the open board; reload rather than hot-swap.
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload());
}
