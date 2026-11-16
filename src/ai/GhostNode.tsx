import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { ArrowRight, Check, ImagePlus, Move, Trash2, X } from "lucide-react";
import { Handles } from "../board/nodes";
import type { ColorData, ImageData, NoteData } from "../board/doc";
import { dismissGhosts, keepGhosts, type Ghost } from "./proposals";

/**
 * A suggestion previewed on the canvas, with Keep / Dismiss:
 * - add: a translucent new card (draggable, to place it before keeping)
 * - move: a dashed outline where an existing card would go
 * - update: a badge over the card (new name or block color)
 * - delete: a red overlay over the card; confirming deletes it
 */
export const GhostNode = memo(function GhostNode({ id, data }: NodeProps<Node<{ ghost: Ghost; groupLabel?: string } & Record<string, unknown>>>) {
  const g = data.ghost;
  const o = g.obj;

  if (g.kind === "delete") {
    return (
      <div className="cn-ghost-over cn-ghost-over--delete">
        <div className="cn-ghost-bar cn-ghost-bar--danger nodrag">
          <span className="cn-ghost-tag" title={g.why}>
            <Trash2 size={12} aria-hidden /> <span className="cn-ghost-why">Delete?{g.why ? ` ${g.why}` : ""}</span>
          </span>
          <button type="button" title="Delete this card" aria-label="Delete" onClick={() => keepGhosts([id])}>
            <Check size={13} strokeWidth={2.4} aria-hidden />
          </button>
          <button type="button" title="Keep the card" aria-label="Dismiss" onClick={() => dismissGhosts([id])}>
            <X size={13} strokeWidth={2.4} aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  if (g.kind === "update") {
    return (
      <div className="cn-ghost-over">
        <div className="cn-ghost-bar nodrag">
          <span className="cn-ghost-tag">
            ✦ {g.patch?.title ? <>Rename <ArrowRight size={11} aria-hidden /> “{g.patch.title}”</> : "Block color"}
            {g.patch?.tint && <i className="cn-ghost-dot" style={{ background: g.patch.tint }} />}
          </span>
          <Bar id={id} title="Apply" />
        </div>
      </div>
    );
  }

  if (g.kind === "move") {
    return (
      <div className="cn-ghost cn-ghost--move">
        <Handles />
        {!g.bundle && (
          <div className="cn-ghost-bar nodrag">
            <span className="cn-ghost-tag">
              <Move size={12} aria-hidden /> Move here
            </span>
            <Bar id={id} title="Move it" />
          </div>
        )}
        <div className="cn-ghost-moved">
          {o.type === "color" ? (
            <div className="cn-ghost-moved-swatch" style={{ background: (o.data as ColorData).hex }} />
          ) : null}
          <span className="cn-kind">{o.type === "image" ? "Image" : o.type}</span>
          <strong>{g.label}</strong>
          {g.patch?.tint && <i className="cn-ghost-dot" style={{ background: g.patch.tint }} />}
        </div>
      </div>
    );
  }

  // add
  const groupLead = g.bundle && g.lead && o.type === "note";
  return (
    <div className={`cn-ghost cn-ghost--${o.type}${groupLead ? " cn-ghost--group" : ""}`}>
      <Handles />
      {(!g.bundle || g.lead) && (
        <div className="cn-ghost-bar nodrag">
          <span className="cn-ghost-tag">{groupLead ? `✦ Group: ${g.label}` : g.bundle ? `✦ ${g.label}` : "✦ Suggestion"}</span>
          <Bar id={id} title={groupLead ? "Regroup these cards" : g.bundle ? "Keep this palette" : "Keep"} />
        </div>
      )}
      {o.type === "note" && (
        <div className="cn-ghost-note" style={(o.data as NoteData).tint ? { background: `${(o.data as NoteData).tint}cc` } : undefined}>
          {(o.data as NoteData).title && <strong>{(o.data as NoteData).title}</strong>}
          <p>{(o.data as NoteData).text}</p>
        </div>
      )}
      {o.type === "color" && (
        <div className="cn-ghost-color">
          <div style={{ background: (o.data as ColorData).hex }} />
          <span>
            <strong>{(o.data as ColorData).title ?? "Color"}</strong>
            <code>{(o.data as ColorData).hex.toUpperCase()}</code>
          </span>
        </div>
      )}
      {o.type === "image" && (
        <div className="cn-slot">
          <ImagePlus size={20} strokeWidth={1.5} aria-hidden />
          <strong>{(o.data as ImageData).title ?? "Reference"}</strong>
          <span className="cn-slot-find">“{(o.data as ImageData).find}”</span>
          {(o.data as ImageData).why && <span className="cn-slot-why">{(o.data as ImageData).why}</span>}
        </div>
      )}
    </div>
  );
});

function Bar({ id, title }: { id: string; title: string }) {
  return (
    <>
      <button type="button" title={title} aria-label="Keep" onClick={() => keepGhosts([id])}>
        <Check size={13} strokeWidth={2.4} aria-hidden />
      </button>
      <button type="button" title="Dismiss" aria-label="Dismiss" onClick={() => dismissGhosts([id])}>
        <X size={13} strokeWidth={2.4} aria-hidden />
      </button>
    </>
  );
}
