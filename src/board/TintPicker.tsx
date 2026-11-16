import { useEffect, useRef, useState } from "react";
import { NodeToolbar, Position, useReactFlow } from "@xyflow/react";
import { Ban, Palette, Pipette } from "lucide-react";
import { asStep, getObject, patchData } from "./doc";

/** Paper tints suit notes; stronger colors suit headers. Both work on any card. */
export const LIGHT_TINTS = ["#fff4b8", "#ffe0c2", "#ffd9e0", "#efe3ff", "#d7f0ff", "#dff5d8", "#ececec"];
export const STRONG_TINTS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#0090ff", "#8e4ec6", "#2b2b2b"];

export const NOTE_DEFAULT_TINT = LIGHT_TINTS[0];

/** True when white text reads better than black on this color. */
export function isDarkColor(hex?: string): boolean {
  const m = hex && /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L < 0.3;
}

/**
 * Color dot in a card's header. Opens swatches above the card (outside it, so
 * the card's clipping and zoom don't affect it). Applies to every selected
 * card when this card is part of the selection.
 */
export function TintPicker({ id, tint, fallback }: { id: string; tint?: string; fallback?: string }) {
  const [open, setOpen] = useState(false);
  const { getNodes } = useReactFlow();
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /** Tints when the picker opened, so live custom previews can be undone as one step. */
  const before = useRef(new Map<string, string | undefined>());
  const previewing = useRef(false);

  const targets = () => {
    const sel = getNodes().filter((n) => n.selected).map((n) => n.id);
    return sel.includes(id) ? sel : [id];
  };

  const snapshot = () => {
    before.current = new Map(targets().map((t) => [t, (getObject(t)?.data as { tint?: string })?.tint]));
    previewing.current = false;
  };

  /** Restore the pre-preview values silently, then record one undo step. */
  const commit = (value: string | undefined) => {
    const ids = [...before.current.keys()];
    if (previewing.current) {
      for (const [t, v] of before.current) patchData(t, { tint: v }, { track: false });
      previewing.current = false;
    }
    if (ids.every((t) => before.current.get(t) === value)) return;
    asStep(() => ids.forEach((t) => patchData(t, { tint: value })));
    before.current = new Map(ids.map((t) => [t, value]));
  };

  const preview = (value: string) => {
    previewing.current = true;
    for (const t of before.current.keys()) patchData(t, { tint: value }, { track: false });
  };

  const close = () => {
    if (previewing.current) {
      const ids = [...before.current.keys()];
      commit((getObject(ids[0])?.data as { tint?: string })?.tint);
    }
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trigger.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  });

  const current = tint ?? fallback;
  const count = open ? before.current.size : 0;

  const swatch = (c: string) => (
    <button
      key={c}
      className={`cn-tint-swatch${current?.toLowerCase() === c ? " on" : ""}`}
      style={{ background: c }}
      onClick={() => commit(c)}
      aria-label={c}
      title={c}
    />
  );

  return (
    <>
      <button
        ref={trigger}
        className={`nodrag cn-tint-btn${open ? " on" : ""}`}
        title="Block color"
        aria-label="Block color"
        aria-expanded={open}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close();
          else {
            snapshot();
            setOpen(true);
          }
        }}
      >
        <Palette size={13} strokeWidth={2} aria-hidden />
      </button>
      <NodeToolbar isVisible={open} position={Position.Top} offset={8}>
        <div ref={panel} className="cn-tint-panel nodrag nowheel" role="dialog" aria-label="Block color">
          {count > 1 && <div className="cn-tint-note">{count} blocks</div>}
          <div className="cn-tint-row">{LIGHT_TINTS.map(swatch)}</div>
          <div className="cn-tint-row">{STRONG_TINTS.map(swatch)}</div>
          <div className="cn-tint-row cn-tint-actions">
            <label className="cn-tint-custom" title="Custom color">
              <Pipette size={13} aria-hidden />
              Custom
              <input
                type="color"
                value={current && /^#[0-9a-f]{6}$/i.test(current) ? current : "#888888"}
                onChange={(e) => preview(e.target.value)}
                onBlur={() => previewing.current && commit((getObject(id)?.data as { tint?: string })?.tint)}
                aria-label="Custom block color"
              />
            </label>
            <button className="cn-tint-clear" onClick={() => commit(undefined)} title="Back to the default color">
              <Ban size={13} aria-hidden />
              Default
            </button>
          </div>
        </div>
      </NodeToolbar>
    </>
  );
}
