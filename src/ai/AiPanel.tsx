import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { ArrowUp, Check, ChevronDown, CircleAlert, Copy, History, KeyRound, Plus, RotateCcw, Scan, Square, StickyNote, Terminal, Trash2, X } from "lucide-react";
import { ago } from "../files/files";
import { canSaveChats, chats, type ChatMeta } from "./chats";
import { newId } from "../board/doc";
import { updateSettings, useSettings } from "../settings";
import { buildContext, type BoardContext } from "./context";
import { aiAvailable, cancel, chat, getStatus, isReady, pickProvider, PROVIDERS, setApiKey, type AiStatus, type ProviderId, type Turn } from "./client";
import { Markdown, toPlainText } from "./Markdown";
import { actionById, QUICK_ACTIONS, SYSTEM_PROMPT, type QuickAction } from "./prompts";
import { buildGhosts, confirmDeletes, describe, dismissGhosts, isGhostId, keepGhosts, parsePlan, pendingDeletes, resultFor, showProposal, stripPlan, useProposal } from "./proposals";

/**
 * AI panel (PRD §5.3): chat about the board, with pre-written actions.
 * Visual language follows beautifului.dev's Chat, Thinking and Prompt Bar
 * primitives (MIT), rebuilt on Conceit's CSS tokens.
 */

type Status = "reading" | "thinking" | "writing" | "done" | "stopped" | "error";

interface Message {
  id: string;
  role: "user" | "assistant";
  /** What was asked (user) or answered (assistant). */
  text: string;
  /** Quick action that produced this exchange. */
  action?: string;
  /** What the user typed, when it differs from what was sent (brief actions). */
  display?: string;
  /** Suggestions placed on the canvas from this answer. */
  proposal?: { count: number; summary: string };
  /** What became of them (kept with a saved chat; the suggestions themselves aren't). */
  outcome?: { kept: number; dismissed: number; skipped: number };
  // assistant only
  status?: Status;
  thinking?: string;
  error?: string;
  provider?: ProviderId;
  model?: string;
  started?: number;
  ended?: number;
  scope?: Pick<BoardContext, "summary" | "ids" | "bounds"> & { images: number; selection: boolean };
}

export interface AiNote {
  text: string;
  title: string;
  from: string[];
  bounds: BoardContext["bounds"];
  provider?: string;
}

const SPARKLE = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
  </svg>
);

function seconds(m: Message): number {
  return Math.max(1, Math.round(((m.ended ?? Date.now()) - (m.started ?? Date.now())) / 1000));
}

function providerLabel(id?: ProviderId) {
  return PROVIDERS.find((p) => p.id === id)?.label ?? "";
}

/** Short model name for the answer header. */
function shortModel(name?: string) {
  return name?.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// ---------------------------------------------------------------- Thinking

function ThinkingRow({ m }: { m: Message }) {
  const working = m.status === "reading" || m.status === "thinking";
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? false;
  const label =
    m.status === "reading" ? "Reading the board" : m.status === "thinking" ? "Thinking" : `Read ${m.scope?.summary ?? "the board"} · ${seconds(m)}s`;
  const rows: string[] = [];
  if (m.scope) {
    rows.push(m.scope.selection ? `Scoped to your selection` : "Scoped to the whole board");
    rows.push(`Read ${m.scope.summary}`);
    if (m.scope.images) rows.push(`Looked at ${m.scope.images} picture${m.scope.images === 1 ? "" : "s"}`);
  }
  return (
    <div className="cn-ai-thinking">
      <button type="button" className="cn-ai-thinking-head" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        <span className={`cn-ai-spark${working ? " on" : ""}`}>{SPARKLE}</span>
        <span role="status" className={working ? "cn-ai-shimmer" : "cn-ai-settled"}>
          {label}
        </span>
        <ChevronDown size={14} strokeWidth={2.2} className="cn-ai-chev" style={{ transform: expanded ? "rotate(180deg)" : undefined }} aria-hidden />
      </button>
      <div className="cn-ai-collapse" style={{ gridTemplateRows: expanded ? "1fr" : "0fr", opacity: expanded ? 1 : 0 }}>
        <div className="cn-ai-trace">
          {rows.map((r) => (
            <div key={r} className="cn-ai-trace-row">
              <Check size={12} strokeWidth={2.4} aria-hidden />
              {r}
            </div>
          ))}
          {m.thinking?.trim() && <p className="cn-ai-trace-text">{m.thinking.trim()}</p>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Suggestions

function ProposalCard({ m, onShow }: { m: Message; onShow: () => void }) {
  const p = useProposal(); // re-render as suggestions are kept or dismissed
  const r = resultFor(m.id) ?? (m.outcome ? { ...m.outcome, open: 0, edges: 0 } : null);
  const mine = p?.id === m.id ? p : null;
  const deletes = pendingDeletes(mine);
  const others = mine ? mine.ghosts.filter((g) => g.kind !== "delete") : [];
  const open = (r?.open ?? 0) + (r?.edges ?? 0);
  const done = r ? [`Applied ${r.kept}`, `dismissed ${r.dismissed}`, r.skipped ? `${r.skipped} skipped (the card changed since)` : ""].filter(Boolean).join(" · ") : "";
  return (
    <div className="cn-ai-proposal">
      <div className="cn-ai-proposal-head">
        <span className="cn-ai-spark on">{SPARKLE}</span>
        <div>
          <strong>{open ? `${open} suggestion${open === 1 ? "" : "s"} on the board` : r ? "Suggestions handled" : "Suggestions closed"}</strong>
          <small>{mine && open ? describe(mine.ghosts, mine.edges) : r ? done : `${m.proposal?.summary ?? "Suggestions"}: no longer on the canvas`}</small>
          {mine && open > 0 && r?.skipped ? <small>{done}</small> : null}
        </div>
      </div>
      {mine && (others.length > 0 || mine.edges.length > 0) && (
        <div className="cn-ai-row">
          <button type="button" className="cn-ai-primary" onClick={() => keepGhosts()}>
            {others.some((g) => g.kind !== "add") || mine.edges.some((e) => !isGhostId(e.source) && !isGhostId(e.target)) ? "Apply all" : "Keep all"}
          </button>
          <button type="button" className="cn-ai-chip" onClick={() => dismissGhosts()}>
            Dismiss all
          </button>
          <button type="button" className="cn-ai-chip" onClick={onShow}>
            Show
          </button>
        </div>
      )}
      {deletes.length > 0 && (
        <div className="cn-ai-delete">
          <span>
            Delete {deletes.length} card{deletes.length === 1 ? "" : "s"}? <small>{deletes.map((g) => g.label).join(", ")}</small>
          </span>
          <div className="cn-ai-row">
            <button type="button" className="cn-ai-danger" onClick={confirmDeletes}>
              Delete
            </button>
            <button type="button" className="cn-ai-chip" onClick={() => dismissGhosts(deletes.map((g) => g.gid))}>
              Keep them
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Messages

function AssistantMessage({
  m,
  last,
  onAdd,
  onRetry,
  onSetup,
  onShow,
}: {
  m: Message;
  last: boolean;
  onAdd: (m: Message) => void;
  onRetry: () => void;
  onSetup: () => void;
  onShow: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [added, setAdded] = useState(false);
  const action = actionById(m.action);
  const streaming = m.status === "reading" || m.status === "thinking" || m.status === "writing";
  const { text, planning } = stripPlan(m.text);
  const sub = [providerLabel(m.provider), shortModel(m.model)].filter(Boolean).join(" · ");
  return (
    <div className="cn-ai-section">
      <ThinkingRow m={m} />
      {(text || m.status === "writing") && (
        <>
          <div className="cn-ai-section-head">
            <span className="cn-ai-section-label">{action?.label ?? "Answer"}</span>
            {sub && <span className="cn-ai-section-sub">{sub}</span>}
            {!streaming && <span>for {seconds(m)}s</span>}
          </div>
          <div className={streaming && !planning ? "cn-ai-streaming" : undefined}>
            <Markdown text={text} />
          </div>
        </>
      )}
      {planning && streaming && (
        <div className="cn-ai-planning">
          <span className="cn-ai-shimmer">Placing suggestions on the board</span>
        </div>
      )}
      {m.proposal && !streaming && <ProposalCard m={m} onShow={onShow} />}
      {!streaming && m.status === "done" && /```conceit/.test(m.text) && !m.proposal && (
        <p className="cn-ai-muted">The suggestions couldn't be read. Try again.</p>
      )}
      {m.status === "stopped" && <p className="cn-ai-muted">Stopped.</p>}
      {m.status === "error" && (
        <div className="cn-ai-error" role="alert">
          <CircleAlert size={14} strokeWidth={2} aria-hidden />
          <div>
            <p>{m.error}</p>
            <div className="cn-ai-row">
              {last && (
                <button type="button" className="cn-ai-chip" onClick={onRetry}>
                  <RotateCcw size={12} aria-hidden /> Try again
                </button>
              )}
              <button type="button" className="cn-ai-chip" onClick={onSetup}>
                Model access
              </button>
            </div>
          </div>
        </div>
      )}
      {!streaming && text && (
        <div className="cn-ai-actions">
          <button
            type="button"
            className="cn-ai-chip"
            onClick={() => {
              navigator.clipboard?.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              });
            }}
          >
            {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            className="cn-ai-chip"
            disabled={added}
            onClick={() => {
              onAdd(m);
              setAdded(true);
            }}
            title="Place this answer on the board as a note"
          >
            {added ? <Check size={12} aria-hidden /> : <StickyNote size={12} aria-hidden />}
            {added ? "Added" : "Add to board"}
          </button>
          {last && (
            <button type="button" className="cn-ai-chip cn-ai-icon-chip" onClick={onRetry} title="Ask again" aria-label="Ask again">
              <RotateCcw size={12} aria-hidden />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Setup

function Setup({ status, refresh, provider }: { status: AiStatus | null; refresh: () => void; provider: ProviderId }) {
  const settings = useSettings();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const saveKey = async (value: string) => {
    setSaving(true);
    setMsg(null);
    try {
      await setApiKey(value);
      setKey("");
      setMsg(value ? "Key saved to the keychain." : "Key removed.");
      if (value) updateSettings({ aiProvider: "anthropic-api" });
      refresh();
    } catch (err) {
      setMsg(String(err));
    } finally {
      setSaving(false);
    }
  };

  const statusText = (id: ProviderId) => {
    if (!status) return "Checking…";
    if (id === "claude-cli") return status.claudeCli ? `Found at ${status.claudeCli}` : "Not found. Install Claude Code and log in.";
    if (id === "codex-cli") return status.codexCli ? `Found at ${status.codexCli}` : "Not found. Install Codex CLI and log in.";
    return status.hasApiKey ? "Key saved in the keychain" : "No key saved yet";
  };

  const info = PROVIDERS.find((p) => p.id === provider)!;
  return (
    <div className="cn-ai-setup">
      <h4>Model access</h4>
      <p className="cn-ai-muted">Bring your own: an AI CLI you're already logged in to, or an API key. Conceit hosts no AI.</p>
      <div className="cn-ai-providers" role="radiogroup" aria-label="Model access">
        {PROVIDERS.map((p) => {
          const ready = isReady(p.id, status);
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={provider === p.id}
              className={`cn-ai-provider${provider === p.id ? " on" : ""}`}
              onClick={() => updateSettings({ aiProvider: p.id })}
            >
              <span className="cn-ai-provider-icon">{p.id === "anthropic-api" ? <KeyRound size={15} aria-hidden /> : <Terminal size={15} aria-hidden />}</span>
              <span className="cn-ai-provider-text">
                <span>
                  {p.label}
                  <i className={`cn-ai-dot${ready ? " ok" : ""}`} aria-label={ready ? "ready" : "not set up"} />
                </span>
                <small>{p.detail}</small>
                <small className="cn-ai-path">{statusText(p.id)}</small>
              </span>
            </button>
          );
        })}
      </div>

      {provider === "anthropic-api" && (
        <form
          className="cn-ai-key"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void saveKey(key.trim());
          }}
        >
          <label>
            <span>API key</span>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={status?.hasApiKey ? "•••••••• saved (paste to replace)" : "sk-ant-…"}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="cn-ai-row">
            <button type="submit" className="cn-ai-primary" disabled={!key.trim() || saving}>
              Save key
            </button>
            {status?.hasApiKey && (
              <button type="button" className="cn-ai-chip" disabled={saving} onClick={() => void saveKey("")}>
                Remove key
              </button>
            )}
          </div>
          <p className="cn-ai-muted">Stored in the system keychain. It never comes back to this window and is only sent to api.anthropic.com.</p>
        </form>
      )}
      {msg && <p className="cn-ai-muted" role="status">{msg}</p>}

      <label className="cn-ai-model">
        <span>Model for {info.label}</span>
        <input
          value={settings.aiModels[provider] ?? ""}
          onChange={(e) => updateSettings({ aiModels: { ...settings.aiModels, [provider]: e.target.value } })}
          placeholder={info.modelHint}
          spellCheck={false}
        />
      </label>

      <details className="cn-ai-instructions">
        <summary>Pre-written instructions</summary>
        <p className="cn-ai-muted">Sent with every request, so the agent knows how to read a mood board. Edit them in src/ai/prompts.ts.</p>
        <pre>{SYSTEM_PROMPT}</pre>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- Panel

export function AiPanel({ open, onClose, onAddNote }: { open: boolean; onClose: () => void; onAddNote: (n: AiNote) => void }) {
  const settings = useSettings();
  const [tab, setTab] = useState<"chat" | "setup">("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatMeta[] | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Scope chip: the selection, else the whole board (PRD §5.1).
  const selectedKey = useStore((s) => s.nodes.filter((n) => n.selected && n.type !== "ghost").map((n) => n.id).join(","));
  const total = useStore((s) => s.nodes.filter((n) => n.type !== "ghost").length);
  const { screenToFlowPosition, setCenter, getNodes } = useReactFlow();
  const [pending, setPending] = useState<QuickAction | null>(null);
  const selected = useMemo(() => (selectedKey ? selectedKey.split(",") : []), [selectedKey]);

  const provider = pickProvider(settings.aiProvider, status);
  const ready = isReady(provider, status);

  const refresh = useCallback(() => {
    if (!aiAvailable()) return;
    getStatus().then(setStatus).catch(() => setStatus({ claudeCli: null, codexCli: null, hasApiKey: false }));
  }, []);
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);
  useEffect(() => {
    if (open && tab === "chat") requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, tab]);

  // --- Saved chats (per board, in its file) ------------------------------

  // On first open: continue the board's most recent chat.
  const restored = useRef(false);
  useEffect(() => {
    if (!open || restored.current || !canSaveChats()) return;
    restored.current = true;
    chats
      .list()
      .then((list) => list[0] && loadChat(list[0].id))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const loadChat = async (id: string) => {
    const saved = await chats.load<Message[]>(id);
    if (!saved) return;
    // Anything that was mid-answer when saved ends as stopped.
    setMessages(saved.map((m) => (m.status && ["reading", "thinking", "writing"].includes(m.status) ? { ...m, status: "stopped" as Status } : m)));
    setChatId(id);
    setHistory(null);
    setTab("chat");
  };

  // Save after every finished exchange (not while an answer streams in).
  useEffect(() => {
    if (running || !messages.length || !canSaveChats()) return;
    const id = chatId ?? newId();
    if (!chatId) setChatId(id);
    const t = window.setTimeout(() => {
      const first = messages.find((m) => m.role === "user");
      const title = (first?.display ?? actionById(first?.action)?.label ?? first?.text ?? "Chat").replace(/\s+/g, " ").slice(0, 80);
      const data = messages.map((m) => {
        if (!m.proposal) return m;
        const r = resultFor(m.id);
        return r ? { ...m, outcome: { kept: r.kept, dismissed: r.dismissed, skipped: r.skipped } } : m;
      });
      chats.save(id, title, data).catch((e) => console.warn("Couldn't save the chat:", e));
    }, 400);
    return () => window.clearTimeout(t);
  }, [messages, running, chatId]);

  const showHistory = () => {
    if (history) return setHistory(null);
    chats.list().then(setHistory).catch(() => setHistory([]));
  };
  const deleteChat = async (id?: string) => {
    await chats.remove(id).catch(() => {});
    if (!id || id === chatId) {
      setMessages([]);
      setChatId(null);
    }
    setHistory(id ? (h) => h?.filter((c) => c.id !== id) ?? null : []);
  };

  // Follow the reply while it streams, unless the user scrolled up.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Autosize the composer.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft, open, tab]);

  const patch = (id: string, p: Partial<Message> | ((m: Message) => Partial<Message>)) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...(typeof p === "function" ? p(m) : p) } : m)));

  const send = useCallback(
    async (text: string, action?: QuickAction, history: Message[] = messages, display?: string) => {
      const request = text.trim();
      if (!request || running) return;
      pinned.current = true;
      const user: Message = { id: newId(), role: "user", text: request, action: action?.id, display };
      const reply: Message = { id: newId(), role: "assistant", text: "", action: action?.id, status: "reading", provider, started: Date.now() };
      setMessages([...history, user, reply]);
      setDraft("");
      setRunning(reply.id);

      try {
        const ctx = await buildContext(selected);
        patch(reply.id, {
          status: "thinking",
          scope: { summary: ctx.summary, ids: ctx.ids, bounds: ctx.bounds, images: ctx.images.length, selection: selected.length > 0 },
        });
        // Earlier turns go as plain text; only the new one carries the board.
        const turns: Turn[] = [];
        for (const m of history) {
          if (m.role === "user") turns.push({ role: "user", text: m.text });
          else if (m.text && m.status === "done") {
            const said = stripPlan(m.text).text;
            const note = m.proposal ? `\n\n(I proposed: ${m.proposal.summary}.)` : "";
            turns.push({ role: "assistant", text: (said || "(suggestions only)") + note });
          }
          else turns.pop(); // drop a question whose answer failed, to keep turns alternating
        }
        turns.push({ role: "user", text: `${ctx.text}\n\n${request}` });

        let gotError = false;
        let full = "";
        let stopped = false;
        let model: string | undefined;
        await chat(
          { id: reply.id, provider, model: settings.aiModels[provider]?.trim() ?? "", system: SYSTEM_PROMPT, turns, images: ctx.images },
          (e) => {
            if (e.type === "text") {
              full += e.text;
              patch(reply.id, (m) => ({ text: m.text + e.text, status: "writing" }));
            }
            else if (e.type === "thinking") patch(reply.id, (m) => ({ thinking: (m.thinking ?? "") + e.text }));
            else if (e.type === "model") {
              model = e.name;
              patch(reply.id, { model: e.name });
            }
            else if (e.type === "error") {
              gotError = true;
              patch(reply.id, { status: "error", error: e.message, ended: Date.now() });
            } else if (e.type === "done") {
              stopped = stoppedRef.current === reply.id;
              const plan = stopped ? null : parsePlan(full);
              const proposal = plan ? propose(reply.id, plan, ctx, provider, model) : undefined;
              patch(reply.id, (m) => (m.status === "stopped" ? { ended: Date.now() } : { status: "done", ended: Date.now(), proposal }));
            }
          },
        );
        if (!gotError) patch(reply.id, (m) => (m.status === "error" ? {} : { ended: m.ended ?? Date.now() }));
      } catch (err) {
        patch(reply.id, { status: "error", error: String(err), ended: Date.now() });
      } finally {
        setRunning(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, running, provider, selected, settings.aiModels],
  );

  /** Lay out a plan as ghosts beside what was read, and bring them into view. */
  const propose = (id: string, plan: NonNullable<ReturnType<typeof parsePlan>>, ctx: BoardContext, p?: ProviderId, model?: string) => {
    const b = ctx.bounds;
    const anchor = b ? { x: b.x + b.w + 120, y: b.y } : screenToFlowPosition({ x: 80, y: 120 });
    const built = buildGhosts(plan, { ids: ctx.ids, bounds: ctx.bounds }, anchor, [providerLabel(p), shortModel(model)].filter(Boolean).join(" · "));
    if (!built.ghosts.length && !built.edges.length) return undefined;
    showProposal(id, built);
    requestAnimationFrame(() => requestAnimationFrame(showGhosts)); // after the ghosts render
    return { count: built.ghosts.length + built.edges.length, summary: describe(built.ghosts, built.edges) };
  };

  /** Center the suggestions in the part of the canvas the panel doesn't cover. */
  const showGhosts = () => {
    const ghosts = getNodes().filter((n) => n.type === "ghost");
    if (!ghosts.length) return;
    const x0 = Math.min(...ghosts.map((n) => n.position.x));
    const y0 = Math.min(...ghosts.map((n) => n.position.y));
    const x1 = Math.max(...ghosts.map((n) => n.position.x + (n.width ?? 0)));
    const y1 = Math.max(...ghosts.map((n) => n.position.y + (n.height ?? 0)));
    const availW = Math.max(300, window.innerWidth - 440), availH = Math.max(300, window.innerHeight - 140);
    const zoom = Math.max(0.2, Math.min(1, availW / (x1 - x0 + 120), availH / (y1 - y0 + 120)));
    setCenter((x0 + x1) / 2 + 210 / zoom, (y0 + y1) / 2 + 30 / zoom, { zoom, duration: 450 });
  };

  const stoppedRef = useRef<string | null>(null);
  const stop = () => {
    if (!running) return;
    stoppedRef.current = running;
    patch(running, { status: "stopped", ended: Date.now() });
    void cancel(running);
  };

  const retry = () => {
    const i = messages.map((m) => m.role).lastIndexOf("user");
    if (i < 0) return;
    const q = messages[i];
    void send(q.text, actionById(q.action), messages.slice(0, i));
  };

  const addNote = (m: Message) => {
    const action = actionById(m.action);
    onAddNote({
      text: toPlainText(stripPlan(m.text).text),
      title: action?.noteTitle ?? "Answer",
      from: m.scope?.ids ?? [],
      bounds: m.scope?.bounds ?? null,
      provider: [providerLabel(m.provider), shortModel(m.model)].filter(Boolean).join(" · "),
    });
  };

  // "/" opens the pre-written actions.
  const slash = draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1).toLowerCase() : null;
  const menu = slash === null ? [] : QUICK_ACTIONS.filter((a) => a.label.toLowerCase().includes(slash) || a.id.includes(slash));
  useEffect(() => setMenuIndex(0), [slash]);

  const runAction = (a: QuickAction) => {
    if (a.prefill) {
      const typed = draft.startsWith("/") ? "" : draft.trim();
      if (typed) {
        setPending(null);
        void send(`${a.prompt}\n${typed}`, a, messages, typed);
        return;
      }
      setPending(a);
      setDraft(a.prefill);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
      return;
    }
    void send(a.prompt, a);
  };

  /** Send what's in the composer (as the brief, when a brief action is waiting for one). */
  const sendDraft = () => {
    const a = pending;
    setPending(null);
    if (a?.prefill && draft.startsWith(a.prefill.trim())) {
      const brief = draft.slice(a.prefill.length).trim() || draft.trim();
      void send(`${a.prompt}\n${brief}`, a, messages, draft.trim());
      return;
    }
    void send(draft);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (menu.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i + (e.key === "ArrowDown" ? 1 : menu.length - 1)) % menu.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        runAction(menu[menuIndex]);
        return;
      }
    }
    if (e.key === "Escape") {
      if (draft) {
        setDraft("");
        setPending(null);
      } else onClose();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) sendDraft();
    }
  };

  const canSend =
    draft.trim().length > 0 && !running && slash === null && !(pending?.prefill && draft.trim() === pending.prefill.trim());
  const scopeLabel = selected.length ? `Selection · ${selected.length}` : `Whole board · ${total}`;
  const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");

  return (
    <aside className={`cn-ai${open ? " open" : ""}`} aria-label="AI board partner" aria-hidden={!open} inert={!open}>
      <div className="cn-ai-head">
        <div className="cn-ai-tabs" role="tablist">
          {(["chat", "setup"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : undefined} onClick={() => setTab(t)}>
              {t === "chat" ? "Board chat" : "Setup"}
            </button>
          ))}
        </div>
        <div className="cn-ai-head-actions">
          <button
            type="button"
            className="cn-ai-icon"
            title="New chat"
            aria-label="New chat"
            disabled={!!running || messages.length === 0}
            onClick={() => {
              setMessages([]);
              setChatId(null);
              setHistory(null);
              setTab("chat");
            }}
          >
            <Plus size={15} strokeWidth={2} aria-hidden />
          </button>
          {canSaveChats() && (
            <button
              type="button"
              className={`cn-ai-icon${history ? " on" : ""}`}
              title="Earlier chats about this board"
              aria-label="Chat history"
              aria-expanded={!!history}
              disabled={!!running}
              onClick={showHistory}
            >
              <History size={15} strokeWidth={2} aria-hidden />
            </button>
          )}
          <button type="button" className="cn-ai-icon" title="Close (⌘J)" aria-label="Close AI panel" onClick={onClose}>
            <X size={15} strokeWidth={2} aria-hidden />
          </button>
        </div>
      </div>

      {history && (
        <div className="cn-ai-history" role="dialog" aria-label="Chat history">
          <div className="cn-ai-history-head">
            <strong>Chats about this board</strong>
            <small>Saved in the board file, not shared in copies unless you choose to.</small>
          </div>
          {history.length === 0 ? (
            <p className="cn-ai-muted">No saved chats yet.</p>
          ) : (
            <ul>
              {history.map((c) => (
                <li key={c.id} className={c.id === chatId ? "on" : undefined}>
                  <button type="button" className="cn-ai-history-item" onClick={() => loadChat(c.id)}>
                    <span>{c.title}</span>
                    <small>{ago(c.updated)}</small>
                  </button>
                  <button type="button" className="cn-ai-icon" title="Delete this chat" aria-label={`Delete chat ${c.title}`} onClick={() => deleteChat(c.id)}>
                    <Trash2 size={13} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {history.length > 0 && (
            <button type="button" className="cn-ai-chip cn-ai-history-clear" onClick={() => deleteChat()}>
              Delete all chats
            </button>
          )}
        </div>
      )}

      {tab === "setup" ? (
        <div className="cn-ai-body">
          <Setup status={status} refresh={refresh} provider={provider} />
        </div>
      ) : (
        <>
          <div
            className="cn-ai-body"
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {!aiAvailable() ? (
              <div className="cn-ai-empty">
                <p className="cn-ai-muted">The AI partner runs in the desktop app (pnpm tauri dev), not in a plain browser tab.</p>
              </div>
            ) : messages.length === 0 ? (
              <div className="cn-ai-empty">
                <div className="cn-ai-empty-title">
                  <span className="cn-ai-spark">{SPARKLE}</span>
                  Ask about {selected.length ? "the selection" : "this board"}
                </div>
                <p className="cn-ai-muted">
                  It reads the cards, notes, colors, pictures and lines in scope, and suggests notes, palettes and references you keep or dismiss. Select cards to narrow it down.
                </p>
                <div className="cn-ai-cmds">
                  {QUICK_ACTIONS.map((a) => (
                    <button key={a.id} type="button" className="cn-ai-cmd" disabled={!ready || (total === 0 && !a.prefill)} onClick={() => runAction(a)}>
                      <span>{a.label}</span>
                      <small>{a.hint}</small>
                    </button>
                  ))}
                </div>
                {status && !ready && (
                  <button type="button" className="cn-ai-setup-nudge" onClick={() => setTab("setup")}>
                    <CircleAlert size={14} aria-hidden />
                    Set up model access to start
                  </button>
                )}
                {status && ready && total === 0 && <p className="cn-ai-muted">Empty board: start from a brief, or add a few cards first.</p>}
              </div>
            ) : (
              <div className="cn-ai-thread">
                {messages.map((m, i) =>
                  m.role === "user" ? (
                    <div key={m.id} className="cn-ai-user">
                      <div>{m.display ?? actionById(m.action)?.label ?? m.text}</div>
                    </div>
                  ) : (
                    <AssistantMessage
                      key={m.id}
                      m={m}
                      last={i === lastAssistant && !running}
                      onAdd={addNote}
                      onRetry={retry}
                      onSetup={() => setTab("setup")}
                      onShow={showGhosts}
                    />
                  ),
                )}
              </div>
            )}
          </div>

          <div className="cn-ai-composer-wrap">
            {menu.length > 0 && (
              <div className="cn-ai-menu" role="listbox" aria-label="Actions">
                {menu.map((a, i) => (
                  <button
                    key={a.id}
                    type="button"
                    role="option"
                    aria-selected={i === menuIndex}
                    className={i === menuIndex ? "on" : undefined}
                    onMouseEnter={() => setMenuIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runAction(a)}
                  >
                    <span>/{a.id}</span>
                    <small>{a.hint}</small>
                  </button>
                ))}
              </div>
            )}
            <div className="cn-ai-composer" role="presentation" onClick={() => inputRef.current?.focus()}>
              <textarea
                ref={inputRef}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={ready ? "Ask about the board, or type / for actions" : "Set up model access to start"}
                aria-label="Message the AI"
                disabled={!aiAvailable()}
              />
              <div className="cn-ai-composer-foot">
                <span className="cn-ai-scope" title={selected.length ? "The AI sees only the selected cards" : "The AI sees the whole board"}>
                  <Scan size={12} strokeWidth={2} aria-hidden />
                  {scopeLabel}
                </span>
                <div className="cn-ai-picker">
                  <button type="button" className="cn-ai-model-btn" onClick={(e) => { e.stopPropagation(); setPickerOpen((o) => !o); }} aria-expanded={pickerOpen}>
                    <i className={`cn-ai-dot${ready ? " ok" : ""}`} aria-hidden />
                    {providerLabel(provider)}
                    <ChevronDown size={12} strokeWidth={2.2} aria-hidden />
                  </button>
                  {pickerOpen && (
                    <div className="cn-ai-picker-menu" role="menu" onMouseLeave={() => setPickerOpen(false)}>
                      {PROVIDERS.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={p.id === provider}
                          onClick={(e) => {
                            e.stopPropagation();
                            updateSettings({ aiProvider: p.id });
                            setPickerOpen(false);
                            if (!isReady(p.id, status)) setTab("setup");
                          }}
                        >
                          <i className={`cn-ai-dot${isReady(p.id, status) ? " ok" : ""}`} aria-hidden />
                          {p.label}
                          {p.id === provider && <Check size={12} aria-hidden />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {running ? (
                  <button type="button" className="cn-ai-send on" aria-label="Stop" title="Stop" onClick={(e) => { e.stopPropagation(); stop(); }}>
                    <Square size={11} fill="currentColor" aria-hidden />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`cn-ai-send${canSend ? " on" : ""}`}
                    aria-label="Send"
                    disabled={!canSend}
                    onClick={(e) => {
                      e.stopPropagation();
                      sendDraft();
                    }}
                  >
                    <ArrowUp size={16} strokeWidth={2.4} aria-hidden />
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
