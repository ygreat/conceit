import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Handle,
  NodeResizer,
  Position,
  useStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  asStep,
  patchData,
  patchObject,
  undoManager,
  getObject,
  type ColorData,
  type ImageData,
  type NoteData,
  type VideoData,
} from "./doc";
import { fitImage, isUrl, videoEmbed, withFirstFrame } from "./media";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@tauri-apps/api/core";
import { ImagePlus } from "lucide-react";
import { importMedia, mediaSrc } from "./assets";
import { useMissing } from "../files/persist";
import { useExporting } from "./exporter";
import { NOTE_DEFAULT_TINT, TintPicker, isDarkColor } from "./TintPicker";

/** Class names and CSS variable for a card's block color. */
function tintProps(base: string, tint: string | undefined) {
  return {
    className: `${base}${tint ? " cn-tinted" : ""}${isDarkColor(tint) ? " cn-on-dark" : ""}`,
    style: tint ? ({ "--cn-tint": tint } as CSSProperties) : undefined,
  };
}

/** Below this zoom level, heavy media (video players, embeds) is swapped for a placeholder. */
const MEDIA_LOD_ZOOM = 0.45;
export const HEADER_H = 26;

const zoomSelector = (s: { transform: [number, number, number] }) => s.transform[2];

export function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Bottom} id="b" />
      <Handle type="target" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Right} id="r" />
    </>
  );
}

export function Resizer({
  id,
  selected,
  minWidth = 80,
  minHeight = 60,
  keepAspectRatio,
}: {
  id: string;
  selected: boolean;
  minWidth?: number;
  minHeight?: number;
  keepAspectRatio?: boolean;
}) {
  return (
    <NodeResizer
      isVisible={selected}
      minWidth={minWidth}
      minHeight={minHeight}
      keepAspectRatio={keepAspectRatio}
      lineClassName="cn-resize-line"
      handleClassName="cn-resize-handle"
      onResizeEnd={(_e, p) =>
        patchObject(id, {
          position: { x: p.x, y: p.y },
          width: p.width,
          height: p.height,
        })
      }
    />
  );
}

function GripIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true" className="cn-grip">
      {[2, 7, 12].map((y) => (
        <g key={y}>
          <circle cx="2.5" cy={y} r="1.3" />
          <circle cx="7.5" cy={y} r="1.3" />
        </g>
      ))}
    </svg>
  );
}

/** Ask a card's header to start renaming (sent by Enter on a selected card). */
export const RENAME_EVENT = "conceit:rename";

/**
 * The visible drag handle every card shares. Double-click the name (or press
 * Enter with the card selected) to rename it; an empty name restores the default.
 */
function CardHeader({
  id,
  kind,
  title,
  fallback,
  tint,
  tintFallback,
}: {
  id: string;
  kind: string;
  /** Custom name stored on the card. */
  title?: string;
  /** Shown when there is no custom name, e.g. the file name. */
  fallback?: string;
  tint?: string;
  /** Color shown when the card has none of its own (notes are yellow). */
  tintFallback?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const cancelled = useRef(false);
  const shown = title || fallback;

  const start = () => {
    cancelled.current = false;
    setDraft(shown ?? "");
    setEditing(true);
  };
  useEffect(() => {
    const onRename = (e: Event) => (e as CustomEvent<string>).detail === id && start();
    window.addEventListener(RENAME_EVENT, onRename);
    return () => window.removeEventListener(RENAME_EVENT, onRename);
  });

  const commit = () => {
    setEditing(false);
    if (cancelled.current) return;
    const v = draft.trim();
    const next = v === (fallback ?? "") ? "" : v; // typing the default back = no custom name
    if (next !== (title ?? "")) asStep(() => patchData(id, { title: next }));
  };

  return (
    <div
      className="cn-drag-bar"
      title={editing ? undefined : "Drag to move · double-click to rename"}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!editing) start();
      }}
    >
      <GripIcon />
      <span className="cn-kind">{kind}</span>
      {editing ? (
        <input
          className="nodrag cn-title-input"
          value={draft}
          autoFocus
          placeholder={fallback ?? `Name this ${kind.toLowerCase()}`}
          aria-label={`Rename ${kind.toLowerCase()}`}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              cancelled.current = true;
              setEditing(false);
            }
          }}
        />
      ) : (
        shown && <span className={`cn-title${title ? " cn-custom" : ""}`}>{shown}</span>
      )}
      <TintPicker id={id} tint={tint} fallback={tintFallback} />
    </div>
  );
}

function hostOf(url?: string) {
  if (!url || url.startsWith("data:")) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- Note

export const NoteNode = memo(function NoteNode({
  id,
  data,
  selected,
}: NodeProps<Node<NoteData & Record<string, unknown>>>) {
  const [text, setText] = useState(data.text);
  useEffect(() => setText(data.text), [data.text]);

  return (
    <div
      className={`cn-card cn-note${isDarkColor(data.tint ?? NOTE_DEFAULT_TINT) ? " cn-on-dark" : ""}`}
      style={{ background: data.tint ?? NOTE_DEFAULT_TINT }}
    >
      <Resizer id={id} selected={selected} />
      <Handles />
      <CardHeader id={id} kind={data.ai ? "✦ AI" : "Note"} title={data.title} tint={data.tint} tintFallback={NOTE_DEFAULT_TINT} />
      <textarea
        className="nodrag nowheel cn-note-text"
        value={text}
        placeholder="Write an idea…"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== data.text && patchData(id, { text })}
      />
    </div>
  );
});

// ---------------------------------------------------------------- Reference slot

/** Where to look for a reference; opens in the browser. */
const SEARCHES: { label: string; url: (q: string) => string }[] = [
  { label: "Pinterest", url: (q) => `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(q)}` },
  { label: "Unsplash", url: (q) => `https://unsplash.com/s/photos/${encodeURIComponent(q.trim().replace(/\s+/g, "-"))}` },
  { label: "Google", url: (q) => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}` },
];

/** Put a picture into a reference slot: it becomes a normal image card. */
export function fillSlot(id: string, url: string) {
  asStep(() => patchData(id, { url, find: undefined, why: undefined, sized: false } as Partial<ImageData>));
}

function SlotBody({ id, data }: { id: string; data: ImageData }) {
  const [link, setLink] = useState("");
  const open = (u: string) => (isTauri() ? openUrl(u) : window.open(u, "_blank", "noopener"));
  return (
    <div className="cn-slot">
      <ImagePlus size={20} strokeWidth={1.5} aria-hidden />
      <span className="cn-slot-find">“{data.find}”</span>
      {data.why && <span className="cn-slot-why">{data.why}</span>}
      <div className="cn-slot-search nodrag">
        {SEARCHES.map((s) => (
          <button key={s.label} type="button" onClick={() => void open(s.url(data.find!))}>
            {s.label}
          </button>
        ))}
      </div>
      <form
        className="cn-slot-link nodrag"
        onSubmit={(e) => {
          e.preventDefault();
          if (isUrl(link)) fillSlot(id, link.trim());
        }}
      >
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Paste an image link, or select and ⌘V"
          aria-label="Image link for this reference"
          onKeyDown={(e) => e.stopPropagation()}
        />
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- Image

export const ImageNode = memo(function ImageNode({
  id,
  data,
  selected,
}: NodeProps<Node<ImageData & Record<string, unknown>>>) {
  const [failed, setFailed] = useState(false);
  const missing = useMissing();
  const src = mediaSrc(data);

  // Once, when the image first loads: size the card to the image's real aspect
  // ratio (as displayed, so rotated phone photos are right), without an undo step.
  const fitToImage = (img: HTMLImageElement) => {
    if (data.sized || !img.naturalWidth || !img.naturalHeight) return;
    const { width, height } = fitImage(img.naturalWidth, img.naturalHeight);
    patchObject(id, { width, height: height + HEADER_H, data: { sized: true } }, { track: false });
  };
  return (
    <div {...tintProps("cn-card cn-media", data.tint)}>
      <Resizer id={id} selected={selected} keepAspectRatio />
      <Handles />
      <CardHeader id={id} kind={data.find && !src ? "Reference" : "Image"} title={data.title} tint={data.tint} fallback={data.name ?? hostOf(data.url)} />
      <div className="cn-media-body">
        {data.find && !src ? (
          <SlotBody id={id} data={data} />
        ) : data.asset && (failed || !src || missing.has(data.asset)) ? (
          <MissingMedia id={id} kind="image" name={data.name ?? data.url} />
        ) : failed || !src ? (
          <div className="cn-placeholder">
            Image failed to load
            <span className="cn-url">{data.name ?? data.url}</span>
          </div>
        ) : (
          <img
            src={src}
            data-asset={data.asset}
            alt={data.name ?? ""}
            draggable={false}
            loading="lazy"
            decoding="async"
            onLoad={(e) => fitToImage(e.currentTarget)}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
});

/**
 * A local picture or video that is neither in the board file nor on this
 * machine (e.g. a board from before board files, made on another computer).
 * "Relink" picks the file again; the card keeps its place, size and title.
 */
function MissingMedia({ id, kind, name }: { id: string; kind: "image" | "video"; name?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const relink = async () => {
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const exts = kind === "image" ? ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp"] : ["mp4", "m4v", "mov", "webm", "ogv"];
      const path = await open({ multiple: false, filters: [{ name: kind === "image" ? "Images" : "Videos", extensions: exts }] });
      if (typeof path !== "string") return;
      setBusy(true);
      const { imported, skipped } = await importMedia([path]);
      const m = imported[0];
      if (!m) throw new Error(skipped[0]?.[1] ?? "couldn't import");
      asStep(() => patchData(id, { asset: m.asset, name: m.name, sized: false } as Partial<ImageData>));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cn-placeholder cn-missing">
      <strong>Missing {kind}</strong>
      <span className="cn-url">{name ?? "Local file"}</span>
      {isTauri() && (
        <button type="button" className="nodrag cn-slot-btn" onClick={relink} disabled={busy}>
          {busy ? "Relinking…" : "Relink…"}
        </button>
      )}
      {error && <span className="cn-url">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- Video

export const VideoNode = memo(function VideoNode({
  id,
  data,
  selected,
}: NodeProps<Node<VideoData & Record<string, unknown>>>) {
  const zoom = useStore(zoomSelector);
  const missing = useMissing();
  // Exports can't capture live players, so they show stills while exporting.
  const exporting = useExporting();
  const live = zoom >= MEDIA_LOD_ZOOM && !exporting;
  const embed = data.asset
    ? (() => {
        const src = mediaSrc(data);
        return src ? { kind: "file" as const, src } : null;
      })()
    : videoEmbed(data.url ?? "");

  // Fit the card to the video's real aspect ratio once, without an undo step.
  const fitToVideo = (v: HTMLVideoElement) => {
    if (data.sized || !v.videoWidth || !v.videoHeight) return;
    const cur = getObject(id);
    if (!cur) return;
    patchObject(
      id,
      {
        height: Math.round((cur.width * v.videoHeight) / v.videoWidth) + HEADER_H,
        data: { sized: true },
      },
      { track: false },
    );
  };

  const kindLabel = data.asset ? "Video" : embed?.kind === "youtube" ? "YouTube" : embed?.kind === "vimeo" ? "Vimeo" : "Video";

  return (
    <div {...tintProps("cn-card cn-video", data.tint)}>
      <Resizer id={id} selected={selected} minWidth={200} minHeight={140} />
      <Handles />
      <CardHeader
        id={id}
        kind={kindLabel}
        title={data.title}
        tint={data.tint}
        fallback={data.name ?? (embed?.kind === "file" ? hostOf(data.url) : undefined)}
      />
      <div className="cn-video-body">
        {data.asset && (!embed || missing.has(data.asset)) ? (
          <MissingMedia id={id} kind="video" name={data.name ?? data.url} />
        ) : !embed ? (
          <div className="cn-placeholder">
            Unrecognized video link
            <span className="cn-url">{data.name ?? data.url}</span>
          </div>
        ) : embed.kind === "file" ? (
          // Zoomed out, the same element shows just its first frame: no
          // controls, not interactive, so the card can still be dragged.
          <video
            className={live ? "nodrag" : "cn-still"}
            src={withFirstFrame(embed.src)}
            data-asset={data.asset}
            controls={live}
            preload="metadata"
            playsInline
            muted={!live}
            onLoadedMetadata={(e) => fitToVideo(e.currentTarget)}
          />
        ) : !live ? (
          embed.kind === "youtube" ? (
            <img className="cn-still" src={embed.thumb} alt="" draggable={false} loading="lazy" />
          ) : (
            <div className="cn-placeholder">Zoom in to play</div>
          )
        ) : (
          <iframe
            className="nodrag"
            src={embed.src}
            title="Embedded video"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------- Color

function hexToRgb(hex: string) {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function luminance({ r, g, b }: { r: number; g: number; b: number }) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function hslToRgb(h: number, s: number, l: number) {
  const sn = s / 100, ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Three numbers from "rgb(1, 2, 3)", "hsl(10 50% 40%)", "1,2,3", "1 2 3"… */
function numbers(text: string, prefix: string): number[] | null {
  const body = text.trim().toLowerCase().replace(new RegExp(`^${prefix}a?\\((.*)\\)$`), "$1");
  const parts = body.split(/[\s,/]+/).filter(Boolean).slice(0, 3);
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number(p.replace(/%|deg$/g, "")));
  return nums.every(Number.isFinite) ? nums : null;
}

type ColorFormat = "hex" | "rgb" | "hsl";

/** Parse user input in one format; returns a #rrggbb hex or null if invalid. */
function parseColor(format: ColorFormat, text: string): string | null {
  if (format === "hex") {
    const m = text.trim().replace(/^#/, "").match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return null;
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    return "#" + h.toLowerCase();
  }
  const n = numbers(text, format);
  if (!n) return null;
  if (format === "rgb") {
    if (n.some((v) => v < 0 || v > 255)) return null;
    return rgbToHex({ r: Math.round(n[0]), g: Math.round(n[1]), b: Math.round(n[2]) });
  }
  const [h, s, l] = n;
  if (s < 0 || s > 100 || l < 0 || l > 100) return null;
  return rgbToHex(hslToRgb(((h % 360) + 360) % 360, s, l));
}

function formatColor(format: ColorFormat, hex: string) {
  const rgb = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
  if (format === "hex") return hex.toUpperCase();
  if (format === "rgb") return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  const { h, s, l } = rgbToHsl(rgb);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M8 2 V1.8 A1 1 0 0 0 7 1 H2 A1 1 0 0 0 1 2 V7 A1 1 0 0 0 2 8 H2.3" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

/**
 * One editable color value. Valid input updates the color as you type;
 * invalid input is flagged and reverted on blur. Enter commits, Escape cancels.
 */
function ColorField({ id, format, hex }: { id: string; format: ColorFormat; hex: string }) {
  const shown = formatColor(format, hex);
  const [draft, setDraft] = useState(shown);
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [copied, setCopied] = useState(false);
  const before = useRef(hex); // color when editing began
  const cancelled = useRef(false);

  /** Live preview while typing: shown everywhere, but kept out of undo history. */
  const preview = (next: string) => patchData(id, { hex: next }, { track: false });

  /** On leaving the field, record one undo step from the starting color to the result. */
  const commit = () => {
    const now = (getObject(id)?.data as ColorData | undefined)?.hex;
    if (!now || now === before.current) return;
    patchData(id, { hex: before.current }, { track: false });
    undoManager.stopCapturing();
    patchData(id, { hex: now });
    undoManager.stopCapturing();
  };

  // Follow outside changes (picker, other fields, undo) unless the user is typing here.
  useEffect(() => {
    if (!editing) {
      setDraft(shown);
      setInvalid(false);
    }
  }, [shown, editing]);

  const label = format.toUpperCase();
  return (
    <li className="cn-format">
      <span className="cn-format-label">{label}</span>
      <input
        className={`nodrag cn-format-input${invalid ? " cn-invalid" : ""}`}
        value={draft}
        spellCheck={false}
        aria-label={`${label} value`}
        aria-invalid={invalid}
        onFocus={(e) => {
          setEditing(true);
          before.current = hex;
          cancelled.current = false;
          e.currentTarget.select();
        }}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const next = parseColor(format, text);
          setInvalid(next === null);
          if (next && next !== hex.toLowerCase()) preview(next);
        }}
        onBlur={() => {
          if (!cancelled.current) commit();
          setEditing(false);
          setDraft(shown);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            if (hex !== before.current) preview(before.current);
            e.currentTarget.blur();
          }
        }}
      />
      <button
        className="nodrag cn-copy"
        title={copied ? "Copied" : `Copy ${label}`}
        aria-label={`Copy ${label}`}
        onClick={() => {
          navigator.clipboard?.writeText(shown);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? "✓" : <CopyIcon />}
      </button>
    </li>
  );
}

export const ColorNode = memo(function ColorNode({
  id,
  data,
  selected,
}: NodeProps<Node<ColorData & Record<string, unknown>>>) {
  const rgb = hexToRgb(data.hex) ?? { r: 0, g: 0, b: 0 };
  const ink = luminance(rgb) > 0.6 ? "#111" : "#fff";

  return (
    <div {...tintProps("cn-card cn-color", data.tint)}>
      <Resizer id={id} selected={selected} minWidth={200} minHeight={180} />
      <Handles />
      <CardHeader id={id} kind="Color" title={data.title} tint={data.tint} />
      <label className="cn-swatch nodrag" style={{ background: data.hex, color: ink }}>
        <input
          type="color"
          value={data.hex}
          onChange={(e) => patchData(id, { hex: e.target.value })}
        />
        <span>Pick</span>
      </label>
      <ul className="cn-formats">
        <ColorField id={id} format="hex" hex={data.hex} />
        <ColorField id={id} format="rgb" hex={data.hex} />
        <ColorField id={id} format="hsl" hex={data.hex} />
      </ul>
    </div>
  );
});

export const nodeTypes = {
  note: NoteNode,
  image: ImageNode,
  video: VideoNode,
  color: ColorNode,
};
