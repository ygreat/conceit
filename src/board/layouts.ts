/**
 * Automatic board layouts. Pure functions: cards in, target rectangles out
 * (relative to 0,0; the caller anchors them where the cards were).
 */

export type LayoutKind = "grid" | "masonry" | "bento" | "flow" | "scatter";

export interface LayoutItem {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Image/video content proportions (width ÷ height, without the header). */
  aspect?: number;
  /** Note text length, to give long notes bigger tiles. */
  textLength?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

const HEADER = 26;
const isMedia = (i: LayoutItem) => i.aspect !== undefined;

/** Reading order: top to bottom in loose rows, then left to right. */
export function readingOrder(items: LayoutItem[]): LayoutItem[] {
  return [...items].sort((a, b) => Math.round(a.y / 120) - Math.round(b.y / 120) || a.x - b.x);
}

// ---------------------------------------------------------------- Grid (rows)

function grid(items: LayoutItem[]): Map<string, Rect> {
  const GAP = 32;
  const out = new Map<string, Rect>();
  const area = items.reduce((s, i) => s + (i.w + GAP) * (i.h + GAP), 0);
  const maxW = Math.max(...items.map((i) => i.w));
  const rowWidth = Math.max(maxW, Math.sqrt(area) * 1.5);
  let x = 0, y = 0, rowH = 0;
  for (const it of readingOrder(items)) {
    if (x > 0 && x + it.w > rowWidth) {
      x = 0;
      y += rowH + GAP;
      rowH = 0;
    }
    out.set(it.id, { x, y, w: it.w, h: it.h });
    x += it.w + GAP;
    rowH = Math.max(rowH, it.h);
  }
  return out;
}

// ---------------------------------------------------------------- Masonry

function masonry(items: LayoutItem[]): Map<string, Rect> {
  const COL = 280, GAP = 24;
  const cols = Math.max(1, Math.min(8, Math.round(Math.sqrt(items.length * 1.4))));
  const heights = new Array(cols).fill(0);
  const out = new Map<string, Rect>();
  for (const it of readingOrder(items)) {
    const h = isMedia(it) ? Math.round(COL / it.aspect!) + HEADER : it.h;
    const c = heights.indexOf(Math.min(...heights));
    out.set(it.id, { x: c * (COL + GAP), y: heights[c], w: COL, h });
    heights[c] += h + GAP;
  }
  return out;
}

// ---------------------------------------------------------------- Bento

const UNIT = 150, BGAP = 16;
const span = (n: number) => n * UNIT + (n - 1) * BGAP;

/** Tile shapes a media card may take, in grid cells [columns, rows]. */
const MEDIA_SPANS: [number, number][] = [
  [1, 1], [2, 1], [3, 1], [1, 2], [2, 2], [3, 2], [2, 3], [3, 3], [4, 2], [4, 3], [2, 4],
];

function bentoSpan(it: LayoutItem, hero: boolean): [number, number] {
  if (it.type === "color") return [2, 2]; // swatch + three value rows
  if (it.type === "note") return (it.textLength ?? 0) > 90 ? [2, 2] : [2, 1];
  if (!isMedia(it)) {
    // Anything else: closest tile to its current shape.
    return [Math.max(1, Math.min(3, Math.round(it.w / UNIT))), Math.max(1, Math.min(3, Math.round(it.h / UNIT)))];
  }
  // Media: the tile whose content area best matches the picture, so little
  // is letterboxed. The hero (largest picture) gets a big tile.
  const target = Math.log(it.aspect!);
  let best: [number, number] = [2, 2], score = Infinity;
  for (const [c, r] of MEDIA_SPANS) {
    const cells = c * r;
    if (hero ? cells < 8 : cells > 6) continue;
    const s = Math.abs(Math.log(span(c) / (span(r) - HEADER)) - target) + (cells === 1 ? 0.25 : 0);
    if (s < score) {
      score = s;
      best = [c, r];
    }
  }
  return best;
}

function bento(items: LayoutItem[]): Map<string, Rect> {
  const ordered = readingOrder(items);
  const media = ordered.filter(isMedia);
  const hero = media.length >= 3 ? media.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b)) : undefined;
  const tiles = ordered.map((it) => ({ it, s: bentoSpan(it, it === hero) }));
  const cells = tiles.reduce((n, t) => n + t.s[0] * t.s[1], 0);
  const cols = Math.max(Math.max(...tiles.map((t) => t.s[0])), Math.round(Math.sqrt(cells * 1.6)));

  // Dense packing: big tiles first, each into the first free spot (row-major).
  const used: boolean[][] = [];
  const free = (r: number, c: number, w: number, h: number) => {
    if (c + w > cols) return false;
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (used[y]?.[x]) return false;
    return true;
  };
  const out = new Map<string, Rect>();
  const order = [...tiles].sort((a, b) => b.s[0] * b.s[1] - a.s[0] * a.s[1]);
  for (const { it, s: [w, h] } of order) {
    for (let r = 0; ; r++) {
      const c = Array.from({ length: cols }, (_, i) => i).find((i) => free(r, i, w, h));
      if (c === undefined) continue;
      for (let y = r; y < r + h; y++) {
        used[y] ??= [];
        for (let x = c; x < c + w; x++) used[y][x] = true;
      }
      out.set(it.id, { x: c * (UNIT + BGAP), y: r * (UNIT + BGAP), w: span(w), h: span(h) });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- Flow (follow lines)

function flow(items: LayoutItem[], edges: LayoutEdge[]): Map<string, Rect> {
  const GAP_X = 120, GAP_Y = 40;
  const ids = new Set(items.map((i) => i.id));
  const byId = new Map(items.map((i) => [i.id, i]));
  const links = edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const out = new Map<string, Rect>();
  const connected = new Set(links.flatMap((e) => [e.source, e.target]));
  const kids = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const e of links) {
    kids.set(e.source, [...(kids.get(e.source) ?? []), e.target]);
    parents.set(e.target, [...(parents.get(e.target) ?? []), e.source]);
  }

  // Layers: longest path from a root (cycles broken by visiting order).
  const order = readingOrder(items.filter((i) => connected.has(i.id))).map((i) => i.id);
  const layer = new Map<string, number>();
  const roots = order.filter((id) => !parents.get(id)?.length);
  const queue = roots.length ? [...roots] : order.slice(0, 1);
  queue.forEach((id) => layer.set(id, 0));
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const k of kids.get(id) ?? []) {
      if (seen.has(k)) continue; // back edge in a cycle
      layer.set(k, Math.max(layer.get(k) ?? 0, layer.get(id)! + 1));
      queue.push(k);
    }
    if (!queue.length) {
      const next = order.find((o) => !seen.has(o)); // another component
      if (next) {
        layer.set(next, layer.get(next) ?? 0);
        queue.push(next);
      }
    }
  }

  const columns: string[][] = [];
  for (const id of order) (columns[layer.get(id) ?? 0] ??= []).push(id);
  // Order each column by its parents' positions, so lines cross less.
  const rank = new Map<string, number>();
  columns.forEach((col, ci) => {
    if (ci > 0) {
      const key = (id: string) => {
        const ps = (parents.get(id) ?? []).map((p) => rank.get(p)).filter((v): v is number => v !== undefined);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity;
      };
      col.sort((a, b) => key(a) - key(b));
    }
    col.forEach((id, i) => rank.set(id, i));
  });

  const colH = columns.map((col) => col.reduce((s, id) => s + byId.get(id)!.h, 0) + GAP_Y * (col.length - 1));
  const tallest = Math.max(0, ...colH);
  let x = 0;
  columns.forEach((col, ci) => {
    let y = (tallest - colH[ci]) / 2;
    const colW = Math.max(...col.map((id) => byId.get(id)!.w));
    for (const id of col) {
      const it = byId.get(id)!;
      out.set(id, { x: x + (colW - it.w) / 2, y, w: it.w, h: it.h });
      y += it.h + GAP_Y;
    }
    x += colW + GAP_X;
  });

  // Unconnected cards: a tidy row block underneath.
  const loose = items.filter((i) => !connected.has(i.id));
  if (loose.length) {
    const top = out.size ? tallest + GAP_X : 0;
    for (const [id, r] of grid(loose)) out.set(id, { ...r, y: r.y + top });
  }
  return out;
}

// ---------------------------------------------------------------- Scatter

function scatter(items: LayoutItem[]): Map<string, Rect> {
  const area = items.reduce((s, i) => s + i.w * i.h, 0) * 2.4;
  const W = Math.max(...items.map((i) => i.w)) + Math.sqrt(area * 1.6);
  const H = Math.max(...items.map((i) => i.h)) + Math.sqrt(area / 1.6);
  const placed: Rect[] = [];
  const out = new Map<string, Rect>();
  const overlap = (a: Rect, b: Rect) => {
    const m = 20;
    const ox = Math.min(a.x + a.w + m, b.x + b.w + m) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h + m, b.y + b.h + m) - Math.max(a.y, b.y);
    return ox > 0 && oy > 0 ? ox * oy : 0;
  };
  for (const it of [...items].sort(() => Math.random() - 0.5)) {
    let best: Rect | undefined, bestScore = Infinity;
    for (let tries = 0; tries < 60 && bestScore > 0; tries++) {
      const r = { x: Math.random() * (W - it.w), y: Math.random() * (H - it.h), w: it.w, h: it.h };
      const s = placed.reduce((sum, p) => sum + overlap(r, p), 0);
      if (s < bestScore) {
        bestScore = s;
        best = r;
      }
    }
    const r = { ...best!, x: Math.round(best!.x), y: Math.round(best!.y) };
    placed.push(r);
    out.set(it.id, r);
  }
  return out;
}

// ---------------------------------------------------------------- Entry

/** Target rectangles, anchored at the top-left of the cards' current area. */
export function layout(kind: LayoutKind, input: LayoutItem[], edges: LayoutEdge[] = []): Map<string, Rect> {
  if (!input.length) return new Map();
  // Layouts that keep card sizes give media cards back their picture's real
  // proportions (undoing letterboxing from an earlier Bento), at the same width.
  const items =
    kind === "bento" || kind === "masonry"
      ? input
      : input.map((i) => (isMedia(i) ? { ...i, h: Math.round(i.w / i.aspect!) + HEADER } : i));
  const rel =
    kind === "grid" ? grid(items)
    : kind === "masonry" ? masonry(items)
    : kind === "bento" ? bento(items)
    : kind === "flow" ? flow(items, edges)
    : scatter(items);
  const ox = Math.min(...input.map((i) => i.x)), oy = Math.min(...input.map((i) => i.y));
  const out = new Map<string, Rect>();
  for (const [id, r] of rel) out.set(id, { x: Math.round(ox + r.x), y: Math.round(oy + r.y), w: Math.round(r.w), h: Math.round(r.h) });
  return out;
}
