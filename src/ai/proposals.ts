import { useSyncExternalStore } from "react";
import { applyChanges, getObject, lineDefaults, newId, yEdges, type BoardEdge, type BoardObject, type ColorData, type ImageData, type NoteData, type ObjectData } from "../board/doc";
import { freeSpotNear, type Rect } from "../board/placement";

/**
 * AI suggestions as "ghosts" (PRD §5.1 "Suggest, don't overwrite").
 *
 * The model ends an answer with a ```conceit block holding a small JSON plan:
 * new cards (notes, palettes, reference slots), and changes to cards already
 * on the board (move, group, rename/recolor, delete), plus lines. It is
 * parsed here, laid out by the app (the model never gives coordinates), and
 * previewed on the canvas. Nothing touches the board until the user keeps a
 * suggestion; applying them is one undo step. Deletions are never part of
 * "apply all": they need their own confirmation.
 */

// ---------------------------------------------------------------- Plan (what the model writes)

type Ref = number | string; // number = existing card #n, string = id of a new item

interface PlanNote { type: "note"; id?: string; title?: string; text: string; near?: Ref }
interface PlanPalette { type: "palette"; id?: string; title?: string; colors: ({ hex: string; name?: string } | string)[]; near?: Ref }
interface PlanReference { type: "reference"; id?: string; title: string; find: string; why?: string; near?: Ref }
type PlanItem = PlanNote | PlanPalette | PlanReference;

export interface Plan {
  add?: PlanItem[];
  connect?: { from: Ref; to: Ref; label?: string }[];
  group?: { label: string; note?: string; cards: Ref[]; tint?: string }[];
  move?: { card: Ref; near: Ref }[];
  update?: { card: Ref; title?: string; tint?: string }[];
  delete?: { card: Ref; why?: string }[];
}

const FENCE = /```conceit[^\n]*\n([\s\S]*?)(```|$)/;

/** The answer text without the plan block (also hides a block still streaming in). */
export function stripPlan(text: string): { text: string; planning: boolean } {
  const m = FENCE.exec(text);
  if (!m) return { text, planning: false };
  return { text: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(), planning: m[2] !== "```" };
}

/** The plan in a finished answer, if any. */
export function parsePlan(text: string): Plan | null {
  const m = FENCE.exec(text);
  if (!m || m[2] !== "```") return null;
  try {
    const raw = JSON.parse(m[1]) as Plan;
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
function normHex(h: unknown): string | null {
  if (typeof h !== "string") return null;
  const m = HEX.exec(h.trim());
  if (!m) return null;
  const v = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return `#${v.toLowerCase()}`;
}
const str = (v: unknown, max = 2000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const list = <T,>(v: T[] | undefined, max: number): T[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object").slice(0, max) : []);

// ---------------------------------------------------------------- Ghosts

export type GhostKind = "add" | "move" | "update" | "delete";

export interface Ghost {
  gid: string;
  kind: GhostKind;
  /** add: the new card. move: the card at its new place. update/delete: the card as it is. */
  obj: Omit<BoardObject, "id">;
  /** The existing card (move, update, delete). */
  target?: string;
  /** move: where the card was, to skip the move if the user moved it since. */
  from?: { x: number; y: number };
  /** Field edits applied on keep (update, or a group's tint on a move). */
  patch?: { title?: string; tint?: string };
  why?: string;
  /** Kept or dismissed together: a palette, or a group's label and moves. */
  bundle?: string;
  /** The bundle member that shows the Keep / Dismiss bar. */
  lead?: boolean;
  /** Short label for the bar and the chat summary. */
  label: string;
}

export interface GhostEdge {
  gid: string;
  /** Real card id, or a ghost's gid. */
  source: string;
  target: string;
  label?: string;
}

export interface Proposal {
  /** The chat message it came from. */
  id: string;
  ghosts: Ghost[];
  edges: GhostEdge[];
  kept: number;
  dismissed: number;
  /** Suggestions dropped because their card changed or disappeared. */
  skipped: number;
  /** Selected ghost ids (React Flow selection for ghosts lives here). */
  selected: string[];
}

export const GHOST_PREFIX = "ghost:";
export const isGhostId = (id: string) => id.startsWith(GHOST_PREFIX);

const SIZE = { note: 260, color: { w: 200, h: 200 }, reference: { w: 280, h: 230 } };
const GAP = 24;

function noteHeight(text: string) {
  // ~30 characters per line at 260 px; header + padding ≈ 64 px.
  const lines = text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 30)), 0);
  return Math.min(460, Math.max(110, 64 + lines * 20));
}

const cardLabel = (o: BoardObject) =>
  (o.data as { title?: string }).title || (o.type === "note" ? (o.data as NoteData).text?.slice(0, 30) : undefined) || o.type;

interface Built {
  ghosts: Ghost[];
  edges: GhostEdge[];
}

export interface PlanContext {
  /** `ids[n-1]` is card #n in the context the model read. */
  ids: string[];
  bounds: Rect | null;
}

/**
 * Turn a plan into placed ghosts. `anchor` is the top-left for new cards when
 * nothing says where they go.
 */
export function buildGhosts(plan: Plan, ctx: PlanContext, anchor: { x: number; y: number }, provider?: string): Built {
  const ai = { from: ctx.ids, provider };
  const ghosts: Ghost[] = [];
  const byRef = new Map<string, string>(); // plan id → ghost gid
  const nearOf = new Map<string, Ref>(); // gid → "near"
  const gid = () => `${GHOST_PREFIX}${newId()}`;

  const existing = (r: unknown): string | undefined => {
    if (typeof r !== "number" && !(typeof r === "string" && /^#?\d+$/.test(r))) return undefined;
    const id = ctx.ids[Number(String(r).replace("#", "")) - 1];
    return id && getObject(id) ? id : undefined;
  };
  const resolve = (r: Ref): string | undefined => existing(r) ?? byRef.get(String(r));

  // --- new cards
  let n = 0;
  for (const item of list(plan.add, 24)) {
    const ref = str(item.id) ?? `item${++n}`;
    if (item.type === "note" && str(item.text)) {
      const text = str(item.text)!;
      const g: Ghost = {
        gid: gid(), kind: "add", label: str(item.title, 60) ?? text.slice(0, 40),
        obj: { type: "note", position: { x: 0, y: 0 }, width: SIZE.note, height: noteHeight(text), data: { text, title: str(item.title, 80), tint: "#efe3ff", ai } as NoteData },
      };
      ghosts.push(g);
      byRef.set(ref, g.gid);
      if (item.near !== undefined) nearOf.set(g.gid, item.near);
    } else if (item.type === "palette" && Array.isArray(item.colors)) {
      const bundle = gid();
      let first: string | undefined;
      for (const c of item.colors.slice(0, 10)) {
        const hex = normHex(typeof c === "string" ? c : c?.hex);
        if (!hex) continue;
        const g: Ghost = {
          gid: gid(), kind: "add", bundle, lead: !first, label: str(item.title, 60) ?? "Palette",
          obj: { type: "color", position: { x: 0, y: 0 }, width: SIZE.color.w, height: SIZE.color.h, data: { hex, title: typeof c === "string" ? undefined : str(c.name, 60), ai } as ColorData },
        };
        ghosts.push(g);
        first ??= g.gid;
      }
      if (first) {
        byRef.set(ref, first);
        if (item.near !== undefined) nearOf.set(first, item.near);
      }
    } else if (item.type === "reference" && str(item.find)) {
      const g: Ghost = {
        gid: gid(), kind: "add", label: str(item.title, 60) ?? str(item.find, 60)!,
        obj: { type: "image", position: { x: 0, y: 0 }, width: SIZE.reference.w, height: SIZE.reference.h, data: { title: str(item.title, 80), find: str(item.find, 200), why: str(item.why, 200), sized: true, ai } as ImageData },
      };
      ghosts.push(g);
      byRef.set(ref, g.gid);
      if (item.near !== undefined) nearOf.set(g.gid, item.near);
    }
  }

  // --- changes to existing cards (each card gets at most one change)
  const touched = new Map<string, Ghost>(); // card id → its ghost
  const groups: { lead: Ghost; members: Ghost[] }[] = [];
  for (const grp of list(plan.group, 8)) {
    const ids = [...new Set(Array.isArray(grp.cards) ? grp.cards.slice(0, 60).map(existing) : [])].filter(
      (id): id is string => !!id && !touched.has(id),
    );
    if (!ids.length || !str(grp.label)) continue;
    const bundle = gid();
    const label = str(grp.label, 60)!;
    const text = str(grp.note, 300) ?? label;
    const lead: Ghost = {
      gid: gid(), kind: "add", bundle, lead: true, label,
      obj: { type: "note", position: { x: 0, y: 0 }, width: SIZE.note, height: noteHeight(text), data: { text, title: label, tint: normHex(grp.tint) ?? "#efe3ff", ai } as NoteData },
    };
    const tint = normHex(grp.tint) ?? undefined;
    const members = ids.map((id) => {
      const o = getObject(id)!;
      const g: Ghost = { gid: gid(), kind: "move", bundle, target: id, from: o.position, label: cardLabel(o), obj: { ...o, position: o.position }, patch: tint ? { tint } : undefined };
      touched.set(id, g);
      return g;
    });
    ghosts.push(lead, ...members);
    groups.push({ lead, members });
  }
  const moves: Ghost[] = [];
  for (const mv of list(plan.move, 40)) {
    const id = existing(mv.card);
    if (!id || touched.has(id) || mv.near === undefined) continue;
    const o = getObject(id)!;
    const g: Ghost = { gid: gid(), kind: "move", target: id, from: o.position, label: cardLabel(o), obj: { ...o } };
    touched.set(id, g);
    nearOf.set(g.gid, mv.near);
    ghosts.push(g);
    moves.push(g);
  }
  for (const up of list(plan.update, 40)) {
    const id = existing(up.card);
    if (!id) continue;
    const patch = { title: str(up.title, 80), tint: normHex(up.tint) ?? undefined };
    if (!patch.title && !patch.tint) continue;
    const prev = touched.get(id);
    if (prev) {
      if (prev.kind !== "delete") prev.patch = { ...prev.patch, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v)) };
      continue;
    }
    const o = getObject(id)!;
    const g: Ghost = { gid: gid(), kind: "update", target: id, label: cardLabel(o), obj: { ...o }, patch };
    touched.set(id, g);
    ghosts.push(g);
  }
  for (const del of list(plan.delete, 40)) {
    const id = existing(del.card);
    if (!id || touched.has(id)) continue;
    const o = getObject(id)!;
    const g: Ghost = { gid: gid(), kind: "delete", target: id, label: cardLabel(o), obj: { ...o }, why: str(del.why, 200) };
    touched.set(id, g);
    ghosts.push(g);
  }

  // --- lines (not to cards about to be deleted, no duplicates of existing lines)
  const deleting = new Set(ghosts.filter((g) => g.kind === "delete").map((g) => g.target!));
  const existingPairs = new Set(Array.from(yEdges.values(), (e) => `${e.source}>${e.target}`));
  const edges: GhostEdge[] = [];
  for (const c of list(plan.connect, 30)) {
    const source = resolve(c.from), target = resolve(c.to);
    if (!source || !target || source === target || deleting.has(source) || deleting.has(target)) continue;
    if (existingPairs.has(`${source}>${target}`) || existingPairs.has(`${target}>${source}`)) continue;
    edges.push({ gid: gid(), source, target, label: str(c.label, 40) });
  }

  place(ghosts, groups, moves, nearOf, resolve, anchor, ctx.bounds, new Set(ghosts.filter((g) => g.kind === "move").map((g) => g.target!)));
  return { ghosts, edges };
}

/**
 * Layout, in order: group blocks where the scope is; new cards as a cluster
 * (palette row on top, then a 3-column masonry); then everything placed
 * "near" a card. Cards being moved don't count as obstacles.
 */
function place(
  ghosts: Ghost[],
  groups: { lead: Ghost; members: Ghost[] }[],
  moves: Ghost[],
  nearOf: Map<string, Ref>,
  resolve: (r: Ref) => string | undefined,
  anchor: { x: number; y: number },
  bounds: Rect | null,
  moving: Set<string>,
) {
  const placed: Rect[] = [];
  const set = (g: Ghost, x: number, y: number) => {
    g.obj = { ...g.obj, position: { x: Math.round(x), y: Math.round(y) } };
    placed.push({ x, y, w: g.obj.width, h: g.obj.height });
  };
  const putBlock = (items: { g: Ghost; x: number; y: number }[], center: { x: number; y: number }) => {
    if (!items.length) return;
    const w = Math.max(...items.map((l) => l.x + l.g.obj.width));
    const h = Math.max(...items.map((l) => l.y + l.g.obj.height));
    const spot = freeSpotNear({ x: center.x + w / 2, y: center.y + h / 2 }, w, h, placed, moving);
    for (const l of items) set(l.g, spot.x + l.x, spot.y + l.y);
  };

  // 1) Groups: label note on top, cards in rows under it; blocks side by side.
  if (groups.length) {
    const blocks: { g: Ghost; x: number; y: number }[] = [];
    let bx = 0;
    for (const { lead, members } of groups) {
      const maxRow = Math.max(820, Math.ceil(Math.sqrt(members.length)) * 300);
      const items = [{ g: lead, x: 0, y: 0 }];
      let x = 0, y = lead.obj.height + GAP, rowH = 0, blockW = lead.obj.width;
      for (const m of members) {
        if (x > 0 && x + m.obj.width > maxRow) {
          x = 0;
          y += rowH + GAP;
          rowH = 0;
        }
        items.push({ g: m, x, y });
        x += m.obj.width + GAP;
        rowH = Math.max(rowH, m.obj.height);
        blockW = Math.max(blockW, x - GAP);
      }
      for (const it of items) blocks.push({ g: it.g, x: bx + it.x, y: it.y });
      bx += blockW + GAP * 4;
    }
    putBlock(blocks, bounds ? { x: bounds.x, y: bounds.y } : anchor);
  }

  // 2) New cards not anchored to an existing card.
  const lead = (g: Ghost) => (g.bundle ? ghosts.find((x) => x.bundle === g.bundle && x.lead) ?? g : g);
  const nearExisting = (g: Ghost) => {
    const r = nearOf.get(lead(g).gid);
    const id = r === undefined ? undefined : resolve(r);
    return id && !isGhostId(id) ? id : undefined;
  };
  const inGroup = new Set(groups.flatMap((gr) => [gr.lead.gid, ...gr.members.map((m) => m.gid)]));
  const adds = ghosts.filter((g) => g.kind === "add" && !inGroup.has(g.gid));
  const clustered = adds.filter((g) => !nearExisting(g));
  const local: { g: Ghost; x: number; y: number }[] = [];
  let y = 0, x = 0;
  let lastBundle: string | undefined;
  for (const g of clustered.filter((g) => g.obj.type === "color")) {
    if (lastBundle && g.bundle !== lastBundle) {
      x = 0;
      y += SIZE.color.h + GAP;
    }
    local.push({ g, x, y });
    x += g.obj.width + 12;
    lastBundle = g.bundle;
  }
  if (local.length) y += SIZE.color.h + GAP * 1.5;
  const colY = [y, y, y];
  const rest = clustered.filter((g) => g.obj.type !== "color").sort((a, b) => Number(b.obj.type === "note") - Number(a.obj.type === "note"));
  for (const g of rest) {
    const c = colY.indexOf(Math.min(...colY));
    local.push({ g, x: c * (SIZE.reference.w + GAP), y: colY[c] });
    colY[c] += g.obj.height + GAP;
  }
  putBlock(local, anchor);

  // 3) Beside a card: new cards (palettes as a row) and explicit moves.
  const done = new Set<string>(groups.flatMap((gr) => gr.members.map((m) => m.gid)));
  const beside = (members: Ghost[], targetId: string) => {
    // A card that is itself moving counts at its new place (once placed).
    const g = ghosts.find((x) => x.gid === targetId || (x.kind === "move" && x.target === targetId && done.has(x.gid)));
    const t = getObject(targetId);
    const tr = g ? { x: g.obj.position.x, y: g.obj.position.y, w: g.obj.width } : { x: t!.position.x, y: t!.position.y, w: t!.width };
    const w = members.reduce((s, m) => s + m.obj.width, 0) + 12 * (members.length - 1);
    const h = Math.max(...members.map((m) => m.obj.height));
    const spot = freeSpotNear({ x: tr.x + tr.w + GAP + w / 2, y: tr.y + h / 2 }, w, h, placed, moving);
    let mx = spot.x;
    for (const m of members) {
      set(m, mx, spot.y);
      mx += m.obj.width + 12;
      done.add(m.gid);
    }
  };
  for (const g of adds.filter((g) => nearExisting(g))) {
    if (done.has(g.gid)) continue;
    beside(g.bundle ? adds.filter((x) => x.bundle === g.bundle) : [g], nearExisting(g)!);
  }
  for (const g of moves) {
    const r = nearOf.get(g.gid);
    const id = r === undefined ? undefined : resolve(r);
    if (id && id !== g.target) beside([g], id);
  }
}

// ---------------------------------------------------------------- Store

let current: Proposal | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function getProposal(): Proposal | null {
  return current;
}

export function useProposal(): Proposal | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getProposal,
  );
}

/** Show a new set of suggestions (replaces any still on the canvas). */
export function showProposal(id: string, built: Built) {
  current = { id, ghosts: built.ghosts, edges: built.edges, kept: 0, dismissed: 0, skipped: 0, selected: [] };
  emit();
}

function update(fn: (p: Proposal) => Proposal) {
  if (!current) return;
  current = fn(current);
  emit();
}

export function moveGhost(gid: string, position: { x: number; y: number }) {
  update((p) => ({ ...p, ghosts: p.ghosts.map((g) => (g.gid === gid ? { ...g, obj: { ...g.obj, position } } : g)) }));
}

export function selectGhosts(changes: { id: string; selected: boolean }[]) {
  update((p) => {
    const sel = new Set(p.selected);
    for (const c of changes) c.selected ? sel.add(c.id) : sel.delete(c.id);
    return { ...p, selected: [...sel] };
  });
}

/** The ghosts and, for bundles (palette, group), the whole bundle. */
function expand(p: Proposal, gids: string[]): Set<string> {
  const out = new Set<string>();
  for (const id of gids) {
    const g = p.ghosts.find((x) => x.gid === id);
    if (!g) continue;
    if (g.bundle) p.ghosts.filter((x) => x.bundle === g.bundle).forEach((x) => out.add(x.gid));
    else out.add(g.gid);
  }
  return out;
}

const samePlace = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

/**
 * Apply suggestions (one undo step). Without `gids`, applies everything except
 * deletions. Lines go in once both of their ends are real cards.
 */
export function keepGhosts(gids?: string[]) {
  const p = current;
  if (!p) return;
  const keep = gids ? expand(p, gids) : new Set(p.ghosts.filter((g) => g.kind !== "delete").map((g) => g.gid));
  if (!keep.size) return;

  const realId = new Map<string, string>();
  const add: BoardObject[] = [];
  const moves: { id: string; position: { x: number; y: number } }[] = [];
  const patches: { id: string; data: Partial<ObjectData> }[] = [];
  const deletes: string[] = [];
  let skipped = 0, applied = 0;
  for (const g of p.ghosts) {
    if (!keep.has(g.gid)) continue;
    if (g.kind === "add") {
      const id = newId();
      realId.set(g.gid, id);
      add.push({ ...g.obj, id });
      applied++;
      continue;
    }
    const cur = getObject(g.target!);
    // The card is gone, or the user moved it since: the suggestion is stale.
    if (!cur || (g.kind === "move" && g.from && !samePlace(cur.position, g.from))) {
      skipped++;
      continue;
    }
    applied++;
    if (g.kind === "move") moves.push({ id: g.target!, position: g.obj.position });
    if ((g.kind === "move" || g.kind === "update") && g.patch) {
      const data = Object.fromEntries(Object.entries(g.patch).filter(([, v]) => v)) as Partial<ObjectData>;
      if (Object.keys(data).length) patches.push({ id: g.target!, data });
    }
    if (g.kind === "delete") deletes.push(g.target!);
  }

  const deleted = new Set(deletes);
  const real = (id: string) => (isGhostId(id) ? realId.get(id) : deleted.has(id) ? undefined : id);
  const style = lineDefaults();
  const edges: BoardEdge[] = [];
  const keptEdges = new Set<string>();
  for (const e of p.edges) {
    const s = real(e.source), t = real(e.target);
    if (!s || !t) continue;
    // "Keep all" takes every line; a single keep only lines touching what it kept.
    if (gids && !keep.has(e.source) && !keep.has(e.target)) continue;
    keptEdges.add(e.gid);
    edges.push({ id: newId(), source: s, target: t, sourceHandle: "r", targetHandle: "l", line: style, label: e.label });
  }
  applyChanges({ add, edges, moves, patches, deletes });
  applied += edges.length;

  const remaining = p.ghosts.filter((g) => !keep.has(g.gid));
  const next: Proposal = {
    ...p,
    ghosts: remaining,
    edges: p.edges
      .filter((e) => !keptEdges.has(e.gid) && !deleted.has(e.source) && !deleted.has(e.target))
      .map((e) => ({ ...e, source: realId.get(e.source) ?? e.source, target: realId.get(e.target) ?? e.target })),
    kept: p.kept + applied,
    skipped: p.skipped + skipped,
    selected: p.selected.filter((s) => !keep.has(s)),
  };
  finish(next);
}

export function dismissGhosts(gids?: string[]) {
  const p = current;
  if (!p) return;
  const drop = gids ? expand(p, gids) : new Set(p.ghosts.map((g) => g.gid));
  const remaining = p.ghosts.filter((g) => !drop.has(g.gid));
  finish({
    ...p,
    ghosts: remaining,
    edges: gids ? p.edges.filter((e) => !drop.has(e.source) && !drop.has(e.target)) : [],
    dismissed: p.dismissed + (p.ghosts.length - remaining.length),
    selected: p.selected.filter((s) => !drop.has(s)),
  });
}

/** Lines between existing cards have no card of their own: they go with "keep all". */
function finish(next: Proposal) {
  const open = next.ghosts.length + next.edges.length;
  current = open ? next : null;
  lastResult = { id: next.id, kept: next.kept, dismissed: next.dismissed, skipped: next.skipped, open: next.ghosts.length, edges: next.edges.length };
  emit();
}

/** Pending deletions (shown separately: they need their own confirmation). */
export function pendingDeletes(p: Proposal | null): Ghost[] {
  return p ? p.ghosts.filter((g) => g.kind === "delete") : [];
}

export function confirmDeletes() {
  const p = current;
  if (p) keepGhosts(pendingDeletes(p).map((g) => g.gid));
}

let lastResult: { id: string; kept: number; dismissed: number; skipped: number; open: number; edges: number } | null = null;
/** Counts for the chat card. */
export function resultFor(id: string) {
  if (current?.id === id) {
    return { kept: current.kept, dismissed: current.dismissed, skipped: current.skipped, open: current.ghosts.length, edges: current.edges.length };
  }
  return lastResult?.id === id ? lastResult : null;
}

/** Plain-language summary of a set of suggestions. */
export function describe(ghosts: Ghost[], edges: GhostEdge[] = []): string {
  const count = (k: GhostKind, t?: string) => ghosts.filter((g) => g.kind === k && (!t || g.obj.type === t)).length;
  const bundles = new Map<string, Ghost[]>();
  for (const g of ghosts) if (g.bundle) bundles.set(g.bundle, [...(bundles.get(g.bundle) ?? []), g]);
  const palettes = [...bundles.values()].filter((b) => b[0].obj.type === "color" && b.every((g) => g.kind === "add"));
  const groups = [...bundles.values()].filter((b) => b.some((g) => g.kind === "move"));
  const groupNotes = groups.length;
  const parts: string[] = [];
  const notes = count("add", "note") - groupNotes;
  const refs = count("add", "image");
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (notes > 0) parts.push(plural(notes, "note"));
  for (const p of palettes) parts.push(`palette of ${p.length}`);
  if (refs) parts.push(`${plural(refs, "reference")} to find`);
  if (groups.length) parts.push(`${plural(groups.length, "group")} (${groups.reduce((s, b) => s + b.filter((g) => g.kind === "move").length, 0)} cards)`);
  const loose = ghosts.filter((g) => g.kind === "move" && !g.bundle).length;
  if (loose) parts.push(plural(loose, "move"));
  if (count("update")) parts.push(plural(count("update"), "edit"));
  if (edges.length) parts.push(plural(edges.length, "line"));
  if (count("delete")) parts.push(`${plural(count("delete"), "card")} to delete`);
  return parts.join(" · ");
}
