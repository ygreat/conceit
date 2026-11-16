import { Fragment, type ReactNode } from "react";

/**
 * Minimal Markdown for AI answers: headings, lists, paragraphs, code, bold,
 * italic. Builds React elements (no HTML strings), so model output can't
 * inject markup. Hex colors in backticks get a swatch.
 */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  // `code` | **bold** | *italic* | _italic_ | [label](url)
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<!\w)_([^_\n]+)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1] !== undefined) {
      const v = m[1].trim();
      out.push(
        HEX.test(v) ? (
          <code key={k} className="cn-ai-hex">
            <span style={{ background: v }} aria-hidden />
            {v}
          </code>
        ) : (
          <code key={k}>{m[1]}</code>
        ),
      );
    } else if (m[2] !== undefined) out.push(<strong key={k}>{inline(m[2], k)}</strong>);
    else if (m[3] !== undefined) out.push(<em key={k}>{m[3]}</em>);
    else if (m[4] !== undefined) out.push(<em key={k}>{m[4]}</em>);
    else out.push(<span key={k} className="cn-ai-link" title={m[6]}>{m[5]}</span>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${n++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={key}><code>{body.join("\n")}</code></pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 2, 6); // #→h3, keeps the panel's scale small
      const Tag = `h${level}` as "h3";
      blocks.push(<Tag key={key}>{inline(h[2], key)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        const raw = lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, "");
        const nested = /^\s{2,}/.test(lines[i]);
        const checkbox = /^\[( |x)\]\s+/i.exec(raw);
        items.push(
          <li key={`${key}-${items.length}`} className={[nested && "cn-ai-nested", checkbox && "cn-ai-task"].filter(Boolean).join(" ") || undefined}>
            {checkbox && <input type="checkbox" checked={checkbox[1] !== " "} readOnly tabIndex={-1} />}
            {inline(checkbox ? raw.slice(checkbox[0].length) : raw, `${key}-${items.length}`)}
          </li>,
        );
        i++;
      }
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }
    // Paragraph: consecutive plain lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|\s*([-*•]|\d+[.)])\s+)/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    blocks.push(
      <p key={key}>
        {para.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(l, `${key}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="cn-ai-md">{blocks}</div>;
}

/** Markdown → readable plain text, for answers placed on the board as notes. */
export function toPlainText(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/^```.*$/gm, "")
    .replace(/^#{1,6}\s+(.*)$/gm, (_, h: string) => h.toUpperCase())
    .replace(/^(\s*)[-*•]\s+\[( |x)\]\s+/gim, (_, sp: string, c: string) => `${sp}${c === " " ? "☐" : "☑"} `)
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "$1")
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
