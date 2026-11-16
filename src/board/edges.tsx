import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { DEFAULT_LINE, type LineStyle, type MarkerShape } from "./doc";

export type LineEdgeData = { line?: Partial<LineStyle>; label?: string };
export type LineEdgeType = Edge<LineEdgeData, "line">;

/** End shape drawn in a 10×10 box, tip at x=10, pointing right. */
export function MarkerGlyph({ shape, color }: { shape: MarkerShape; color: string }) {
  switch (shape) {
    case "arrow":
      return (
        <path
          d="M1.5 1.5 L9 5 L1.5 8.5"
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case "triangle":
      return <path d="M0.5 0.8 L10 5 L0.5 9.2 Z" fill={color} />;
    case "circle":
      return <circle cx={5.5} cy={5} r={4} fill={color} />;
    case "diamond":
      return <path d="M1 5 L5.5 1 L10 5 L5.5 9 Z" fill={color} />;
    default:
      return null;
  }
}

export function dashArray(dash: LineStyle["dash"], width: number) {
  if (dash === "dashed") return `${width * 4} ${width * 3}`;
  if (dash === "dotted") return `0 ${width * 2.5}`;
  return undefined;
}

/*
 * Line ends are drawn as ordinary shapes placed and rotated at each endpoint,
 * not as SVG <marker>s. WebKit (the macOS/Linux app webview) caches markers
 * and often fails to redraw them when they change, which made start/end
 * shapes stale or missing. Plain shapes render identically everywhere.
 */

type Vec = { x: number; y: number };

/** Unit vector pointing away from the node, out of a handle on this side. */
function outward(p: Position): Vec {
  switch (p) {
    case Position.Left: return { x: -1, y: 0 };
    case Position.Right: return { x: 1, y: 0 };
    case Position.Top: return { x: 0, y: -1 };
    default: return { x: 0, y: 1 };
  }
}

const capSize = (width: number) => 7 + width * 2.2;

/** How far to pull the line back so a filled cap covers its end cleanly. */
function inset(shape: MarkerShape, size: number) {
  switch (shape) {
    case "triangle":
    case "diamond": return size * 0.85;
    case "circle": return size * 0.5;
    case "arrow": return size * 0.12;
    default: return 0;
  }
}

function EndCap({ at, dir, shape, color, width }: { at: Vec; dir: Vec; shape: MarkerShape; color: string; width: number }) {
  if (shape === "none") return null;
  const s = capSize(width);
  const angle = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
  return (
    <g
      transform={`translate(${at.x} ${at.y}) rotate(${angle}) scale(${s / 10}) translate(-10 -5)`}
      style={{ pointerEvents: "none" }}
    >
      <MarkerGlyph shape={shape} color={color} />
    </g>
  );
}

export const LineEdge = memo(function LineEdge(props: EdgeProps<LineEdgeType>) {
  const { id, data, selected, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props;
  const line = { ...DEFAULT_LINE, ...data?.line };
  const size = capSize(line.width);

  // Direction each cap points (toward its node) and the direction to pull the
  // line back from that endpoint.
  let startDir: Vec, endDir: Vec;
  if (line.path === "straight") {
    const dx = targetX - sourceX, dy = targetY - sourceY;
    const len = Math.hypot(dx, dy) || 1;
    endDir = { x: dx / len, y: dy / len };
    startDir = { x: -endDir.x, y: -endDir.y };
  } else {
    // Curved and elbow paths always meet a handle at a right angle to its side.
    const so = outward(sourcePosition), to = outward(targetPosition);
    startDir = { x: -so.x, y: -so.y };
    endDir = { x: -to.x, y: -to.y };
  }
  const si = inset(line.start, size), ei = inset(line.end, size);
  const geo = {
    sourceX: sourceX - startDir.x * si,
    sourceY: sourceY - startDir.y * si,
    targetX: targetX - endDir.x * ei,
    targetY: targetY - endDir.y * ei,
    sourcePosition,
    targetPosition,
  };
  const [path, labelX, labelY] =
    line.path === "straight"
      ? getStraightPath(geo)
      : line.path === "smoothstep"
        ? getSmoothStepPath({ ...geo, borderRadius: 14 })
        : getBezierPath(geo);

  return (
    <>
      {selected && (
        <path
          d={path}
          fill="none"
          className="cn-edge-halo"
          strokeWidth={line.width + 10}
          strokeLinecap="round"
        />
      )}
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={Math.max(20, line.width + 14)}
        style={{
          stroke: line.color,
          strokeWidth: line.width,
          strokeDasharray: dashArray(line.dash, line.width),
          strokeLinecap: line.dash === "dotted" ? "round" : "butt",
        }}
      />
      <EndCap at={{ x: sourceX, y: sourceY }} dir={startDir} shape={line.start} color={line.color} width={line.width} />
      <EndCap at={{ x: targetX, y: targetY }} dir={endDir} shape={line.end} color={line.color} width={line.width} />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className="cn-edge-label"
            data-edge-id={id}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              borderColor: line.color,
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes = { line: LineEdge };
