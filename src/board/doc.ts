import * as Y from "yjs";

/**
 * Board document — the single source of truth (PRD §6, §9).
 *
 * React Flow renders a *view* of this Yjs doc. Persisted state (positions,
 * sizes, content) lives here; UI-only state (selection, in-progress drags)
 * stays in React. Keeping the board in a CRDT from day one is what makes
 * Figma-style multiplayer an add-on later instead of a rewrite.
 */

export type ObjectKind = "note" | "image" | "video" | "color" | "drawing";

/** Every card can carry a custom name and a color. Empty = default. */
interface Titled {
  title?: string;
  /** Block color: fills a note; tints the header and border of other cards. */
  tint?: string;
  /** Made by the AI panel (PRD §5.1 provenance): the cards it was read from. */
  ai?: { from: string[]; provider?: string };
}

export interface NoteData extends Titled {
  text: string;
}
/** Media comes from a web link (`url`) or a local file in the asset store (`asset`). */
export interface ImageData extends Titled {
  url?: string;
  asset?: string;
  name?: string;
  /** Card already fitted to the image's real aspect ratio. */
  sized?: boolean;
  /**
   * Reference slot: an image card with no picture yet, holding what to look
   * for (a search query). Pasting or typing a link fills it.
   */
  find?: string;
  /** Why this reference belongs on the board (shown on the slot). */
  why?: string;
}
export interface VideoData extends Titled {
  url?: string;
  asset?: string;
  name?: string;
  /** Card height already fitted to the video's aspect ratio. */
  sized?: boolean;
}
export interface ColorData extends Titled {
  hex: string;
}

/**
 * A freehand stroke. `points` are x,y pairs in the stroke's original box
 * (`w0`×`h0`); resizing the object scales them, the brush width stays put.
 */
export interface DrawingData extends Titled {
  points: number[];
  w0: number;
  h0: number;
  color: string;
  size: number;
}

export type ObjectData = NoteData | ImageData | VideoData | ColorData | DrawingData;

export interface BoardObject {
  id: string;
  type: ObjectKind;
  position: { x: number; y: number };
  width: number;
  height: number;
  data: ObjectData;
}

export type MarkerShape = "none" | "arrow" | "triangle" | "circle" | "diamond";
export type LinePath = "bezier" | "smoothstep" | "straight";
export type LineDash = "solid" | "dashed" | "dotted";

export interface LineStyle {
  color: string;
  width: number;
  dash: LineDash;
  path: LinePath;
  start: MarkerShape;
  end: MarkerShape;
}

export const DEFAULT_LINE: LineStyle = {
  color: "#8a877f",
  width: 2,
  dash: "solid",
  path: "bezier",
  start: "none",
  end: "triangle",
};

export interface BoardEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  line?: Partial<LineStyle>;
  label?: string;
}

export function lineOf(e: Pick<BoardEdge, "line">): LineStyle {
  return { ...DEFAULT_LINE, ...e.line };
}

/** New lines start with the style last applied on this board. */
export function lineDefaults(): LineStyle {
  return { ...DEFAULT_LINE, ...(yMeta.get("lineDefaults") as Partial<LineStyle> | undefined) };
}

export function patchEdges(ids: string[], patch: { line?: Partial<LineStyle>; label?: string }) {
  let last: LineStyle | undefined;
  transact(() => {
    for (const id of ids) {
      const cur = yEdges.get(id);
      if (!cur) continue;
      const next: BoardEdge = { ...cur };
      if (patch.line) next.line = last = { ...lineOf(cur), ...patch.line };
      if (patch.label !== undefined) next.label = patch.label;
      yEdges.set(id, next);
    }
  });
  // Remembered outside the undo scope: undoing a style change shouldn't
  // also change what the next new line looks like.
  if (last) ydoc.transact(() => yMeta.set("lineDefaults", last));
}

/**
 * Schema 2: each object is a nested Y.Map of fields, and its `data` is a
 * nested Y.Map too. Edits touch single fields, so automatic adjustments (a
 * card fitting itself to its image) never replace the whole object, which
 * keeps undo working and lets collaborators edit different fields at once.
 * Schema 1 stored each object as one plain value; boards migrate on load.
 */
export const SCHEMA_VERSION = 2;

export const ydoc = new Y.Doc();
/** Raw storage: use the object helpers below rather than touching this. */
export const yObjects = ydoc.getMap<Y.Map<unknown>>("objects");
export const yEdges = ydoc.getMap<BoardEdge>("edges");
export const yMeta = ydoc.getMap<unknown>("meta");

/** Local edits are tagged with this origin so only they enter undo history. */
export const LOCAL = Symbol("local");

export const undoManager = new Y.UndoManager([yObjects, yEdges], {
  trackedOrigins: new Set([LOCAL]),
  captureTimeout: 400,
  // An untracked write to a field (e.g. a live color preview) would otherwise
  // block undoing earlier edits of that same field. Fine while single-user.
  // TODO(multiplayer): revisit, since this lets undo overwrite a field a
  // collaborator changed after you.
  ignoreRemoteMapChanges: true,
});

export function transact(fn: () => void) {
  ydoc.transact(fn, LOCAL);
}

/**
 * Run a discrete user action (rename, button click) as its own undo step.
 * Without this, edits within `captureTimeout` of each other merge into one
 * step, which is right for typing or dragging a slider but not for these.
 */
export function asStep(fn: () => void) {
  undoManager.stopCapturing();
  fn();
  undoManager.stopCapturing();
}

// UUIDv7-ish: time-ordered, unique across peers (PRD §9 "stable object IDs").
export function newId(): string {
  const ts = Date.now().toString(16).padStart(12, "0");
  const rand = crypto.getRandomValues(new Uint8Array(10));
  const hex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${ts.slice(0, 8)}-${ts.slice(8)}-7${hex.slice(0, 3)}-${hex.slice(3, 7)}-${hex.slice(7, 19)}`;
}

// ---------------------------------------------------------------------------
// Objects: read/write helpers over the nested Y.Map storage.
// ---------------------------------------------------------------------------

const OBJECT_FIELDS = ["type", "position", "width", "height"] as const;

function toYMap(record: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(record)) if (v !== undefined) m.set(k, v);
  return m;
}

function makeObjectMap(obj: BoardObject): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", obj.id);
  for (const k of OBJECT_FIELDS) m.set(k, obj[k]);
  m.set("data", toYMap(obj.data as unknown as Record<string, unknown>));
  return m;
}

function readObject(m: Y.Map<unknown>): BoardObject {
  const data = m.get("data");
  return {
    id: m.get("id") as string,
    type: m.get("type") as ObjectKind,
    position: m.get("position") as { x: number; y: number },
    width: m.get("width") as number,
    height: m.get("height") as number,
    data: (data instanceof Y.Map ? data.toJSON() : data) as ObjectData,
  };
}

// Decoded objects, re-read only when that object changes (a board-wide re-read
// on every edit gets slow at 1,000+ objects). Registered at load, so it runs
// before any UI observer and they always see fresh values.
const cache = new Map<string, BoardObject>();
yObjects.observeDeep((events) => {
  for (const ev of events) {
    if (ev.target === yObjects) (ev as Y.YMapEvent<unknown>).keysChanged.forEach((k) => cache.delete(k));
    else cache.delete(String(ev.path[0]));
  }
});

export function getObject(id: string): BoardObject | undefined {
  const hit = cache.get(id);
  if (hit) return hit;
  const m = yObjects.get(id);
  if (!m) return undefined;
  const obj = readObject(m);
  cache.set(id, obj);
  return obj;
}

export function allObjects(): BoardObject[] {
  return Array.from(yObjects.keys(), (id) => getObject(id)!);
}

export function objectCount(): number {
  return yObjects.size;
}

/** Call `fn` whenever any object or any of its fields changes. */
export function observeObjects(fn: () => void): () => void {
  yObjects.observeDeep(fn);
  return () => yObjects.unobserveDeep(fn);
}

export function addObject(obj: Omit<BoardObject, "id">): string {
  const id = newId();
  // Each added object is its own undo step (captureTimeout would otherwise
  // merge quick successive adds, e.g. pasting two links).
  undoManager.stopCapturing();
  transact(() => yObjects.set(id, makeObjectMap({ ...obj, id })));
  undoManager.stopCapturing();
  return id;
}

/** Add many objects as one undo step (e.g. the stress test). */
export function addObjects(objs: BoardObject[]) {
  undoManager.stopCapturing();
  transact(() => objs.forEach((o) => yObjects.set(o.id, makeObjectMap(o))));
  undoManager.stopCapturing();
}

export interface ChangeSet {
  add?: BoardObject[];
  edges?: BoardEdge[];
  moves?: { id: string; position: { x: number; y: number } }[];
  patches?: { id: string; data: Partial<ObjectData> }[];
  deletes?: string[];
}

/**
 * Apply AI suggestions as one undo step: new cards and lines, moves, field
 * edits and deletions (with their lines). Missing targets are skipped.
 */
export function applyChanges(c: ChangeSet) {
  undoManager.stopCapturing();
  transact(() => {
    c.add?.forEach((o) => yObjects.set(o.id, makeObjectMap(o)));
    c.edges?.forEach((e) => {
      if (yObjects.has(e.source) && yObjects.has(e.target)) yEdges.set(e.id, e);
    });
    c.moves?.forEach(({ id, position }) => yObjects.get(id)?.set("position", position));
    c.patches?.forEach(({ id, data }) => {
      const m = yObjects.get(id);
      if (m) writeData(m, data);
    });
    for (const id of c.deletes ?? []) {
      if (!yObjects.has(id)) continue;
      yObjects.delete(id);
      for (const [eid, e] of yEdges) if (e.source === id || e.target === id) yEdges.delete(eid);
    }
  });
  undoManager.stopCapturing();
}

/** Add cards and the lines between them as one undo step (accepting AI suggestions). */
export function addObjectsAndEdges(objs: BoardObject[], edges: BoardEdge[]) {
  undoManager.stopCapturing();
  transact(() => {
    objs.forEach((o) => yObjects.set(o.id, makeObjectMap(o)));
    edges.forEach((e) => yEdges.set(e.id, e));
  });
  undoManager.stopCapturing();
}

export function deleteObjects(ids: string[]) {
  if (!ids.length) return;
  transact(() => {
    for (const id of ids) {
      yObjects.delete(id);
      for (const [eid, e] of yEdges) {
        if (e.source === id || e.target === id) yEdges.delete(eid);
      }
    }
  });
}

export function clearBoard() {
  transact(() => {
    yObjects.clear();
    yEdges.clear();
  });
}

function run(fn: () => void, track: boolean) {
  if (track) transact(fn);
  else ydoc.transact(fn, "system");
}

/**
 * Change top-level fields (position, size…). `track: false` applies an
 * automatic adjustment, like fitting a card to its media, without an undo step.
 * Passing `data` merges those fields into the object's data.
 */
export function patchObject(
  id: string,
  patch: Partial<Omit<BoardObject, "id">>,
  { track = true }: { track?: boolean } = {},
) {
  const m = yObjects.get(id);
  if (!m) return;
  run(() => {
    for (const k of OBJECT_FIELDS) if (patch[k] !== undefined) m.set(k, patch[k]);
    if (patch.data) writeData(m, patch.data);
  }, track);
}

/** Move several objects as one step (end of a multi-select drag). */
export function moveObjects(moves: { id: string; position: { x: number; y: number } }[]) {
  transact(() => {
    for (const { id, position } of moves) yObjects.get(id)?.set("position", position);
  });
}

function writeData(m: Y.Map<unknown>, patch: Partial<ObjectData>) {
  const data = m.get("data");
  if (!(data instanceof Y.Map)) return;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) data.delete(k);
    else if (data.get(k) !== v) data.set(k, v);
  }
}

export function patchData(
  id: string,
  patch: Partial<ObjectData>,
  { track = true }: { track?: boolean } = {},
) {
  const m = yObjects.get(id);
  if (!m) return;
  run(() => writeData(m, patch), track);
}

/** Schema 1 → 2: turn plain-value objects into nested maps (not an undo step). */
function migrate() {
  const legacy = Array.from(yObjects.entries()).filter(([, v]) => !(v instanceof Y.Map));
  if (legacy.length) {
    ydoc.transact(() => {
      for (const [id, v] of legacy) {
        yObjects.set(id, makeObjectMap({ ...(v as unknown as BoardObject), id }));
      }
    }, "system");
  }
  ydoc.transact(() => yMeta.set("schema", SCHEMA_VERSION), "system");
}

/** Load a board saved as Yjs updates (from a `.conceit` file). */
export function loadUpdates(updates: Uint8Array[]) {
  ydoc.transact(() => {
    for (const u of updates) Y.applyUpdate(ydoc, u, "storage");
  }, "storage");
  migrate();
}

/** Change a card's data without an undo step (background work, e.g. caching media). */
export function patchDataQuietly(id: string, patch: Partial<ObjectData>) {
  const m = yObjects.get(id);
  if (m) ydoc.transact(() => writeData(m, patch), "system");
}

/** The board kept in localStorage before board files existed, if any. */
export function legacyBoard(): Uint8Array | null {
  try {
    if (localStorage.getItem(`${STORAGE_KEY}.moved`)) return null;
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? fromBase64(saved) : null;
  } catch {
    return null;
  }
}

/** Mark the legacy board as moved into a file (kept as a backup, never loaded again). */
export function markLegacyMoved(path: string) {
  try {
    localStorage.setItem(`${STORAGE_KEY}.moved`, path);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Persistence in the browser (no Tauri: dev in a plain browser, tests).
// In the app, boards live in .conceit files: see src/files/persist.ts.
// Phase 1 moves this into the Rust project store (SQLite inside .conceit).
// For now the Yjs state is kept in localStorage so the spike survives reloads.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "conceit.spike.board.v1";

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function loadFromStorage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) Y.applyUpdate(ydoc, fromBase64(saved), "storage");
  } catch (err) {
    console.warn("Could not restore board:", err);
  }
  migrate();
}

let saveTimer: number | undefined;
let dirty = false;

function saveNow() {
  window.clearTimeout(saveTimer);
  if (!dirty) return;
  try {
    localStorage.setItem(STORAGE_KEY, toBase64(Y.encodeStateAsUpdate(ydoc)));
    dirty = false;
  } catch (err) {
    console.warn("Autosave failed (board too large for localStorage?):", err);
  }
}

export function startAutosave() {
  ydoc.on("update", (_update: Uint8Array, origin: unknown) => {
    if (origin === "storage") return;
    dirty = true;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, 500);
  });
  // Don't lose the last half-second of edits on reload or window close.
  window.addEventListener("pagehide", saveNow);
  window.addEventListener("beforeunload", saveNow);
}

// Dev only: this module holds the board as a single shared instance. Hot-
// swapping it would leave parts of the UI bound to the old copy (edits then
// silently go nowhere), so reload the whole page when it changes instead.
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload());
}
