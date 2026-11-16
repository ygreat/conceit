import { isTauri } from "@tauri-apps/api/core";
import { allObjects, getObject, yEdges, type BoardObject, type ColorData, type DrawingData, type ImageData, type NoteData, type VideoData } from "../board/doc";
import { assetDataUrl, webImageDataUrl } from "../board/exporter";
import { videoEmbed } from "../board/media";

/**
 * Turns the scope (selection, or the whole board) into what the model reads
 * (PRD §6 "AI context"): a numbered text listing in reading order, plus
 * downscaled pictures of the image cards and video thumbnails.
 */

/** Pictures sent per request. Big boards list the rest by name only. */
const MAX_IMAGES = 16;
/** Longest side of a sent picture; plenty for style, small enough to be quick. */
const MAX_SIDE = 1024;
/** Local files above this aren't read for AI (a raw 50 MB photo isn't worth it). */
const MAX_READ = 30 * 1024 * 1024;

export interface AiImage {
  label: string;
  mime: string;
  data: string;
}

export interface BoardContext {
  /** The <board> block placed before the user's request. */
  text: string;
  images: AiImage[];
  /** Ids in scope, in reading order (#1 = ids[0]). */
  ids: string[];
  /** For the UI: "12 cards · 4 images". */
  summary: string;
  /** Canvas bounds of the scope, to place answers beside it. */
  bounds: { x: number; y: number; w: number; h: number } | null;
}

function readingOrder(objs: BoardObject[]): BoardObject[] {
  // Rows: cards whose tops are within ~half a typical card of each other.
  const ROW = 120;
  return [...objs].sort((a, b) => {
    const dy = a.position.y - b.position.y;
    if (Math.abs(dy) > ROW) return dy;
    return a.position.x - b.position.x || dy;
  });
}

function hexToRgbHsl(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === rf ? (gf - bf) / d + (gf < bf ? 6 : 0) : max === gf ? (bf - rf) / d + 2 : (rf - gf) / d + 4;
    h *= 60;
  }
  return `rgb(${r}, ${g}, ${b}), hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

function host(url?: string): string | undefined {
  if (!url || url.startsWith("data:")) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

const quote = (s?: string) => (s ? `"${s.replace(/\s+/g, " ").trim()}"` : "");

/** Where a picture of this card can be loaded from, if anywhere. */
function pictureSource(o: BoardObject): { asset?: string; url?: string } | null {
  if (o.type === "image") {
    const d = o.data as ImageData;
    if (d.asset) return { asset: d.asset };
    if (d.url) return { url: d.url };
  }
  if (o.type === "video") {
    const d = o.data as VideoData;
    const e = d.url ? videoEmbed(d.url) : null;
    if (e?.kind === "youtube") return { url: e.thumb };
  }
  return null;
}

/** Load and shrink one picture to a JPEG. */
async function loadPicture(src: { asset?: string; url?: string }): Promise<{ mime: string; data: string }> {
  let dataUrl: string;
  if (src.asset) dataUrl = await assetDataUrl(src.asset, MAX_READ);
  else if (src.url!.startsWith("data:")) dataUrl = src.url!;
  else dataUrl = await webImageDataUrl(src.url!);

  const img = new Image();
  img.decoding = "async";
  img.src = dataUrl;
  await img.decode();
  const w = img.naturalWidth || MAX_SIDE, h = img.naturalHeight || MAX_SIDE;
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext("2d")!;
  // Transparent PNGs and SVGs: put them on white so they don't turn black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const out = c.toDataURL("image/jpeg", 0.85);
  return { mime: "image/jpeg", data: out.slice(out.indexOf(",") + 1) };
}

/**
 * Build the context for `scopeIds` (the selection), or the whole board when
 * it is empty.
 */
export async function buildContext(scopeIds: string[]): Promise<BoardContext> {
  const selection = scopeIds.length > 0;
  const objs = readingOrder(
    selection ? scopeIds.map((id) => getObject(id)).filter((o): o is BoardObject => !!o) : allObjects(),
  );
  const num = new Map(objs.map((o, i) => [o.id, i + 1]));

  // Pictures first, so each card line can say whether its picture is attached.
  const wanted = objs.filter((o) => pictureSource(o)).slice(0, MAX_IMAGES);
  const loaded = await Promise.all(
    wanted.map((o) => (isTauri() || !pictureSource(o)!.asset ? loadPicture(pictureSource(o)!).catch(() => null) : null)),
  );
  const images: AiImage[] = [];
  const attached = new Map<string, number>();
  wanted.forEach((o, i) => {
    const pic = loaded[i];
    if (!pic) return;
    images.push({ label: `Image ${images.length + 1} (card #${num.get(o.id)})`, ...pic });
    attached.set(o.id, images.length);
  });

  const lines: string[] = [];
  let drawings = 0;
  for (const o of objs) {
    const n = num.get(o.id)!;
    const box = `at (${Math.round(o.position.x)}, ${Math.round(o.position.y)}), ${Math.round(o.width)}×${Math.round(o.height)}`;
    const tint = (o.data as { tint?: string }).tint;
    const tag = tint && o.type !== "note" ? `, block color ${tint}` : "";
    const title = quote((o.data as { title?: string }).title);
    const name = title ? ` ${title}` : "";
    const pic = attached.has(o.id) ? ` [picture attached as Image ${attached.get(o.id)}]` : "";
    switch (o.type) {
      case "note": {
        const d = o.data as NoteData;
        const text = d.text?.trim() ? d.text.trim().replace(/\n{3,}/g, "\n\n") : "(empty)";
        const who = d.ai ? " (written earlier by the AI)" : "";
        lines.push(`#${n} note${name}${who} ${box}${d.tint ? `, paper ${d.tint}` : ""}:\n${text.split("\n").map((l) => `    ${l}`).join("\n")}`);
        break;
      }
      case "image": {
        const d = o.data as ImageData;
        if (d.find && !d.url && !d.asset) {
          lines.push(`#${n} reference slot${name} ${box} — empty, to find: "${d.find}"`);
          break;
        }
        const src = d.asset ? `local file ${quote(d.name) || "(unnamed)"}` : d.url?.startsWith("data:") ? "pasted image" : `web image from ${host(d.url) ?? "a link"}${d.name ? ` ${quote(d.name)}` : ""}`;
        lines.push(`#${n} image${name} ${box}${tag} — ${src}${pic || " [picture not attached]"}`);
        break;
      }
      case "video": {
        const d = o.data as VideoData;
        const src = d.asset ? `local video ${quote(d.name)}` : `video ${d.url ?? ""}`;
        lines.push(`#${n} video${name} ${box}${tag} — ${src}${pic ? `${pic.replace("picture", "thumbnail")}` : ""}`);
        break;
      }
      case "color": {
        const d = o.data as ColorData;
        lines.push(`#${n} color swatch${name} ${box} — ${d.hex} (${hexToRgbHsl(d.hex)})`);
        break;
      }
      case "drawing": {
        const d = o.data as DrawingData;
        drawings++;
        lines.push(`#${n} freehand pen stroke ${box}, ${d.color}, ${d.size}px — an annotation drawn by the user`);
        break;
      }
    }
  }

  const edgeLines: string[] = [];
  for (const e of yEdges.values()) {
    const a = num.get(e.source), b = num.get(e.target);
    if (!a || !b) continue;
    edgeLines.push(`#${a} → #${b}${e.label ? ` "${e.label}"` : ""}`);
  }

  const pictures = objs.filter((o) => pictureSource(o)).length;
  const scopeLine = selection
    ? `Scope: the user's selection, ${objs.length} card${objs.length === 1 ? "" : "s"} (the board may have more).`
    : `Scope: the whole board, ${objs.length} card${objs.length === 1 ? "" : "s"}.`;
  const imgLine =
    pictures > images.length
      ? `${images.length} of ${pictures} pictures are attached; the rest are listed by name only.`
      : `${images.length} picture${images.length === 1 ? " is" : "s are"} attached.`;

  const text = [
    "<board>",
    scopeLine + " " + imgLine,
    "Coordinates are canvas pixels (x grows right, y grows down). Cards are numbered in reading order.",
    "",
    lines.length ? lines.join("\n") : "(no cards)",
    ...(edgeLines.length ? ["", "Lines:", ...edgeLines] : []),
    "</board>",
  ].join("\n");

  let bounds: BoardContext["bounds"] = null;
  if (objs.length) {
    const x0 = Math.min(...objs.map((o) => o.position.x));
    const y0 = Math.min(...objs.map((o) => o.position.y));
    const x1 = Math.max(...objs.map((o) => o.position.x + o.width));
    const y1 = Math.max(...objs.map((o) => o.position.y + o.height));
    bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  const cards = objs.length - drawings;
  const parts = [`${cards} card${cards === 1 ? "" : "s"}`];
  if (images.length) parts.push(`${images.length} image${images.length === 1 ? "" : "s"}`);
  if (edgeLines.length) parts.push(`${edgeLines.length} line${edgeLines.length === 1 ? "" : "s"}`);
  return { text, images, ids: objs.map((o) => o.id), summary: objs.length ? parts.join(" · ") : "an empty board", bounds };
}
