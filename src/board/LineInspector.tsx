import { useEffect, useState, type ReactNode } from "react";
import {
  asStep,
  lineOf,
  patchEdges,
  transact,
  yEdges,
  type BoardEdge,
  type LineDash,
  type LinePath,
  type LineStyle,
  type MarkerShape,
} from "./doc";
import { MarkerGlyph, dashArray } from "./edges";
import { ChevronUp, Spline, X } from "lucide-react";

const PRESET_COLORS = [
  "#8a877f", "#1d1d1f", "#e5484d", "#f76b15", "#ffc53d",
  "#30a46c", "#0090ff", "#8e4ec6", "#e93d82",
];
const SHAPES: MarkerShape[] = ["none", "arrow", "triangle", "circle", "diamond"];
const DASHES: LineDash[] = ["solid", "dashed", "dotted"];
const PATHS: { value: LinePath; label: string; d: string }[] = [
  { value: "bezier", label: "Curved", d: "M3 17 C 12 17, 16 5, 25 5" },
  { value: "smoothstep", label: "Elbow", d: "M3 17 H 12 Q 14 17 14 15 V 7 Q 14 5 16 5 H 25" },
  { value: "straight", label: "Straight", d: "M3 17 L 25 5" },
];

function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
  render,
  title,
}: {
  value: T | undefined;
  options: T[];
  onChange: (v: T) => void;
  label: string;
  render: (v: T) => ReactNode;
  title: (v: T) => string;
}) {
  return (
    <div className="cn-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          role="radio"
          aria-checked={value === o}
          title={title(o)}
          className={value === o ? "on" : undefined}
          onClick={() => onChange(o)}
        >
          {render(o)}
        </button>
      ))}
    </div>
  );
}

function MarkerIcon({ shape, flip }: { shape: MarkerShape; flip?: boolean }) {
  return (
    <svg width="28" height="16" viewBox="0 0 28 16" aria-hidden="true">
      <g transform={flip ? "translate(28 0) scale(-1 1)" : undefined}>
        <line x1="2" y1="8" x2={shape === "none" ? 26 : 18} y2="8" stroke="currentColor" strokeWidth="1.6" />
        {shape !== "none" && (
          <svg x="16" y="3" width="10" height="10" viewBox="0 0 10 10" overflow="visible">
            <MarkerGlyph shape={shape} color="currentColor" />
          </svg>
        )}
      </g>
    </svg>
  );
}

/** Same value across all selected lines, or undefined when they differ. */
function common<K extends keyof LineStyle>(lines: LineStyle[], key: K): LineStyle[K] | undefined {
  const v = lines[0]?.[key];
  return lines.every((l) => l[key] === v) ? v : undefined;
}

/**
 * Selecting a line shows a small "Line style" button; the full panel opens
 * from it, so the canvas stays clear while you work.
 */
export function LineInspector({ ids }: { ids: string[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const first = yEdges.get(ids[0]);
  const swatch = first ? lineOf(first).color : undefined;

  return (
    <div className="cn-line-dock">
      {open && <LinePanel ids={ids} onClose={() => setOpen(false)} />}
      <button
        className={`cn-line-pill${open ? " on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Hide line style" : "Show line style"}
      >
        <Spline size={15} strokeWidth={1.9} color={swatch} aria-hidden />
        Line style{ids.length > 1 ? ` · ${ids.length} lines` : ""}
        <ChevronUp size={14} className="cn-chevron" aria-hidden />
      </button>
    </div>
  );
}

function LinePanel({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const edges = ids.map((id) => yEdges.get(id)).filter(Boolean) as BoardEdge[];
  const lines = edges.map(lineOf);
  // Sliders, color wheels and typing merge into one step; button picks don't.
  const set = (patch: Partial<LineStyle>) => patchEdges(ids, { line: patch });
  const pick = (patch: Partial<LineStyle>) => asStep(() => set(patch));

  const color = common(lines, "color");
  const width = common(lines, "width");
  const sharedLabel = edges.every((e) => (e.label ?? "") === (edges[0]?.label ?? ""))
    ? edges[0]?.label ?? ""
    : "";
  const [label, setLabel] = useState(sharedLabel);
  useEffect(() => setLabel(sharedLabel), [sharedLabel, ids.join()]);

  if (!edges.length) return null;

  return (
    <div className="cn-inspector" role="dialog" aria-label="Line style">
      <button className="cn-insp-close" onClick={onClose} title="Close" aria-label="Close line style">
        <X size={15} aria-hidden />
      </button>
      <div className="cn-insp-row">
        <span className="cn-insp-label">Color</span>
        <div className="cn-colors">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              className={`cn-dot${color?.toLowerCase() === c ? " on" : ""}`}
              style={{ background: c }}
              title={c}
              aria-label={`Color ${c}`}
              onClick={() => pick({ color: c })}
            />
          ))}
          <label className="cn-dot cn-dot-custom" title="Custom color">
            <input
              type="color"
              value={color ?? "#8a877f"}
              onChange={(e) => set({ color: e.target.value })}
              aria-label="Custom color"
            />
          </label>
        </div>
      </div>

      <div className="cn-insp-row">
        <span className="cn-insp-label">Width</span>
        <input
          type="range"
          min={1}
          max={10}
          step={0.5}
          value={width ?? 2}
          onChange={(e) => set({ width: Number(e.target.value) })}
          aria-label="Stroke width"
        />
        <span className="cn-insp-value">{width ?? "–"}px</span>
      </div>

      <div className="cn-insp-row">
        <span className="cn-insp-label">Stroke</span>
        <Seg
          label="Stroke style"
          value={common(lines, "dash")}
          options={DASHES}
          onChange={(dash) => pick({ dash })}
          title={(d) => d[0].toUpperCase() + d.slice(1)}
          render={(d) => (
            <svg width="28" height="16" viewBox="0 0 28 16" aria-hidden="true">
              <line
                x1="3" y1="8" x2="25" y2="8"
                stroke="currentColor" strokeWidth="2"
                strokeDasharray={dashArray(d, 2)}
                strokeLinecap={d === "dotted" ? "round" : "butt"}
              />
            </svg>
          )}
        />
        <Seg
          label="Path"
          value={common(lines, "path")}
          options={PATHS.map((p) => p.value)}
          onChange={(path) => pick({ path })}
          title={(v) => PATHS.find((p) => p.value === v)!.label}
          render={(v) => (
            <svg width="28" height="22" viewBox="0 0 28 22" aria-hidden="true">
              <path d={PATHS.find((p) => p.value === v)!.d} fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          )}
        />
      </div>

      <div className="cn-insp-row">
        <span className="cn-insp-label">Start</span>
        <Seg
          label="Start marker"
          value={common(lines, "start")}
          options={SHAPES}
          onChange={(start) => pick({ start })}
          title={(s) => s}
          render={(s) => <MarkerIcon shape={s} flip />}
        />
      </div>
      <div className="cn-insp-row">
        <span className="cn-insp-label">End</span>
        <Seg
          label="End marker"
          value={common(lines, "end")}
          options={SHAPES}
          onChange={(end) => pick({ end })}
          title={(s) => s}
          render={(s) => <MarkerIcon shape={s} />}
        />
      </div>

      <div className="cn-insp-row">
        <span className="cn-insp-label">Label</span>
        <input
          className="cn-insp-text"
          value={label}
          placeholder={edges.length > 1 ? "Label all selected lines" : "Add a label"}
          onChange={(e) => {
            setLabel(e.target.value);
            patchEdges(ids, { label: e.target.value });
          }}
          aria-label="Line label"
        />
        <button
          className="cn-danger"
          onClick={() => asStep(() => transact(() => ids.forEach((id) => yEdges.delete(id))))}
          title="Delete line"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
