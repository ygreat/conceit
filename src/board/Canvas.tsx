import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import {
  addObject,
  lineDefaults,
  newId,
  transact,
  undoManager,
  yEdges,
  addObjects,
  allObjects,
  clearBoard,
  deleteObjects,
  moveObjects,
  objectCount,
  observeObjects,
  type BoardObject,
  type ObjectData,
} from "./doc";
import { HEADER_H, RENAME_EVENT, fillSlot, nodeTypes as cardTypes } from "./nodes";
import { GhostNode } from "../ai/GhostNode";
import { BoardMenu } from "../files/BoardMenu";
import { dismissGhosts, isGhostId, moveGhost, selectGhosts, useProposal } from "../ai/proposals";
import { BrushPanel, DrawLayer, DrawingNode, DrawingStyleDock } from "./draw";
import { useExporting } from "./exporter";
import { layout, type LayoutItem, type LayoutKind } from "./layouts";
import { arrangeTargets } from "./ArrangeMenu";
import { asStep, getObject, patchObject, type DrawingData, type ImageData, type NoteData } from "./doc";

const nodeTypes = { ...cardTypes, drawing: DrawingNode, ghost: GhostNode };
import { edgeTypes, type LineEdgeType } from "./edges";
import { classifyUrl, fitImage, isUrl } from "./media";
import { importMedia, type ImportedMedia } from "./assets";
import { LineInspector } from "./LineInspector";
import { Toolbar } from "./Toolbar";
import { freeSpotNear } from "./placement";
import { AiPanel, type AiNote } from "../ai/AiPanel";
import { resolvedTheme, useSettings } from "../settings";

const VIDEO_W = 400;

const NOTE_TINTS = ["#fff4b8", "#ffd9e0", "#d7f0ff", "#dff5d8", "#efe3ff"]; // new notes get a random paper tint

/** A card's picture proportions as loaded (the card itself may have been reshaped). */
function naturalAspect(id: string): number | undefined {
  const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  const img = el?.querySelector<HTMLImageElement>(".cn-media-body img");
  if (img?.naturalWidth && img.naturalHeight) return img.naturalWidth / img.naturalHeight;
  const video = el?.querySelector("video");
  if (video?.videoWidth && video.videoHeight) return video.videoWidth / video.videoHeight;
  if (el?.querySelector(".cn-video-body iframe, .cn-video-body img")) return 16 / 9; // YouTube / Vimeo
  return undefined;
}

function toFlowNode(o: BoardObject, prev?: Node): Node {
  return {
    id: o.id,
    type: o.type,
    position: o.position,
    width: o.width,
    height: o.height,
    data: o.data as unknown as Record<string, unknown>,
    selected: prev?.selected,
    measured: prev?.measured,
  };
}

/** Rebuild the React Flow node list from Yjs, keeping local UI state (selection). */
function useBoardNodes() {
  const [nodes, setNodes] = useState<Node[]>([]);
  useEffect(() => {
    const sync = () =>
      setNodes((prev) => {
        const byId = new Map(prev.map((n) => [n.id, n]));
        return allObjects().map((o) => toFlowNode(o, byId.get(o.id)));
      });
    sync();
    return observeObjects(sync);
  }, []);
  return [nodes, setNodes] as const;
}

function useBoardEdges() {
  const [edges, setEdges] = useState<Edge[]>([]);
  useEffect(() => {
    const sync = () =>
      setEdges((prev) => {
        const byId = new Map(prev.map((e) => [e.id, e]));
        return Array.from(
          yEdges.values(),
          (e): LineEdgeType => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle,
            targetHandle: e.targetHandle,
            type: "line",
            data: { line: e.line, label: e.label },
            selected: byId.get(e.id)?.selected,
          }),
        );
      });
    sync();
    yEdges.observe(sync);
    return () => yEdges.unobserve(sync);
  }, []);
  return [edges, setEdges] as const;
}

export function Canvas() {
  const [nodes, setNodes] = useBoardNodes();
  const [edges, setEdges] = useBoardEdges();
  const { screenToFlowPosition, fitView, getNodes, getEdges, setCenter, getZoom } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [hadContentOnOpen] = useState(() => objectCount() > 0);
  const [drawMode, setDrawMode] = useState(false);
  const exporting = useExporting();
  const [aiOpen, setAiOpen] = useState(false);

  // --- local UI changes; persisted changes go to Yjs -----------------------

  // AI suggestions: ghost cards and lines shown beside the board's own, kept
  // in their own store until the user keeps them (src/ai/proposals.ts).
  const proposal = useProposal();
  const ghostNodes = useMemo<Node[]>(() => {
    if (!proposal) return [];
    const live = new Map(nodes.map((n) => [n.id, n]));
    const out: Node[] = [];
    for (const g of proposal.ghosts) {
      const base = { id: g.gid, type: "ghost", data: { ghost: g } };
      if (g.kind === "update" || g.kind === "delete") {
        // Overlay on the card itself; only its bar takes clicks.
        const n = live.get(g.target!);
        if (!n) continue;
        out.push({
          ...base,
          position: n.position,
          width: n.width ?? g.obj.width,
          height: n.height ?? g.obj.height,
          draggable: false,
          selectable: false,
          connectable: false,
          style: { pointerEvents: "none" },
          zIndex: 1000,
        });
        continue;
      }
      out.push({ ...base, position: g.obj.position, width: g.obj.width, height: g.obj.height, selected: proposal.selected.includes(g.gid), zIndex: 5 });
    }
    return out;
  }, [proposal, nodes]);
  const ghostEdges = useMemo<Edge[]>(() => {
    if (!proposal) return [];
    const line = (e: { gid: string; source: string; target: string; label?: string }, move = false): LineEdgeType => ({
      id: e.gid,
      source: e.source,
      target: e.target,
      sourceHandle: "r",
      targetHandle: "l",
      type: "line",
      selectable: false,
      className: move ? "cn-ghost-edge cn-ghost-edge--move" : "cn-ghost-edge",
      data: {
        line: move
          ? { color: "#9aa3b5", dash: "dotted", width: 1.5, path: "straight", start: "none", end: "arrow" }
          : { color: "#7c9cff", dash: "dashed", width: 2, path: "bezier", start: "none", end: "triangle" },
        label: e.label,
      },
    });
    const moves = proposal.ghosts
      .filter((g) => g.kind === "move" && !g.bundle)
      .map((g) => line({ gid: `${g.gid}:from`, source: g.target!, target: g.gid }, true));
    // While a card's move is previewed, its suggested lines attach to the new spot.
    const at = new Map(proposal.ghosts.filter((g) => g.kind === "move").map((g) => [g.target!, g.gid]));
    const to = (id: string) => at.get(id) ?? id;
    return [...proposal.edges.map((e) => line({ ...e, source: to(e.source), target: to(e.target) })), ...moves];
  }, [proposal]);
  const shownNodes = useMemo(() => {
    if (!ghostNodes.length) return nodes;
    // Cards a suggestion would move fade back, so the preview reads as the new layout.
    const moving = new Set(proposal!.ghosts.filter((g) => g.kind === "move").map((g) => g.target!));
    const base = moving.size ? nodes.map((n) => (moving.has(n.id) ? { ...n, className: `${n.className ?? ""} cn-moving-src`.trim() } : n)) : nodes;
    return [...base, ...ghostNodes];
  }, [nodes, ghostNodes, proposal]);
  const shownEdges = useMemo(() => (ghostEdges.length ? [...edges, ...ghostEdges] : edges), [edges, ghostEdges]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const ghost = changes.filter((c) => "id" in c && isGhostId(c.id));
      const board = ghost.length ? changes.filter((c) => !("id" in c && isGhostId(c.id))) : changes;
      if (ghost.length) {
        for (const c of ghost) if (c.type === "position" && c.position) moveGhost(c.id, c.position);
        const sel = ghost.filter((c) => c.type === "select").map((c) => ({ id: (c as { id: string }).id, selected: (c as { selected: boolean }).selected }));
        if (sel.length) selectGhosts(sel);
        const removed = ghost.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id);
        if (removed.length) dismissGhosts(removed);
      }
      if (!board.length) return;
      setNodes((nds) => applyNodeChanges(board, nds));
      deleteObjects(board.filter((c) => c.type === "remove").map((c) => c.id));
    },
    [setNodes],
  );

  const onEdgesChange = useCallback(
    (all: EdgeChange[]) => {
      const changes = all.filter((c) => !("id" in c && isGhostId(c.id)));
      if (!changes.length) return;
      setEdges((eds) => applyEdgeChanges(changes, eds));
      const removed = changes.filter((c) => c.type === "remove");
      if (removed.length) transact(() => removed.forEach((c) => yEdges.delete(c.id)));
    },
    [setEdges],
  );

  // Commit positions once per drag, not on every frame.
  const onNodeDragStop = useCallback((_e: unknown, _n: Node, dragged: Node[]) => {
    const real = dragged.filter((n) => !isGhostId(n.id));
    if (real.length) moveObjects(real.map((n) => ({ id: n.id, position: n.position })));
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (c.source === c.target || isGhostId(c.source) || isGhostId(c.target)) return;
    const id = newId();
    transact(() =>
      yEdges.set(id, {
        id,
        source: c.source,
        target: c.target,
        sourceHandle: c.sourceHandle,
        targetHandle: c.targetHandle,
        line: lineDefaults(),
      }),
    );
  }, []);

  // React Flow prevents default on pane mousedown, so focus would otherwise
  // stay in the link field or a note and swallow canvas shortcuts (⌘Z, Delete).
  const releaseFocus = useCallback(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el && el !== document.body) el.blur();
  }, []);

  // --- adding objects -------------------------------------------------------

  const viewportCenter = useCallback(() => {
    const r = wrapper.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }, [screenToFlowPosition]);

  const place = useCallback(
    (type: BoardObject["type"], data: ObjectData, w: number, h: number) => {
      const c = viewportCenter();
      addObject({ type, data, width: w, height: h, position: freeSpotNear(c, w, h) });
    },
    [viewportCenter],
  );

  const addNote = useCallback(
    (text = "") =>
      place(
        "note",
        { text, tint: NOTE_TINTS[Math.floor(Math.random() * NOTE_TINTS.length)] },
        220,
        160,
      ),
    [place],
  );

  const addFromUrl = useCallback(
    (url: string) => {
      const kind = classifyUrl(url);
      if (kind === "image") place("image", { url }, 280, 200);
      else if (kind === "video") place("video", { url }, 400, 262);
      else addNote(url); // Link cards with Open Graph previews come with the Rust fetcher (Phase 1).
    },
    [place, addNote],
  );

  const addColor = useCallback(() => {
    const hex =
      "#" +
      Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    place("color", { hex }, 230, 236);
  }, [place]);

  // --- AI answers land on the board as notes beside what they read --------

  const addAiNote = useCallback(
    (n: AiNote) => {
      const lines = n.text.split("\n").reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / 44)), 0);
      const w = 360, h = Math.min(640, Math.max(180, 64 + lines * 19));
      const at = n.bounds
        ? { x: n.bounds.x + n.bounds.w + 80 + w / 2, y: n.bounds.y + h / 2 }
        : viewportCenter();
      const position = freeSpotNear(at, w, h);
      addObject({
        type: "note",
        data: { text: n.text, title: n.title, tint: "#efe3ff", ai: { from: n.from, provider: n.provider } },
        width: w,
        height: h,
        position,
      });
      // Center it in the part of the canvas the AI panel doesn't cover.
      const zoom = Math.min(1, getZoom());
      setCenter(position.x + w / 2 + 200 / zoom, position.y + h / 2, { zoom, duration: 400 });
    },
    [viewportCenter, getZoom, setCenter],
  );

  // --- paste: URL → media, image → image card, text → note ----------------

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const dt = e.clipboardData;
      if (!dt) return;

      // A selected reference slot takes the pasted picture or image link.
      const sel = getNodes().filter((n) => n.selected);
      const slot = sel.length === 1 && sel[0].type === "image" ? getObject(sel[0].id) : undefined;
      const slotData = slot?.data as ImageData | undefined;
      if (slot && slotData?.find && !slotData.url && !slotData.asset) {
        const img = Array.from(dt.files).find((f) => f.type.startsWith("image/"));
        const link = dt.getData("text/plain").trim();
        if (img) {
          e.preventDefault();
          const reader = new FileReader();
          reader.onload = () => fillSlot(slot.id, String(reader.result));
          reader.readAsDataURL(img);
          return;
        }
        if (isUrl(link)) {
          e.preventDefault();
          fillSlot(slot.id, link);
          return;
        }
      }

      const file = Array.from(dt.files).find((f) => f.type.startsWith("image/"));
      if (file) {
        e.preventDefault();
        // Spike: inline as a data URL. Phase 1 stores assets content-addressed in .conceit.
        const reader = new FileReader();
        reader.onload = () => place("image", { url: String(reader.result) }, 280, 200);
        reader.readAsDataURL(file);
        return;
      }
      const text = dt.getData("text/plain").trim();
      if (!text) return;
      e.preventDefault();
      if (isUrl(text)) addFromUrl(text);
      else addNote(text);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFromUrl, addNote, place, getNodes]);

  // --- drag & drop local files ---------------------------------------------

  const [dropActive, setDropActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(t);
  }, [notice]);

  /** Lay dropped media out left-to-right from the drop point. */
  const placeImported = useCallback((items: ImportedMedia[], at: { x: number; y: number }) => {
    let x = at.x;
    for (const m of items) {
      let w: number, h: number;
      if (m.kind === "image") {
        // Rust's size is a first guess (it ignores photo rotation); the card
        // re-fits to the displayed image once it loads.
        const fit = fitImage(m.width ?? 320, m.height ?? 240);
        w = fit.width;
        h = fit.height + HEADER_H;
        addObject({ type: "image", data: { asset: m.asset, name: m.name }, width: w, height: h, position: { x, y: at.y } });
      } else {
        w = VIDEO_W;
        h = Math.round((w * 9) / 16) + HEADER_H; // refined on load from the real aspect ratio
        addObject({ type: "video", data: { asset: m.asset, name: m.name }, width: w, height: h, position: { x, y: at.y } });
      }
      x += w + 24;
    }
  }, []);

  const reportImport = useCallback((count: number, skipped: [string, string][]) => {
    const parts: string[] = [];
    if (count) parts.push(`Added ${count} file${count > 1 ? "s" : ""}`);
    if (skipped.length) {
      parts.push(
        `skipped ${skipped.length}: ` +
          skipped.slice(0, 3).map(([n, why]) => `${n} (${why})`).join(", ") +
          (skipped.length > 3 ? "…" : ""),
      );
    }
    if (parts.length) setNotice(parts.join(" · "));
  }, []);

  // Desktop app: Tauri delivers real file paths; Rust copies them into the asset store.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") setDropActive(true);
        else if (p.type === "leave") setDropActive(false);
        else if (p.type === "drop") {
          setDropActive(false);
          if (!p.paths.length) return;
          const scale = window.devicePixelRatio || 1;
          const at = screenToFlowPosition({ x: p.position.x / scale, y: p.position.y / scale });
          setNotice(`Importing ${p.paths.length} file${p.paths.length > 1 ? "s" : ""}…`);
          try {
            const res = await importMedia(p.paths);
            placeImported(res.imported, at);
            reportImport(res.imported.length, res.skipped);
          } catch (err) {
            setNotice(`Import failed: ${String(err)}`);
          }
        }
      })
      .then((fn) => (disposed ? fn() : (unlisten = fn)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [screenToFlowPosition, placeImported, reportImport]);

  // Plain browser (dev/testing only): images inline as data URLs, no asset store.
  const onBrowserDragOver = useCallback((e: DragEvent) => {
    if (isTauri() || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDropActive(true);
  }, []);
  const onBrowserDrop = useCallback(
    (e: DragEvent) => {
      if (isTauri()) return;
      e.preventDefault();
      setDropActive(false);
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const files = Array.from(e.dataTransfer.files);
      const images = files.filter((f) => f.type.startsWith("image/"));
      const skipped = files
        .filter((f) => !f.type.startsWith("image/"))
        .map((f): [string, string] => [f.name, "browser mode supports images only"]);
      let x = at.x;
      images.forEach((f) => {
        const w = 360, h = 240 + HEADER_H, px = x; // refits on load
        x += w + 24;
        const r = new FileReader();
        r.onload = () =>
          addObject({ type: "image", data: { url: String(r.result), name: f.name }, width: w, height: h, position: { x: px, y: at.y } });
        r.readAsDataURL(f);
      });
      reportImport(images.length, skipped);
    },
    [screenToFlowPosition, reportImport],
  );

  // --- keyboard: undo / redo, Enter to rename ------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setAiOpen((o) => !o);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "BUTTON")) return;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (plain && e.key.toLowerCase() === "p") {
        setDrawMode((d) => !d);
        return;
      }
      if (e.key === "Escape" && drawMode) {
        setDrawMode(false);
        return;
      }
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
        const sel = getNodes().filter((n) => n.selected);
        if (sel.length === 1) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent(RENAME_EVENT, { detail: sel[0].id }));
        }
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) undoManager.redo();
      else undoManager.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [getNodes, drawMode]);

  // --- arrange: automatic layouts -----------------------------------------

  const arrangeAnim = useRef(0);
  const arrange = useCallback(
    (kind: LayoutKind) => {
      const { ids } = arrangeTargets(getNodes());
      if (ids.length < 2) return;
      const items: LayoutItem[] = [];
      for (const id of ids) {
        const o = getObject(id);
        if (!o) continue;
        const media = o.type === "image" || o.type === "video";
        const contentH = o.height - HEADER_H;
        items.push({
          id,
          type: o.type,
          x: o.position.x,
          y: o.position.y,
          w: o.width,
          h: o.height,
          aspect: media ? (naturalAspect(id) ?? (contentH > 0 ? o.width / contentH : undefined)) : undefined,
          textLength: o.type === "note" ? (o.data as NoteData).text?.length ?? 0 : undefined,
        });
      }
      const targets = layout(kind, items, getEdges().map((e) => ({ source: e.source, target: e.target })));
      const from = new Map(items.map((i) => [i.id, i]));

      // Glide into place, then save once (one undo step) and frame the result.
      cancelAnimationFrame(arrangeAnim.current);
      const start = performance.now();
      const DURATION = 420;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / DURATION);
        const e = 1 - (1 - t) ** 3;
        setNodes((nds) =>
          nds.map((n) => {
            const a = from.get(n.id), b = targets.get(n.id);
            if (!a || !b) return n;
            return {
              ...n,
              position: { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e },
              width: a.w + (b.w - a.w) * e,
              height: a.h + (b.h - a.h) * e,
            };
          }),
        );
        if (t < 1) {
          arrangeAnim.current = requestAnimationFrame(step);
          return;
        }
        asStep(() =>
          transact(() => {
            for (const [id, r] of targets) {
              const media = from.get(id)?.aspect !== undefined;
              patchObject(id, {
                position: { x: r.x, y: r.y },
                width: r.w,
                height: r.h,
                // Keep a media card's new shape: don't re-fit it to the picture.
                ...(media ? { data: { sized: true } } : {}),
              });
            }
          }),
        );
        requestAnimationFrame(() =>
          fitView({ nodes: [...targets.keys()].map((id) => ({ id })), duration: 450, padding: 0.15, maxZoom: 1 }),
        );
      };
      arrangeAnim.current = requestAnimationFrame(step);
    },
    [getNodes, getEdges, setNodes, fitView],
  );

  // --- spike: stress test ---------------------------------------------------

  const stressTest = useCallback(
    (count: number) => {
      const cols = Math.ceil(Math.sqrt(count));
      const W = 220, H = 170, GAP = 40;
      const objs: BoardObject[] = [];
      for (let i = 0; i < count; i++) {
          const id = newId();
          const position = { x: (i % cols) * (W + GAP), y: Math.floor(i / cols) * (H + GAP) };
          const kind = i % 10;
          const obj: BoardObject =
            kind < 3
              ? { id, type: "image", position, width: W, height: H,
                  data: { url: `https://picsum.photos/seed/conceit${i}/440/340`, sized: true } }
              : kind < 5
                ? { id, type: "color", position, width: W, height: H,
                    data: { hex: `#${((i * 2654435761) >>> 8).toString(16).padStart(6, "0").slice(0, 6)}` } }
                : { id, type: "note", position, width: W, height: H,
                    data: { text: `Idea #${i + 1}`, tint: NOTE_TINTS[i % NOTE_TINTS.length] } };
          objs.push(obj);
      }
      addObjects(objs);
      requestAnimationFrame(() => fitView({ duration: 300, maxZoom: 1 }));
    },
    [fitView],
  );

  const onClear = useCallback(() => {
    if (objectCount()) clearBoard();
  }, []);

  const settings = useSettings();
  const selectedEdgeIds = edges.filter((e) => e.selected && !isGhostId(e.id)).map((e) => e.id);
  const selectedDrawings = nodes
    .filter((n) => n.selected && n.type === "drawing")
    .map((n) => ({ id: n.id, data: n.data as unknown as DrawingData }));
  const defaults = lineDefaults();

  return (
    <div
      className={`cn-canvas${exporting ? " cn-exporting" : ""}${drawMode ? " cn-drawing-mode" : ""}${aiOpen ? " cn-ai-open" : ""}`}
      ref={wrapper}
      onDragOver={onBrowserDragOver}
      onDragLeave={() => !isTauri() && setDropActive(false)}
      onDrop={onBrowserDrop}
    >
      <ReactFlow
        nodes={shownNodes}
        edges={shownEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionLineStyle={{ stroke: defaults.color, strokeWidth: defaults.width }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onPaneClick={releaseFocus}
        onMoveStart={releaseFocus}
        connectionMode={ConnectionMode.Loose}
        // All objects render while exporting, so off-screen ones are included.
        onlyRenderVisibleElements={!exporting}
        minZoom={0.05}
        maxZoom={4}
        panOnScroll
        zoomOnPinch
        selectionOnDrag
        // A card is selected as soon as the selection box touches any part of it.
        selectionMode={SelectionMode.Partial}
        colorMode={settings.theme}
        snapToGrid={settings.snap}
        snapGrid={[16, 16]}
        panOnDrag={[1, 2]}
        deleteKeyCode={["Backspace", "Delete"]}
        multiSelectionKeyCode="Shift"
        // Fit only when opening a board that has content. On an empty board,
        // React Flow would otherwise zoom to max on the first object added.
        fitView={hadContentOnOpen}
        fitViewOptions={{ maxZoom: 1, padding: 0.15 }}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      >
        {settings.grid && <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />}
        <Controls showInteractive={false} />
        {settings.minimap && (
          <MiniMap
            pannable
            zoomable
            nodeStrokeWidth={3}
            maskColor={resolvedTheme(settings.theme) === "dark" ? "rgb(0 0 0 / 0.55)" : undefined}
          />
        )}
        {drawMode && <DrawLayer />}
      </ReactFlow>
      <Toolbar
        objectCount={nodes.length}
        onAddNote={() => addNote()}
        onAddColor={addColor}
        onAddUrl={addFromUrl}
        onStress={stressTest}
        onClear={onClear}
        drawMode={drawMode}
        onToggleDraw={() => setDrawMode((d) => !d)}
        onArrange={arrange}
        aiOpen={aiOpen}
        onToggleAi={() => setAiOpen((o) => !o)}
      />
      <BoardMenu />
      <AiPanel open={aiOpen} onClose={() => setAiOpen(false)} onAddNote={addAiNote} />
      {drawMode && <BrushPanel />}
      {selectedEdgeIds.length > 0 && <LineInspector ids={selectedEdgeIds} />}
      {!drawMode && selectedEdgeIds.length === 0 && selectedDrawings.length > 0 && (
        <DrawingStyleDock drawings={selectedDrawings} />
      )}
      {dropActive && (
        <div className="cn-drop-overlay" aria-hidden="true">
          <span>Drop images or videos to add them</span>
        </div>
      )}
      {notice && (
        <div className="cn-notice" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}
