import { useEffect, useState, type FormEvent } from "react";
import { LayoutDashboard, Link, Palette, PenLine, Plus, Redo2, Sparkles, StickyNote, Undo2 } from "lucide-react";
import { ExportMenu } from "./ExportMenu";
import { ArrangeMenu } from "./ArrangeMenu";
import type { LayoutKind } from "./layouts";
import { undoManager } from "./doc";
import { useSettings } from "../settings";
import { SettingsMenu } from "../SettingsMenu";

function useFps(enabled: boolean) {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      frames++;
      if (now - last >= 500) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);
  return fps;
}

/** Whether there is anything to undo / redo, kept in sync with the history. */
function useHistory() {
  const read = () => ({ canUndo: undoManager.canUndo(), canRedo: undoManager.canRedo() });
  const [state, setState] = useState(read);
  useEffect(() => {
    const sync = () => setState(read());
    const events = ["stack-item-added", "stack-item-popped", "stack-cleared", "stack-item-updated"] as const;
    events.forEach((ev) => undoManager.on(ev, sync));
    sync();
    return () => events.forEach((ev) => undoManager.off(ev, sync));
  }, []);
  return state;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const UNDO_KEYS = isMac ? "⌘Z" : "Ctrl+Z";
const REDO_KEYS = isMac ? "⇧⌘Z" : "Ctrl+Shift+Z";

interface Props {
  objectCount: number;
  onAddNote: () => void;
  onAddColor: () => void;
  onAddUrl: (url: string) => void;
  onStress: (count: number) => void;
  onClear: () => void;
  drawMode: boolean;
  onToggleDraw: () => void;
  onArrange: (kind: LayoutKind) => void;
  aiOpen: boolean;
  onToggleAi: () => void;
}

const ICON = { size: 17, strokeWidth: 1.75, "aria-hidden": true } as const;

export function Toolbar({ objectCount, onAddNote, onAddColor, onAddUrl, onStress, onClear, drawMode, onToggleDraw, onArrange, aiOpen, onToggleAi }: Props) {
  const [url, setUrl] = useState("");
  const settings = useSettings();
  const fps = useFps(settings.stats);
  const { canUndo, canRedo } = useHistory();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = url.trim();
    if (!v) return;
    onAddUrl(v);
    setUrl("");
  };

  return (
    <>
      <div className="cn-toolbar" role="toolbar" aria-label="Canvas tools">
        <img className="cn-brand" src="/conceit-icon.png" alt="Conceit" title="Conceit" width={24} height={24} draggable={false} />
        <button className="cn-icon-btn" onClick={onAddNote} title="Add note" aria-label="Add note">
          <StickyNote {...ICON} />
        </button>
        <button className="cn-icon-btn" onClick={onAddColor} title="Add color" aria-label="Add color">
          <Palette {...ICON} />
        </button>
        <button
          className={`cn-icon-btn${drawMode ? " on" : ""}`}
          onClick={onToggleDraw}
          aria-pressed={drawMode}
          title="Draw (P)"
          aria-label="Draw"
        >
          <PenLine {...ICON} />
        </button>
        <ArrangeMenu onArrange={onArrange} icon={<LayoutDashboard {...ICON} />} />
        <button
          className={`cn-icon-btn${aiOpen ? " on" : ""}`}
          onClick={onToggleAi}
          aria-pressed={aiOpen}
          title={`AI board partner (${isMac ? "⌘J" : "Ctrl+J"})`}
          aria-label="AI board partner"
        >
          <Sparkles {...ICON} />
        </button>
        <form onSubmit={submit} className="cn-url-form">
          <label className="cn-url-field">
            <Link size={15} strokeWidth={1.75} aria-hidden />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste an image or video link…"
              aria-label="Image or video link"
            />
          </label>
          <button type="submit" className="cn-add-btn" disabled={!url.trim()}>
            <Plus size={16} strokeWidth={2} aria-hidden />
            Add
          </button>
        </form>
        <span className="cn-sep" />
        <button
          className="cn-icon-btn"
          onClick={() => undoManager.undo()}
          disabled={!canUndo}
          title={`Undo (${UNDO_KEYS})`}
          aria-label="Undo"
        >
          <Undo2 {...ICON} />
        </button>
        <button
          className="cn-icon-btn"
          onClick={() => undoManager.redo()}
          disabled={!canRedo}
          title={`Redo (${REDO_KEYS})`}
          aria-label="Redo"
        >
          <Redo2 {...ICON} />
        </button>
      </div>

      <div className="cn-corner">
        {settings.stats && (
          <div className="cn-status" aria-live="polite">
            <span className={fps < 50 ? "cn-warn" : undefined}>{fps} fps</span>
            <span>{objectCount} objects</span>
          </div>
        )}
        <ExportMenu />
        <SettingsMenu onStress={onStress} onClear={onClear} />
      </div>
    </>
  );
}
