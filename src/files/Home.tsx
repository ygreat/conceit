import { useEffect, useId, useState } from "react";
import { FilePlus2, FolderOpen, FolderSearch, X } from "lucide-react";
import { assetUrl } from "../board/assets";
import { ago, api, forgetRecent, newBoard, openBoard, pickAndOpen, prettyPath, recents, type Peek } from "./files";
import type { Preview } from "./persist";
import { revealBoard } from "./BoardMenu";

type Row = { path: string; title: string; peek?: Peek; gone?: string };

/** All boards: recent files with previews, plus New and Open. */
export function Home({ error }: { error?: string }) {
  const [rows, setRows] = useState<Row[]>(() => recents().map((r) => ({ path: r.path, title: r.title })));
  const [dir, setDir] = useState("");

  useEffect(() => {
    document.title = "Conceit";
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle("Conceit")).catch(() => {});
    api.defaultDir().then(setDir).catch(() => {});
    const list = recents();
    if (!list.length) return;
    api
      .peek(list.map((r) => r.path))
      .then((res) =>
        setRows(list.map((r, i) => {
          const x = res[i];
          return "Ok" in x ? { path: r.path, title: x.Ok.title, peek: x.Ok } : { path: r.path, title: r.title, gone: x.Err };
        })),
      )
      .catch(() => {});
  }, []);

  const remove = (path: string) => {
    forgetRecent(path);
    setRows((rs) => rs.filter((r) => r.path !== path));
  };

  return (
    <main className="cn-home">
      <header className="cn-home-head">
        <div className="cn-home-brand">
          <img src="/conceit-icon.png" alt="" width={36} height={36} />
          <h1>Boards</h1>
        </div>
        <div className="cn-home-actions">
          <button type="button" className="cn-add-btn" onClick={() => newBoard()}>
            <FilePlus2 size={16} strokeWidth={2} aria-hidden /> New board
          </button>
          <button type="button" className="cn-home-secondary" onClick={() => pickAndOpen()}>
            <FolderOpen size={16} strokeWidth={1.75} aria-hidden /> Open…
          </button>
        </div>
      </header>

      {error && (
        <p className="cn-home-error" role="alert">
          {error}
        </p>
      )}

      {rows.length === 0 ? (
        <div className="cn-home-empty">
          <h2>Start your first board</h2>
          <p>Each board is one <code>.conceit</code> file. It saves as you work, and holds its pictures, videos and AI chats, so you can move it, back it up or send it as a single file.</p>
          <button type="button" className="cn-add-btn" onClick={() => newBoard()}>
            <FilePlus2 size={16} strokeWidth={2} aria-hidden /> New board
          </button>
        </div>
      ) : (
        <>
          <h2 className="cn-home-section">Recent</h2>
          <ul className="cn-home-grid">
            {rows.map((r) => (
              <li key={r.path} className={r.gone ? "gone" : undefined}>
                <button type="button" className="cn-home-card" disabled={!!r.gone} onClick={() => openBoard(r.path)} title={r.path}>
                  <div className="cn-home-thumb">{r.peek ? <Thumb preview={r.peek.preview} /> : null}</div>
                  <div className="cn-home-meta">
                    <strong>{r.title}</strong>
                    <span>{r.gone ? "Can't find this file" : `${ago(r.peek?.updated ?? 0)} · ${prettyPath(r.path)}`}</span>
                  </div>
                </button>
                <div className="cn-home-card-actions">
                  {!r.gone && (
                    <button type="button" title="Show in Finder" aria-label="Show in Finder" onClick={() => revealBoard(r.path)}>
                      <FolderSearch size={14} aria-hidden />
                    </button>
                  )}
                  <button type="button" title="Remove from this list (the file stays)" aria-label="Remove from list" onClick={() => remove(r.path)}>
                    <X size={14} aria-hidden />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {dir && (
        <p className="cn-home-foot">
          New boards are saved in{" "}
          <button type="button" className="cn-linkbtn" onClick={() => revealBoard(dir)}>
            {prettyPath(`${dir}/x`)}
          </button>
        </p>
      )}
    </main>
  );
}

/** A board in miniature: cards as rectangles, local pictures drawn in. */
function Thumb({ preview }: { preview: string | null }) {
  const uid = useId().replace(/:/g, "");
  let p: Preview | null = null;
  try {
    p = preview ? (JSON.parse(preview) as Preview) : null;
  } catch {
    p = null;
  }
  if (!p || !p.items.length) return <span className="cn-home-blank">Empty board</span>;
  const pad = Math.max(p.w, p.h) * 0.04;
  return (
    <svg viewBox={`${-pad} ${-pad} ${p.w + pad * 2} ${p.h + pad * 2}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      {p.items.map(([x, y, w, h, fill, asset], i) => {
        const src = asset ? assetUrl(asset) : undefined;
        const r = Math.min(10, w / 8, h / 8);
        return src ? (
          <g key={i}>
            <clipPath id={`${uid}c${i}`}>
              <rect x={x} y={y} width={w} height={h} rx={r} />
            </clipPath>
            <rect x={x} y={y} width={w} height={h} rx={r} fill={fill} />
            <image href={src} x={x} y={y} width={w} height={h} preserveAspectRatio="xMidYMid slice" clipPath={`url(#${uid}c${i})`} />
          </g>
        ) : (
          <rect key={i} x={x} y={y} width={w} height={h} rx={r} fill={fill} />
        );
      })}
    </svg>
  );
}
