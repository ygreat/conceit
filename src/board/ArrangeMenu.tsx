import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReactFlow } from "@xyflow/react";
import { Columns3, LayoutDashboard, LayoutGrid, Network, Shuffle } from "lucide-react";
import type { LayoutKind } from "./layouts";

const OPTIONS: { kind: LayoutKind; label: string; hint: string; icon: ReactNode }[] = [
  { kind: "grid", label: "Grid", hint: "Neat rows, sizes kept", icon: <LayoutGrid size={16} aria-hidden /> },
  { kind: "masonry", label: "Masonry", hint: "Equal-width columns", icon: <Columns3 size={16} aria-hidden /> },
  { kind: "bento", label: "Bento board", hint: "Tiles snapped to a grid", icon: <LayoutDashboard size={16} aria-hidden /> },
  { kind: "flow", label: "Flow", hint: "Follow the lines, left to right", icon: <Network size={16} aria-hidden /> },
  { kind: "scatter", label: "Scatter", hint: "Loose random collage", icon: <Shuffle size={16} aria-hidden /> },
];

/** Cards (not drawings) the menu would arrange: the selection if 2+, else all. */
export function arrangeTargets(nodes: { id: string; type?: string; selected?: boolean }[]) {
  const cards = nodes.filter((n) => n.type !== "drawing");
  const selected = cards.filter((n) => n.selected);
  return selected.length >= 2 ? { ids: selected.map((n) => n.id), scope: "selection" as const } : { ids: cards.map((n) => n.id), scope: "all" as const };
}

export function ArrangeMenu({ onArrange, icon }: { onArrange: (kind: LayoutKind) => void; icon: ReactNode }) {
  const { getNodes } = useReactFlow();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const t = open ? arrangeTargets(getNodes()) : null;

  return (
    <div className="cn-arrange" ref={root}>
      <button
        className={`cn-icon-btn${open ? " on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Arrange"
        aria-label="Arrange"
      >
        {icon}
      </button>
      {open && t && (
        <div className="cn-arrange-menu" role="menu" aria-label="Arrange">
          <div className="cn-arrange-head">
            {t.ids.length < 2
              ? "Add a few cards to arrange"
              : t.scope === "selection"
                ? `Arrange ${t.ids.length} selected cards`
                : `Arrange all ${t.ids.length} cards`}
          </div>
          {OPTIONS.map((o) => (
            <button
              key={o.kind}
              role="menuitem"
              className="cn-arrange-item"
              disabled={t.ids.length < 2}
              onClick={() => {
                setOpen(false);
                onArrange(o.kind);
              }}
            >
              <span className="cn-arrange-icon">{o.icon}</span>
              <span>
                <span className="cn-arrange-label">{o.label}</span>
                <small>{o.hint}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
