import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { AiImage } from "./context";

/** Bridge to the Rust AI gateway (`src-tauri/src/ai.rs`). */

export type ProviderId = "claude-cli" | "codex-cli" | "anthropic-api";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** One line under the label in settings. */
  detail: string;
  /** Placeholder for the model field. */
  modelHint: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude-cli",
    label: "Claude Code",
    detail: "Uses your Claude Code login and plan",
    modelHint: "CLI default (e.g. opus, sonnet)",
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    detail: "Uses your Codex login and plan",
    modelHint: "CLI default",
  },
  {
    id: "anthropic-api",
    label: "Anthropic API key",
    detail: "Your own key, kept in the system keychain",
    modelHint: "claude-opus-5-5",
  },
];

export interface AiStatus {
  claudeCli: string | null;
  codexCli: string | null;
  hasApiKey: boolean;
}

export type AiEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "model"; name: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export function aiAvailable(): boolean {
  return isTauri();
}

export function getStatus(): Promise<AiStatus> {
  return invoke<AiStatus>("ai_status");
}

/** Save the key to the keychain; an empty string removes it. */
export function setApiKey(key: string): Promise<void> {
  return invoke("ai_set_api_key", { key });
}

export function isReady(p: ProviderId, s: AiStatus | null): boolean {
  if (!s) return false;
  return p === "claude-cli" ? !!s.claudeCli : p === "codex-cli" ? !!s.codexCli : s.hasApiKey;
}

/** The chosen provider, or the first one that's ready. */
export function pickProvider(chosen: ProviderId | "", s: AiStatus | null): ProviderId {
  if (chosen) return chosen;
  return PROVIDERS.find((p) => isReady(p.id, s))?.id ?? "claude-cli";
}

export interface ChatParams {
  id: string;
  provider: ProviderId;
  model: string;
  system: string;
  turns: Turn[];
  images: AiImage[];
}

/** Start a reply. Resolves when it has finished (after `done` or `error`). */
export async function chat(params: ChatParams, onEvent: (e: AiEvent) => void): Promise<void> {
  const ch = new Channel<AiEvent>();
  ch.onmessage = onEvent;
  await invoke("ai_chat", { request: params, onEvent: ch });
}

export function cancel(id: string): Promise<void> {
  return invoke("ai_cancel", { id });
}
