import { useSyncExternalStore } from "react";
import type { Edge, Node, Rect } from "@xyflow/react";
import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Export the board (or the selection) as PNG or PDF, with no app UI: only
 * cards, lines, labels and drawings. Renders the canvas DOM to an image
 * (html-to-image), at up to 2× resolution.
 */

export type ExportFormat = "png" | "pdf";

// While exporting, the canvas renders every object (not just visible ones) and
// video cards show stills instead of live players.
let exporting = false;
const listeners = new Set<() => void>();
function setExporting(v: boolean) {
  exporting = v;
  listeners.forEach((l) => l());
}
export function useExporting(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => exporting,
  );
}

/** App UI that must never appear in an export. */
const UI_CLASSES = [
  "react-flow__handle",
  "react-flow__resize-control",
  "react-flow__node-toolbar",
  "react-flow__nodesselection",
  "react-flow__selection",
  "react-flow__connectionline",
  "cn-tint-btn",
  "cn-edge-halo",
  "cn-drawing-hit",
];

const PAD = 40;
const MAX_SIDE = 8192; // keep within WebKit canvas limits
const MAX_AREA = 40_000_000;

/** Stand-in for an image that can't be read, so one bad image doesn't abort the export. */
const EMPTY_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
/** Local videos above this size export a blank frame instead of being read whole. */
const MAX_VIDEO_READ = 400 * 1024 * 1024;

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const timeout = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function imagesReady(root: Element) {
  const imgs = Array.from(root.querySelectorAll("img"));
  await Promise.race([
    Promise.all(imgs.map((img) => (img.complete ? null : img.decode().catch(() => null)))),
    timeout(5000),
  ]);
}

const blobToDataUrl = (b: Blob) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(b);
  });

interface Blob64 {
  mime: string;
  data: string;
}

/** A local (asset store) file as a data URL, read by the Rust side. */
export async function assetDataUrl(asset: string, maxBytes?: number): Promise<string> {
  const f = await invoke<Blob64>("read_asset", { asset, maxBytes });
  return `data:${f.mime};base64,${f.data}`;
}

/** A local file as a typed Blob (for videos, which play from blob: URLs). */
async function assetBlob(asset: string, maxBytes?: number): Promise<Blob> {
  const f = await invoke<Blob64>("read_asset", { asset, maxBytes });
  const bin = atob(f.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: f.mime });
}

/** A web image as a data URL: directly if the site allows it, else downloaded by Rust. */
export async function webImageDataUrl(src: string): Promise<string> {
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await blobToDataUrl(await res.blob());
  } catch (err) {
    if (!isTauri() || !/^https?:/i.test(src)) throw err;
    const f = await invoke<Blob64>("fetch_image", { url: src });
    return `data:${f.mime};base64,${f.data}`;
  }
}

/**
 * Re-encode an image at the size it's shown (2× for sharpness). A 5 MB photo
 * becomes a few hundred KB, which WebKit decodes in time for the snapshot.
 */
function shrunk(img: HTMLImageElement, data: string): string {
  const nw = img.naturalWidth, nh = img.naturalHeight;
  const bw = img.clientWidth, bh = img.clientHeight;
  if (!nw || !nh || !bw || !bh) return data;
  const shown = Math.min(bw / nw, bh / nh);
  const s = Math.min(1, 2 * (getComputedStyle(img).objectFit === "cover" ? Math.max(bw / nw, bh / nh) : shown));
  if (s > 0.85) return data;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(nw * s));
  c.height = Math.max(1, Math.round(nh * s));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return /^data:image\/jpe?g/i.test(data) ? c.toDataURL("image/jpeg", 0.92) : c.toDataURL("image/png");
}

/** Load `data` into `img` and confirm it really decodes. */
function show(img: HTMLImageElement, data: string): Promise<boolean> {
  return new Promise((ok) => {
    const done = (v: boolean) => {
      img.onload = img.onerror = null;
      ok(v);
    };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = data;
    setTimeout(() => done(img.complete && img.naturalWidth > 0), 8000);
  });
}

/**
 * Turn every image into an inline data URL before the snapshot: local files
 * via Rust (the webview can't fetch asset:// URLs), web images via fetch or a
 * Rust download. Returns how many couldn't be shown, and a function that
 * restores the originals.
 */
async function inlineImages(root: Element): Promise<{ failed: number; restore: () => void }> {
  const changed: [HTMLImageElement, string][] = [];
  let failed = 0;
  await Promise.all(
    Array.from(root.querySelectorAll("img")).map(async (img) => {
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith("data:")) return;
      changed.push([img, img.getAttribute("src") ?? ""]);
      try {
        const asset = img.dataset.asset;
        const data = asset && isTauri() ? await assetDataUrl(asset) : await webImageDataUrl(src);
        if (await show(img, data)) {
          const small = shrunk(img, data);
          if (small === data || (await show(img, small))) return;
        }
        console.warn("Export: image didn't decode:", asset ?? src);
      } catch (err) {
        console.warn("Export: couldn't read image:", src, err);
      }
      failed++;
      img.src = EMPTY_IMAGE;
    }),
  );
  return { failed, restore: () => changed.forEach(([img, src]) => (img.src = src)) };
}

/** Still frame of a video as a data URL, or null if it can't be read. */
async function frameOf(v: HTMLVideoElement): Promise<string | null> {
  const draw = (src: HTMLVideoElement) => {
    if (!src.videoWidth) throw new Error("no frame");
    const c = document.createElement("canvas");
    c.width = src.videoWidth;
    c.height = src.videoHeight;
    c.getContext("2d")!.drawImage(src, 0, 0);
    return c.toDataURL("image/jpeg", 0.9); // throws if the frame isn't readable
  };
  const local = Boolean(v.dataset.asset && isTauri());
  // Web videos that allow it can be drawn as shown. Local files always go
  // through a same-origin copy: drawing the asset:// player can come out blank.
  if (!local && v.readyState >= 2) {
    try {
      return draw(v);
    } catch {
      /* not readable as-is; try a CORS copy below */
    }
  }
  const src = v.currentSrc || v.src;
  if (!src) return null;
  let blobUrl: string | undefined;
  try {
    const copy = document.createElement("video");
    copy.muted = true;
    copy.playsInline = true;
    copy.preload = "auto";
    if (local) {
      blobUrl = URL.createObjectURL(await assetBlob(v.dataset.asset!, MAX_VIDEO_READ));
      copy.src = blobUrl;
    } else {
      copy.crossOrigin = "anonymous";
      copy.src = src.split("#")[0];
    }
    const wait = (ev: string) =>
      Promise.race([
        new Promise((ok, fail) => {
          copy.addEventListener(ev, ok, { once: true });
          copy.addEventListener("error", () => fail(copy.error), { once: true });
        }),
        timeout(8000).then(() => Promise.reject(new Error(`video ${ev} timed out`))),
      ]);
    await wait("loadeddata");
    // Same moment as the card shows (the first frame, unless it was played).
    copy.currentTime = Math.max(0.1, Math.min(v.currentTime || 0.1, (copy.duration || 1) - 0.05));
    await wait("seeked");
    return draw(copy);
  } catch (err) {
    console.warn("Export: no frame for video:", v.dataset.asset ?? src, err);
    return null;
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
}

/** Put a still image over each video (videos themselves are left out of the export). */
async function addVideoStills(root: Element): Promise<{ failed: number; remove: () => void }> {
  const added: HTMLElement[] = [];
  let failed = 0;
  for (const v of Array.from(root.querySelectorAll("video"))) {
    const still = document.createElement("img");
    still.className = "cn-export-still";
    const frame = await frameOf(v);
    if (frame) still.src = frame;
    else {
      failed++;
      still.src = EMPTY_IMAGE;
      still.classList.add("cn-export-blank");
    }
    v.after(still);
    added.push(still);
  }
  await imagesReady(root);
  return { failed, remove: () => added.forEach((el) => el.remove()) };
}

const MAX_DRAWS = 8;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error("The snapshot couldn't be rendered"));
    img.src = src;
  });
}

/** The front-most card at a screen point (images themselves ignore the pointer). */
function topCardAt(x: number, y: number): Element | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const card = el.closest(".react-flow__node");
    if (card) return card;
    if (el.classList.contains("react-flow__pane")) return null;
  }
  return null;
}

interface ImageCheck {
  label: string;
  /** True when this image's pixels appear in the drawn export. */
  visibleIn: (ctx: CanvasRenderingContext2D) => boolean;
}

/**
 * For each image in the export, a few sample points (where it's on top on
 * screen, so overlapped cards don't count) and the colors expected there.
 */
function imageChecks(
  viewport: HTMLElement,
  onlyIds: Set<string> | undefined,
  origin: { x: number; y: number },
  ratio: number,
): ImageCheck[] {
  const vp = viewport.getBoundingClientRect();
  const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a || 1;
  const checks: ImageCheck[] = [];
  for (const img of Array.from(viewport.querySelectorAll("img"))) {
    if (!img.src.startsWith("data:") || img.src === EMPTY_IMAGE || !img.naturalWidth) continue;
    const node = img.closest(".react-flow__node");
    if (onlyIds && !onlyIds.has(node?.getAttribute("data-id") ?? "")) continue;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const cover = getComputedStyle(img).objectFit === "cover";
    const s = cover ? Math.max(r.width / nw, r.height / nh) : Math.min(r.width / nw, r.height / nh);
    const cw = nw * s, ch = nh * s;
    const cx = r.left + (r.width - cw) / 2, cy = r.top + (r.height - ch) / 2;
    // Source pixels, scaled down for cheap sampling.
    const k = Math.min(1, 256 / Math.max(nw, nh));
    const src = document.createElement("canvas");
    src.width = Math.max(1, Math.round(nw * k));
    src.height = Math.max(1, Math.round(nh * k));
    const sctx = src.getContext("2d", { willReadFrequently: true })!;
    sctx.drawImage(img, 0, 0, src.width, src.height);
    const vw = Math.min(r.width, cw), vh = Math.min(r.height, ch);
    const points: { x: number; y: number; rgb: number[] }[] = [];
    for (const [fx, fy] of [[0, 0], [-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25], [0, 0.3], [0, -0.3]]) {
      const px = r.left + r.width / 2 + fx * vw, py = r.top + r.height / 2 + fy * vh;
      const onScreen = px >= 0 && py >= 0 && px < innerWidth && py < innerHeight;
      // Skip points where another card sits on top of this one.
      if (onScreen && node && topCardAt(px, py) !== node) continue;
      const sx = Math.min(src.width - 1, Math.max(0, Math.floor(((px - cx) / cw) * src.width)));
      const sy = Math.min(src.height - 1, Math.max(0, Math.floor(((py - cy) / ch) * src.height)));
      const d = sctx.getImageData(sx, sy, 1, 1).data;
      if (d[3] < 200) continue; // transparent there: the card shows through
      points.push({
        x: Math.round(((px - vp.left) / zoom - origin.x) * ratio),
        y: Math.round(((py - vp.top) / zoom - origin.y) * ratio),
        rgb: [d[0], d[1], d[2]],
      });
    }
    if (!points.length) continue;
    const label = img.alt || node?.querySelector(".cn-title")?.textContent || "image";
    checks.push({
      label,
      visibleIn: (ctx) => {
        let hits = 0;
        for (const p of points) {
          const d = ctx.getImageData(p.x, p.y, 1, 1).data;
          if (Math.max(Math.abs(d[0] - p.rgb[0]), Math.abs(d[1] - p.rgb[1]), Math.abs(d[2] - p.rgb[2])) <= 48) hits++;
        }
        return hits * 2 >= points.length;
      },
    });
  }
  return checks;
}

export interface ExportOptions {
  format: ExportFormat;
  nodes: Node[];
  edges: Edge[];
  /** Only these nodes (and lines between them); otherwise the whole board. */
  onlyIds?: Set<string>;
  transparent?: boolean;
  bounds: (nodes: Node[]) => Rect;
  fileName: string;
}

export interface ExportResult {
  /** Saved path (or file name in the browser); null if the save was cancelled. */
  saved: string | null;
  /** Images or videos that couldn't be read and are blank in the export. */
  missing: number;
}

export async function exportBoard(o: ExportOptions): Promise<ExportResult> {
  const nodes = o.onlyIds ? o.nodes.filter((n) => o.onlyIds!.has(n.id)) : o.nodes;
  if (!nodes.length) throw new Error("Nothing to export");
  const edgeIds = o.onlyIds
    ? new Set(
        o.edges
          .filter((e) => e.selected || (o.onlyIds!.has(e.source) && o.onlyIds!.has(e.target)))
          .map((e) => e.id),
      )
    : null;

  const { toSvg } = await import("html-to-image");
  setExporting(true);
  let removeStills = () => {};
  let restoreImages = () => {};
  try {
    await nextFrame();
    await nextFrame();
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (!viewport) throw new Error("Canvas not found");
    const images = await inlineImages(viewport);
    restoreImages = images.restore;
    const stills = await addVideoStills(viewport);
    removeStills = stills.remove;
    let missing = images.failed + stills.failed;

    const b = o.bounds(nodes);
    const width = Math.ceil(b.width + PAD * 2);
    const height = Math.ceil(b.height + PAD * 2);
    const pixelRatio = Math.min(2, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_AREA / (width * height)));
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--cn-bg").trim() || "#ffffff";
    const transparent = o.transparent && o.format === "png";

    // No background on the snapshot itself: it moves with the content shift
    // and wouldn't cover the whole image. The canvas is filled below instead.
    const svgUrl = await toSvg(viewport, {
      width,
      height,
      skipFonts: true,
      imagePlaceholder: EMPTY_IMAGE,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${PAD - b.x}px, ${PAD - b.y}px) scale(1)`,
      },
      filter: (el) => {
        if (!(el instanceof Element)) return true;
        if (el.tagName === "VIDEO" || el.tagName === "IFRAME") return false;
        const cl = el.classList;
        if (UI_CLASSES.some((c) => cl.contains(c))) return false;
        if (o.onlyIds) {
          if (cl.contains("react-flow__node")) return o.onlyIds.has(el.getAttribute("data-id") ?? "");
          if (cl.contains("react-flow__edge")) return edgeIds!.has(el.getAttribute("data-id") ?? "");
          if (cl.contains("cn-edge-label")) return edgeIds!.has(el.getAttribute("data-edge-id") ?? "");
        }
        return true;
      },
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const checks = imageChecks(viewport, o.onlyIds, { x: b.x - PAD, y: b.y - PAD }, pixelRatio);

    // WebKit can draw the snapshot before the images inside it are decoded.
    // Draw, check each image really shows, and redraw until they all do.
    let snapshot = await loadImage(svgUrl);
    let unseen = checks;
    for (let attempt = 1; ; attempt++) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!transparent) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(snapshot, 0, 0, canvas.width, canvas.height);
      unseen = unseen.filter((c) => !c.visibleIn(ctx));
      if (!unseen.length) {
        console.info(`Export: ${checks.length} image(s) verified after ${attempt} draw(s)`);
        break;
      }
      if (attempt >= MAX_DRAWS) {
        console.warn(`Export: ${unseen.length} image(s) still blank after ${attempt} draws:`, unseen.map((c) => c.label));
        break;
      }
      await timeout(120 * attempt);
      if (attempt % 3 === 0) snapshot = await loadImage(svgUrl); // fresh decode
      unseen = checks; // re-check all on the new draw
    }
    missing += unseen.length;

    let bytes: Uint8Array;
    if (o.format === "png") {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error("Could not encode the image");
      bytes = new Uint8Array(await blob.arrayBuffer());
    } else {
      const { jsPDF } = await import("jspdf");
      // One page the size of the board; 1 board pixel = 1 pt.
      const pdf = new jsPDF({ unit: "pt", format: [width, height], orientation: width > height ? "l" : "p", compress: true });
      pdf.addImage(canvas, "PNG", 0, 0, width, height, undefined, "FAST");
      bytes = new Uint8Array(pdf.output("arraybuffer"));
    }
    return { saved: await save(bytes, o.format, o.fileName), missing };
  } finally {
    removeStills();
    restoreImages();
    setExporting(false);
  }
}

async function save(bytes: Uint8Array, format: ExportFormat, fileName: string): Promise<string | null> {
  const name = `${fileName}.${format}`;
  if (isTauri()) {
    const { save: saveDialog } = await import("@tauri-apps/plugin-dialog");
    const path = await saveDialog({
      defaultPath: name,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return null;
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(path, bytes);
    return path;
  }
  // Browser (dev/testing): regular download.
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: format === "png" ? "image/png" : "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
