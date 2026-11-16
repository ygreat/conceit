import { memo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { useReactFlow, useStore, type Node, type NodeProps } from "@xyflow/react";
import { addObject, asStep, patchData, undoManager, type DrawingData } from "./doc";
import { Resizer } from "./nodes";
import { updateSettings, useSettings } from "../settings";

// ---------------------------------------------------------------- Geometry

/** Space kept around the stroke inside its box, so round caps aren't clipped. */
const padOf = (size: number) => size / 2 + 1;

/** Smooth path through the points (midpoint quadratic curves). */
function pathOf(xy: number[]): string {
  const n = xy.length / 2;
  if (n === 0) return "";
  if (n === 1) return `M${xy[0]} ${xy[1]}l0.01 0`; // a dot
  let d = `M${xy[0]} ${xy[1]}`;
  for (let i = 1; i < n - 1; i++) {
    const x = xy[i * 2], y = xy[i * 2 + 1];
    const mx = (x + xy[i * 2 + 2]) / 2, my = (y + xy[i * 2 + 3]) / 2;
    d += `Q${x} ${y} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  return d + `L${xy[(n - 1) * 2]} ${xy[(n - 1) * 2 + 1]}`;
}

/** Scale stored points to the object's current size; the brush width stays the same. */
function scaled(data: DrawingData, w: number, h: number): number[] {
  const pad = padOf(data.size);
  const sx = data.w0 > 2 * pad ? (w - 2 * pad) / (data.w0 - 2 * pad) : 1;
  const sy = data.h0 > 2 * pad ? (h - 2 * pad) / (data.h0 - 2 * pad) : 1;
  if (sx === 1 && sy === 1) return data.points;
  return data.points.map((v, i) =>
    i % 2 === 0 ? +(pad + (v - pad) * sx).toFixed(1) : +(pad + (v - pad) * sy).toFixed(1),
  );
}

// ---------------------------------------------------------------- Drawing object

export const DrawingNode = memo(function DrawingNode({
  id,
  data,
  selected,
  width,
  height,
}: NodeProps<Node<DrawingData & Record<string, unknown>>>) {
  const w = width ?? data.w0, h = height ?? data.h0;
  const d = pathOf(scaled(data, w, h));
  return (
    <>
      <Resizer id={id} selected={selected} minWidth={8} minHeight={8} />
      <svg className="cn-drawing" width={w} height={h} aria-label="Drawing">
        {/* Wider invisible stroke: easier to click a thin line. */}
        <path className="cn-drawing-hit" d={d} strokeWidth={Math.max(data.size, 14)} />
        <path
          d={d}
          fill="none"
          stroke={data.color}
          strokeWidth={data.size}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
});

// ---------------------------------------------------------------- Draw mode layer

const transformSelector = (s: { transform: [number, number, number] }) => s.transform;

/**
 * Covers the canvas while the Draw tool is on: pointer drags become strokes,
 * and the trackpad still pans (two-finger scroll) and zooms (pinch / ⌘-scroll).
 */
export function DrawLayer() {
  const { brushColor: color, brushSize: size } = useSettings();
  const { screenToFlowPosition, getViewport, setViewport } = useReactFlow();
  const [tx, ty, zoom] = useStore(transformSelector);
  const layer = useRef<HTMLDivElement>(null);
  const pts = useRef<number[] | null>(null);
  const [live, setLive] = useState<number[] | null>(null);

  const toFlow = (e: { clientX: number; clientY: number }) => screenToFlowPosition({ x: e.clientX, y: e.clientY });

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toFlow(e);
    pts.current = [p.x, p.y];
    setLive(pts.current);
  };

  const onMove = (e: PointerEvent) => {
    const cur = pts.current;
    if (!cur) return;
    // Coalesced events keep fast strokes smooth.
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    const minStep = 1.5 / zoom; // skip points closer than 1.5 screen px
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const p = toFlow(ev);
      const lx = cur[cur.length - 2], ly = cur[cur.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) >= minStep) cur.push(p.x, p.y);
    }
    setLive([...cur]);
  };

  const onUp = () => {
    const cur = pts.current;
    pts.current = null;
    setLive(null);
    if (!cur) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < cur.length; i += 2) {
      minX = Math.min(minX, cur[i]); maxX = Math.max(maxX, cur[i]);
      minY = Math.min(minY, cur[i + 1]); maxY = Math.max(maxY, cur[i + 1]);
    }
    const pad = padOf(size);
    const w0 = Math.max(1, Math.ceil(maxX - minX + 2 * pad));
    const h0 = Math.max(1, Math.ceil(maxY - minY + 2 * pad));
    const points = cur.map((v, i) => +(v - (i % 2 === 0 ? minX : minY) + pad).toFixed(1));
    addObject({
      type: "drawing",
      position: { x: minX - pad, y: minY - pad },
      width: w0,
      height: h0,
      data: { points, w0, h0, color, size },
    });
  };

  // Pan with two-finger scroll, zoom with pinch (ctrl+wheel) or ⌘+scroll.
  const onWheel = (e: WheelEvent) => {
    const v = getViewport();
    if (e.ctrlKey || e.metaKey) {
      const r = layer.current!.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const z = Math.min(4, Math.max(0.05, v.zoom * Math.exp(-e.deltaY * 0.01)));
      setViewport({ zoom: z, x: px - ((px - v.x) * z) / v.zoom, y: py - ((py - v.y) * z) / v.zoom });
    } else {
      setViewport({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
    }
  };

  const screen = live?.map((v, i) => (i % 2 === 0 ? v * zoom + tx : v * zoom + ty));

  return (
    <div
      ref={layer}
      className="cn-draw-layer"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onWheel={onWheel}
    >
      {screen && (
        <svg className="cn-draw-live">
          <path
            d={pathOf(screen)}
            fill="none"
            stroke={color}
            strokeWidth={size * zoom}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Brush controls

export const BRUSH_COLORS = [
  "#1d1d1f", "#ffffff", "#8a877f", "#e5484d", "#f76b15", "#ffc53d",
  "#30a46c", "#0090ff", "#8e4ec6", "#e93d82",
];

function BrushControls({
  color,
  size,
  onColor,
  onSize,
  onSizeDone,
}: {
  color?: string;
  size?: number;
  onColor: (c: string) => void;
  onSize: (s: number) => void;
  onSizeDone?: () => void;
}) {
  return (
    <>
      <div className="cn-brush-row" role="radiogroup" aria-label="Brush color">
        {BRUSH_COLORS.map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={color?.toLowerCase() === c}
            aria-label={c}
            title={c}
            className={`cn-tint-swatch${color?.toLowerCase() === c ? " on" : ""}`}
            style={{ background: c }}
            onClick={() => onColor(c)}
          />
        ))}
        <label className="cn-brush-custom" title="Custom color">
          <input
            type="color"
            value={color && /^#[0-9a-f]{6}$/i.test(color) ? color : "#888888"}
            onChange={(e) => onColor(e.target.value)}
            aria-label="Custom brush color"
          />
        </label>
      </div>
      <div className="cn-brush-row">
        <span className="cn-brush-dot" aria-hidden>
          <span style={{ width: Math.min(size ?? 4, 28), height: Math.min(size ?? 4, 28), background: color }} />
        </span>
        <input
          type="range"
          min={1}
          max={32}
          value={size ?? 4}
          onChange={(e) => onSize(Number(e.target.value))}
          onPointerUp={onSizeDone}
          onKeyUp={onSizeDone}
          aria-label="Brush size"
        />
        <span className="cn-brush-px">{size ?? "–"} px</span>
      </div>
    </>
  );
}

/** Brush for new strokes (shown while the Draw tool is on). */
export function BrushPanel() {
  const s = useSettings();
  return (
    <div className="cn-brush-panel" role="dialog" aria-label="Brush">
      <BrushControls
        color={s.brushColor}
        size={s.brushSize}
        onColor={(c) => updateSettings({ brushColor: c })}
        onSize={(n) => updateSettings({ brushSize: n })}
      />
      <p className="cn-brush-hint">Draw on the canvas · P or Esc to stop</p>
    </div>
  );
}

/** Restyle selected drawings. Each color pick is one undo step; a slider drag merges into one. */
export function DrawingStyleDock({ drawings }: { drawings: { id: string; data: DrawingData }[] }) {
  const colors = new Set(drawings.map((d) => d.data.color.toLowerCase()));
  const sizes = new Set(drawings.map((d) => d.data.size));
  const apply = (patch: Partial<DrawingData>) => drawings.forEach((d) => patchData(d.id, patch));
  return (
    <div className="cn-line-dock">
      <div className="cn-brush-panel cn-brush-dock" role="dialog" aria-label="Drawing style">
        <div className="cn-brush-title">
          Drawing{drawings.length > 1 ? ` · ${drawings.length} strokes` : ""}
        </div>
        <BrushControls
          color={colors.size === 1 ? [...colors][0] : undefined}
          size={sizes.size === 1 ? [...sizes][0] : undefined}
          onColor={(c) => asStep(() => apply({ color: c }))}
          onSize={(n) => apply({ size: n })}
          onSizeDone={() => undoManager.stopCapturing()}
        />
      </div>
    </div>
  );
}
