import { useEffect, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { Download } from "lucide-react";
import { exportBoard, type ExportFormat } from "./exporter";

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Readable reason for any thrown value (DOM load errors arrive as bare Events). */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof Event !== "undefined" && err instanceof Event) {
    const t = err.target as { src?: string } | null;
    return `couldn't load ${t?.src ? t.src.slice(0, 80) : "an image"}`;
  }
  return String(err);
}

export function ExportMenu() {
  const { getNodes, getEdges, getNodesBounds } = useReactFlow();
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("png");
  const [area, setArea] = useState<"all" | "selection">("all");
  const [transparent, setTransparent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const selectedCount = open ? getNodes().filter((n) => n.selected && n.type !== "ghost").length : 0;
  const total = open ? getNodes().filter((n) => n.type !== "ghost").length : 0;
  const scope = area === "selection" && selectedCount > 0 ? "selection" : "all";

  useEffect(() => {
    if (!open) return;
    // Default to the selection when something is selected.
    setArea(getNodes().some((n) => n.selected) ? "selection" : "all");
    setStatus(null);
    const onDown = (e: PointerEvent) => {
      if (!busy && !root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && setOpen(false);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const run = async () => {
    setBusy(true);
    setStatus(null);
    try {
      // AI suggestions (ghosts) aren't part of the board yet.
      const nodes = getNodes().filter((n) => n.type !== "ghost");
      const onlyIds = scope === "selection" ? new Set(nodes.filter((n) => n.selected).map((n) => n.id)) : undefined;
      const { saved, missing } = await exportBoard({
        format,
        nodes,
        edges: getEdges(),
        onlyIds,
        transparent,
        bounds: (ns) => getNodesBounds(ns),
        fileName: `Conceit ${scope === "selection" ? "selection" : "board"} ${today()}`,
      });
      if (saved) {
        const note = missing ? ` · ${missing} image${missing > 1 ? "s" : ""} couldn't be included (blank)` : "";
        setStatus({ ok: !missing, text: `Saved ${saved.split(/[\\/]/).pop()}${note}` });
      }
    } catch (err) {
      console.error("Export failed:", err);
      setStatus({ ok: false, text: `Export failed: ${describe(err)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cn-settings" ref={root}>
      <button
        className={`cn-icon-btn cn-gear${open ? " on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Export"
        aria-label="Export"
      >
        <Download size={17} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div className="cn-settings-panel" role="dialog" aria-label="Export">
          <h3>Format</h3>
          <div className="cn-seg cn-theme" role="radiogroup" aria-label="Format">
            {(["png", "pdf"] as const).map((f) => (
              <button key={f} role="radio" aria-checked={format === f} className={format === f ? "on" : undefined} onClick={() => setFormat(f)}>
                {f.toUpperCase()}
              </button>
            ))}
          </div>
          <h3>Area</h3>
          <div className="cn-seg cn-theme" role="radiogroup" aria-label="Area">
            <button role="radio" aria-checked={scope === "all"} className={scope === "all" ? "on" : undefined} onClick={() => setArea("all")}>
              Whole board
            </button>
            <button
              role="radio"
              aria-checked={scope === "selection"}
              className={scope === "selection" ? "on" : undefined}
              disabled={!selectedCount}
              title={selectedCount ? undefined : "Select items on the canvas first"}
              onClick={() => setArea("selection")}
            >
              Selection{selectedCount ? ` (${selectedCount})` : ""}
            </button>
          </div>
          {format === "png" && (
            <label className="cn-export-check">
              <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />
              Transparent background
            </label>
          )}
          <button className="cn-add-btn cn-export-go" onClick={run} disabled={busy || !total}>
            <Download size={15} strokeWidth={2} aria-hidden />
            {busy ? "Exporting…" : `Export ${format.toUpperCase()}`}
          </button>
          {status && (
            <p className={`cn-export-status${status.ok ? "" : " cn-warn"}`} role="status">
              {status.text}
            </p>
          )}
          <p className="cn-export-hint">Only the board content is exported: no toolbars, handles or selection.</p>
        </div>
      )}
    </div>
  );
}
