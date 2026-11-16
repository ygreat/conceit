import { useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, FilePlus2, FolderOpen, FolderSearch, LayoutGrid, Pencil } from "lucide-react";
import { api, BOARD_FILTER, flushAll, goHome, newBoard, pickAndOpen, prettyPath, rememberRecent, setCurrent, useCurrent } from "./files";
import { setWindowTitle } from "./persist";

/** Native-menu commands that need this menu (rename, save a copy) arrive as window events. */
export const RENAME_EVENT = "conceit:rename";
export const SAVE_COPY_EVENT = "conceit:save-copy";

export async function revealBoard(path: string) {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/**
 * The open board's name (top left): rename, save a copy, show in Finder,
 * and move to another board. Also shows whether everything is saved.
 */
export function BoardMenu() {
  const { info, save, error } = useCurrent();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [withChats, setWithChats] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string; path?: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rename = () => startRename();
    const copy = () => {
      setOpen(true);
      setStatus(null);
    };
    window.addEventListener(RENAME_EVENT, rename);
    window.addEventListener(SAVE_COPY_EVENT, copy);
    return () => {
      window.removeEventListener(RENAME_EVENT, rename);
      window.removeEventListener(SAVE_COPY_EVENT, copy);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

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

  if (!info) return null;

  function startRename() {
    if (!info) return;
    setOpen(false);
    setName(info.title);
    setRenaming(true);
  }

  const commitRename = async () => {
    setRenaming(false);
    const title = name.trim();
    if (!title || title === info.title) return;
    try {
      await flushAll();
      const next = await api.rename(title);
      rememberRecent(next, info.path);
      setCurrent({ info: next });
      // A reload must open the file under its new name.
      window.history.replaceState(null, "", `${window.location.pathname}?board=${encodeURIComponent(next.path)}`);
      setWindowTitle(next.title);
    } catch (err) {
      setCurrent({ save: "error", error: String(err) });
    }
  };

  const saveCopy = async () => {
    setStatus(null);
    try {
      const { save: dialog } = await import("@tauri-apps/plugin-dialog");
      const folder = info.path.replace(/[\\/][^\\/]*$/, "");
      const dest = await dialog({ defaultPath: `${folder}/${info.title} copy.conceit`, filters: BOARD_FILTER });
      if (!dest) return;
      await flushAll();
      await api.saveCopy(dest, withChats);
      setStatus({ ok: true, text: `Saved ${dest.split(/[\\/]/).pop()}${withChats ? "" : " (without AI chats)"}`, path: dest });
    } catch (err) {
      setStatus({ ok: false, text: `Couldn't save a copy: ${err}` });
    }
  };

  const saveLabel = save === "saving" ? "Saving…" : save === "error" ? "Not saved, retrying" : "Saved";

  return (
    <div className="cn-boardmenu" ref={root}>
      {renaming ? (
        <input
          className="cn-boardmenu-rename"
          autoFocus
          value={name}
          aria-label="Board name"
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setName(info.title);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={`cn-boardmenu-btn${open ? " on" : ""}`}
          onClick={() => setOpen((o) => !o)}
          onDoubleClick={startRename}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`${info.path}\n${saveLabel}${error && save === "error" ? `: ${error}` : ""}`}
        >
          <span className={`cn-save-dot cn-save-${save}`} aria-label={saveLabel} />
          <span className="cn-boardmenu-title">{info.title}</span>
          <ChevronDown size={14} strokeWidth={2} aria-hidden />
        </button>
      )}
      {open && (
        <div className="cn-settings-panel cn-boardmenu-panel" role="menu" aria-label="Board">
          <div className="cn-boardmenu-where">
            <strong>{info.title}.conceit</strong>
            <span>{prettyPath(info.path)}</span>
            <span className={save === "error" ? "cn-warn" : undefined}>{save === "error" ? `Not saved: ${error ?? "retrying"}` : saveLabel}</span>
          </div>
          <MenuItem icon={<Pencil size={15} />} label="Rename…" onClick={startRename} />
          <MenuItem icon={<FolderSearch size={15} />} label="Show in Finder" onClick={() => revealBoard(info.path)} />
          <div className="cn-boardmenu-copy">
            <MenuItem icon={<Copy size={15} />} label="Save a copy…" hint="⇧⌘S" onClick={saveCopy} />
            <label className="cn-export-check">
              <input type="checkbox" checked={withChats} onChange={(e) => setWithChats(e.target.checked)} />
              Include AI chats
            </label>
            {status && (
              <p className={`cn-export-status${status.ok ? "" : " cn-warn"}`} role="status">
                {status.text}
                {status.path && (
                  <button type="button" className="cn-linkbtn" onClick={() => revealBoard(status.path!)}>
                    Show
                  </button>
                )}
              </p>
            )}
          </div>
          <hr />
          <MenuItem icon={<FilePlus2 size={15} />} label="New board" hint="⌘N" onClick={() => newBoard()} />
          <MenuItem icon={<FolderOpen size={15} />} label="Open…" hint="⌘O" onClick={() => pickAndOpen()} />
          <MenuItem icon={<LayoutGrid size={15} />} label="All boards" hint="⌘W" onClick={() => goHome()} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint?: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className="cn-boardmenu-item" onClick={onClick}>
      {icon}
      <span>{label}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  );
}
